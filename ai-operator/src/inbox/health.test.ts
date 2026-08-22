import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSourceHealth } from "./providers/allegro/adapter.js";
import {
  DEFAULT_TICK_INTERVAL_MS,
  RECONCILE_EVERY_TICKS,
  type InboxConfig,
} from "./config.js";
import {
  FRESHNESS_POLICY,
  INBOX_HEALTH_CONTRACT_VERSION,
  normalizeSourceState,
  overallFreshness,
  type SourceHealth,
} from "./contract.js";
import {
  backoffDelay,
  channelFreshness,
  lastInboundReceiptAt,
  mayReportEmptyQueue,
  recordFailure,
  recordInboundReceipt,
  RECONCILE_OVERDUE_MS,
  reconcileOverdueMsFor,
  recordSuccess,
  sanitizeMessage,
} from "./health.js";
import { fetchConversations } from "./providers/meta/graph.js";
import { createRuntime } from "./runtime.js";
import { InboxStore } from "./store.js";

/*
 * Graph API jest zamockowane w CALYM pliku: test kadencji ma mierzyc, KIEDY
 * petla siega po uzgodnienie, a nie to, czy jest siec.
 */
vi.mock("./providers/meta/graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/meta/graph.js")>();
  return { ...actual, fetchConversations: vi.fn() };
});

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-health-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const source = (partial: Partial<SourceHealth>): SourceHealth => ({
  provider: "email",
  accountKey: "sklep",
  label: "E-mail sklep",
  state: "ok",
  active: true,
  lastSuccessfulSyncAt: NOW - 60_000,
  lastAttemptAt: NOW - 60_000,
  nextAttemptAt: null,
  consecutiveFailures: 0,
  message: null,
  ...partial,
});

describe("swiezosc kanalu", () => {
  it("ogolny czas bierze NAJSTARSZY sukces aktywnego zrodla", () => {
    const result = overallFreshness(
      [
        source({ accountKey: "sklep", lastSuccessfulSyncAt: NOW - 30_000 }),
        source({ accountKey: "biuro", lastSuccessfulSyncAt: NOW - 9 * 60_000 }),
        source({ accountKey: "hurt", lastSuccessfulSyncAt: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(result.oldestSuccessAt).toBe(NOW - 9 * 60_000);
    expect(result.ageMs).toBe(9 * 60_000);
    expect(result.state).toBe("yellow");
  });

  it("jedno martwe zrodlo nie daje zielonego statusu", () => {
    const result = overallFreshness(
      [
        source({ accountKey: "sklep", lastSuccessfulSyncAt: NOW - 10_000 }),
        source({
          provider: "instagram",
          accountKey: "ig-1",
          state: "reconnect_required",
          lastSuccessfulSyncAt: NOW - 20_000,
        }),
      ],
      NOW,
    );
    expect(result.state).toBe("red");
    expect(result.degradedSources).toContain("instagram:ig-1");
  });

  it("zrodlo bez ani jednego sukcesu jest czerwone", () => {
    const result = overallFreshness([source({ lastSuccessfulSyncAt: null })], NOW);
    expect(result.state).toBe("red");
    expect(result.oldestSuccessAt).toBeNull();
  });

  it("nieaktywne zrodlo nie psuje ogolnego stanu", () => {
    const result = overallFreshness(
      [
        source({ lastSuccessfulSyncAt: NOW - 10_000 }),
        source({ provider: "facebook", accountKey: "fb-1", active: false, lastSuccessfulSyncAt: null }),
      ],
      NOW,
    );
    expect(result.state).toBe("green");
  });

  it("stale przelacza sie z uplywem czasu bez kolejnego zapisu serwera", () => {
    const sources = [source({ lastSuccessfulSyncAt: NOW })];
    expect(overallFreshness(sources, NOW + 60_000).state).toBe("green");
    expect(overallFreshness(sources, NOW + FRESHNESS_POLICY.okMs + 1).state).toBe("yellow");
    expect(overallFreshness(sources, NOW + FRESHNESS_POLICY.alarmMs + 1).state).toBe("red");
  });

  it("blad z pusta lista nie pozwala pokazac braku spraw", () => {
    const store = freshStore();
    recordSuccess(store, { key: { provider: "email", accountKey: "sklep" }, label: "sklep", active: true }, NOW);
    recordFailure(
      store,
      { key: { provider: "email", accountKey: "biuro" }, label: "biuro", active: true },
      "error",
      "polaczenie odrzucone",
      NOW,
    );

    const freshness = channelFreshness(store, NOW);
    expect(freshness.state).toBe("red");
    expect(mayReportEmptyQueue(freshness)).toBe(false);
  });

  it("po odzyskaniu zrodla stan wraca do zielonego i licznik bledow zeruje sie", () => {
    const store = freshStore();
    const key = { provider: "email", accountKey: "hurt" };
    recordFailure(store, { key, label: "hurt", active: true }, "error", "timeout", NOW);
    recordFailure(store, { key, label: "hurt", active: true }, "error", "timeout", NOW + 1_000);
    expect(store.getHealth(key)?.consecutiveFailures).toBe(2);
    expect(store.getHealth(key)?.state).toBe("backoff");

    recordSuccess(store, { key, label: "hurt", active: true }, NOW + 5_000);
    const health = store.getHealth(key)!;
    expect(health.state).toBe("ok");
    expect(health.consecutiveFailures).toBe(0);
    expect(mayReportEmptyQueue(channelFreshness(store, NOW + 5_000))).toBe(true);
  });

  it("awaria nie nadpisuje czasu ostatniego sukcesu", () => {
    const store = freshStore();
    const key = { provider: "email", accountKey: "sklep" };
    recordSuccess(store, { key, label: "sklep", active: true }, NOW);
    recordFailure(store, { key, label: "sklep", active: true }, "error", "zerwane polaczenie", NOW + 60_000);
    const health = store.getHealth(key)!;
    expect(health.lastSuccessfulSyncAt).toBe(NOW);
    expect(health.lastAttemptAt).toBe(NOW + 60_000);
  });

  it("backoff rosnie wykladniczo i ma sufit", () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(1)).toBe(60_000);
    expect(backoffDelay(2)).toBe(120_000);
    expect(backoffDelay(20)).toBe(15 * 60_000);
  });

  it("brak scope zostaje widoczny mimo kolejnych prob", () => {
    const store = freshStore();
    const key = { provider: "instagram", accountKey: "ig-1" };
    recordFailure(store, { key, label: "Instagram", active: true }, "missing_scope", "brak uprawnien", NOW);
    recordFailure(store, { key, label: "Instagram", active: true }, "missing_scope", "brak uprawnien", NOW + 1);
    expect(store.getHealth(key)?.state).toBe("missing_scope");
  });

  it("komunikat nie przecieka adresow, tokenow ani URLi", () => {
    expect(sanitizeMessage("blad dla klient@example.com")).toBe("blad dla [adres]");
    expect(sanitizeMessage("Bearer abc123 nie dziala")).toContain("[sekret]");
    expect(sanitizeMessage("zobacz https://api.example.com/x?token=1")).toBe("zobacz [adres]");
    expect(sanitizeMessage("x".repeat(500))).toHaveLength(200);
  });

  it("backoff NIE jest stanem zdrowym", () => {
    const result = overallFreshness(
      [source({ state: "backoff", lastSuccessfulSyncAt: NOW - 10_000 })],
      NOW,
    );
    // Zrodlo, ktore wlasnie nie odpowiedzialo i czeka na ponowienie, nie moze
    // swiecic na zielono: kropka mowilaby „mamy wszystko" wbrew temu, co wiemy.
    expect(result.state).toBe("red");
    expect(result.degradedSources).toHaveLength(1);
  });

  it("rate_limited tez jest zdegradowane", () => {
    const result = overallFreshness(
      [source({ state: "rate_limited", lastSuccessfulSyncAt: NOW - 10_000 })],
      NOW,
    );
    expect(result.state).toBe("red");
  });

  it("konfiguracja BEZ aktywnych zrodel nie jest pusta kolejka", () => {
    const store = freshStore();
    // Zadnego zrodla: to brak kanalu, nie spokojny dzien.
    expect(mayReportEmptyQueue(channelFreshness(store, NOW))).toBe(false);

    recordSuccess(
      store,
      { key: { provider: "email", accountKey: "sklep" }, label: "sklep", active: false },
      NOW,
    );
    // Samo NIEAKTYWNE zrodlo tez nie wystarcza.
    expect(mayReportEmptyQueue(channelFreshness(store, NOW))).toBe(false);
  });

  it("zrodlo w backoffie zabrania komunikatu o pustej kolejce", () => {
    const store = freshStore();
    const key = { provider: "email", accountKey: "sklep" };
    recordSuccess(store, { key, label: "sklep", active: true }, NOW);
    expect(mayReportEmptyQueue(channelFreshness(store, NOW))).toBe(true);

    recordFailure(store, { key, label: "sklep", active: true }, "error", "timeout", NOW + 1);
    recordFailure(store, { key, label: "sklep", active: true }, "error", "timeout", NOW + 2);
    expect(store.getHealth(key)?.state).toBe("backoff");
    expect(mayReportEmptyQueue(channelFreshness(store, NOW + 2))).toBe(false);
  });
});

describe("odbior a uzgodnienie", () => {
  const META = { provider: "facebook", accountKey: "page-1" };
  const EMAIL = { provider: "email", accountKey: "sklep" };

  it("Meta z zywymi webhookami ANI RAZU nie wchodzi w alarm przez pelna godzine", () => {
    const store = freshStore();
    recordSuccess(store, { key: EMAIL, label: "sklep", active: true }, NOW);
    // Jedno udane uzgodnienie na starcie. Kolejne bylo by dopiero za godzine.
    recordSuccess(store, { key: META, label: "Facebook", active: true }, NOW);

    for (let minuta = 1; minuta <= 60; minuta += 1) {
      const at = NOW + minuta * 60_000;
      // Poczta synchronizuje sie co piec minut; Meta dostaje WYLACZNIE webhooki.
      if (minuta % 5 === 0) recordSuccess(store, { key: EMAIL, label: "sklep", active: true }, at);
      if (minuta % 3 === 0) {
        recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, at);
      }

      const freshness = channelFreshness(store, at);
      expect(freshness.state, `minuta ${minuta}`).not.toBe("red");
      expect(freshness.degradedSources, `minuta ${minuta}`).toHaveLength(0);
      // Odbior nie udaje uzgodnienia: jedzie w OSOBNYM polu przy zrodle.
      const meta = freshness.sources.find((entry) => entry.source === "facebook:page-1")!;
      expect(meta.lastReceiptAt !== null, `minuta ${minuta}`).toBe(minuta >= 3);
      expect(meta.lastReconciledAt, `minuta ${minuta}`).toBe(NOW);
    }
  });

  it("brak uzgodnienia mimo webhookow jest OSOBNYM, jawnym stanem", () => {
    const store = freshStore();
    recordSuccess(store, { key: EMAIL, label: "sklep", active: true }, NOW);
    recordSuccess(store, { key: META, label: "Facebook", active: true }, NOW);

    const godzina = NOW + 60 * 60_000;
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, godzina);
    // Po godzinie uzgodnienie jeszcze nie jest zalegle: taka jest kadencja.
    expect(channelFreshness(store, godzina).reconcileOverdue).not.toContain("facebook:page-1");

    const dwieGodziny = NOW + 120 * 60_000;
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, dwieGodziny);
    const freshness = channelFreshness(store, dwieGodziny);
    // Webhooki plyna, wiec ODBIOR jest swiezy...
    expect(freshness.sources.find((entry) => entry.source === "facebook:page-1")?.lastReceiptAt).toBe(
      dwieGodziny,
    );
    // ...ale KOMPLETNOSCI nikt nie potwierdzil i to musi byc widac.
    expect(freshness.reconcileOverdue).toContain("facebook:page-1");
  });

  it("webhook NIE zamalowuje bledu uzgodnienia", () => {
    const store = freshStore();
    recordSuccess(store, { key: EMAIL, label: "sklep", active: true }, NOW);
    recordFailure(store, { key: META, label: "Facebook", active: true }, "reconnect_required", "token wygasl", NOW);
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, NOW + 1_000);

    const freshness = channelFreshness(store, NOW + 2_000);
    // Zerwane uprawnienia zostaja czerwone: odbior mowi o kanale, nie o bledzie.
    expect(freshness.state).toBe("red");
    expect(freshness.degradedSources).toContain("facebook:page-1");
  });

  it("znacznik odbioru nie liczy sie jako samodzielne zrodlo", () => {
    const store = freshStore();
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, NOW);
    // Sam znacznik nie robi z kanalu spokojnego dnia: aktywnych zrodel brak.
    expect(mayReportEmptyQueue(channelFreshness(store, NOW))).toBe(false);
    expect(lastInboundReceiptAt(store, META)).toBe(NOW);
    expect(lastInboundReceiptAt(store, EMAIL)).toBeNull();
  });
});

describe("kadencja uzgodnien Meta w petli ticku", () => {
  const META = { provider: "facebook" as const, accountKey: "page-1" };
  const graph = vi.mocked(fetchConversations);

  beforeEach(() => {
    graph.mockReset();
  });

  function metaConfig(): InboxConfig {
    return {
      enabled: true,
      stateDir: "state",
      // Bez skrzynek pocztowych: ten test dotyczy WYLACZNIE bramki Meta i nie
      // ma prawa wyjsc na IMAP.
      email: [],
      meta: [
        { provider: "facebook", accountKey: "page-1", pageId: "page-1", label: "Facebook", accessToken: "t" },
      ],
      allegroEnabled: false,
      outbound: {
        resendApiKey: null,
        resendWebhookSecret: null,
        metaAppSecret: null,
        metaVerifyToken: null,
      },
      backfillDays: 30,
      tickFirstDelayMs: 100,
      tickIntervalMs: 5 * 60_000,
      backfillMode: "import",
      companyDomains: ["brownhouseandtea.pl"],
    };
  }

  const pusteUzgodnienie = {
    messages: [],
    pages: 1,
    truncated: false,
    truncatedConversations: false,
    truncatedMessages: [],
    newestUpdatedAt: null,
  };

  it("po nieudanej probie i wygasnieciu backoffu zwykly tick PONAWIA probe", async () => {
    const store = freshStore();
    const runtime = createRuntime(metaConfig(), store);

    // 1. Pierwszy tick: uzgodnienie sie udaje.
    graph.mockResolvedValueOnce(pusteUzgodnienie);
    await runtime.tick(NOW);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(store.getHealth(META)?.lastSuccessfulSyncAt).toBe(NOW);

    // 2. Po godzinie uzgodnienie jest nalezne i tym razem PADA.
    const zaGodzine = NOW + 60 * 60_000 + 1_000;
    graph.mockRejectedValueOnce(new Error("zerwane polaczenie"));
    await runtime.tick(zaGodzine);
    expect(graph).toHaveBeenCalledTimes(2);
    const poBledzie = store.getHealth(META)!;
    expect(poBledzie.consecutiveFailures).toBe(1);
    expect(poBledzie.nextAttemptAt).toBe(zaGodzine + 60_000);
    // Sukces sprzed godziny zostaje zapisany — i wlasnie o niego szlo.
    expect(poBledzie.lastSuccessfulSyncAt).toBe(NOW);

    // 3. Backoff jeszcze trwa: nie probujemy.
    graph.mockResolvedValue(pusteUzgodnienie);
    await runtime.tick(zaGodzine + 30_000);
    expect(graph).toHaveBeenCalledTimes(2);

    /*
     * 4. Backoff WYGASL. Zrodlo musi dostac ponowna probe w najblizszym
     *    zwyklym ticku. Bramka patrzaca tylko na „czy kiedykolwiek byl sukces"
     *    trzymala je uspione az do ticku uzgadniajacego, czyli do godziny.
     */
    await runtime.tick(zaGodzine + 90_000);
    expect(graph).toHaveBeenCalledTimes(3);
    expect(store.getHealth(META)?.consecutiveFailures).toBe(0);
  });

  it("udane i swieze uzgodnienie NIE jest powtarzane w kazdym ticku", async () => {
    const store = freshStore();
    const runtime = createRuntime(metaConfig(), store);

    graph.mockResolvedValue(pusteUzgodnienie);
    await runtime.tick(NOW);
    expect(graph).toHaveBeenCalledTimes(1);

    // Piec minut pozniej uzgodnienie jest wciaz swieze: Graph API kosztuje.
    await runtime.tick(NOW + 5 * 60_000);
    expect(graph).toHaveBeenCalledTimes(1);
  });
});


/**
 * Znacznik odbioru jest SZCZEGOLEM WEWNETRZNYM.
 *
 * Zapisujemy go jako wpis zdrowia, bo magazyn nie ma innego miejsca na taki
 * slad. To jest jednak decyzja implementacyjna, a nie element kontraktu:
 * odbiorca odpowiedzi zaklada z listy `sources` wiersze stanu i rysuje z nich
 * kafelki zrodel, wiec wyciek znacznika oznaczalby nieistniejace konto
 * „Facebook — odbior" w interfejsie obslugi klienta.
 */
describe("znacznik odbioru nie jest zrodlem", () => {
  it("NIE pojawia sie na liscie zrodel ani w reconcileOverdue", () => {
    const store = freshStore();
    const key = { provider: "facebook", accountKey: "page-1" };
    recordSuccess(store, { key, label: "Facebook", active: true }, NOW - 30 * 60_000);
    recordInboundReceipt(store, { key, label: "Facebook", active: true }, NOW);

    const freshness = channelFreshness(store, NOW);
    const klucze = freshness.sources.map((entry) => `${entry.provider}:${entry.accountKey}`);
    expect(klucze).toEqual(["facebook:page-1"]);
    expect(klucze.some((k) => k.includes("#receipt"))).toBe(false);
    expect(freshness.reconcileOverdue.some((k) => k.includes("#receipt"))).toBe(false);

    // ...ale sam czas odbioru JEST widoczny, w swoim wlasnym polu.
    expect(freshness.sources[0]!.lastReceiptAt).toBe(NOW);
    expect(freshness.lastReceiptAt).toBe(NOW);
  });
});

/**
 * Prog „uzgodnienie zaleglo" MUSI wynikac z kadencji, a nie stac obok niej.
 *
 * Kontrola po rundzie 3 zlapala dokladnie ten ksztalt bledu: okno pomijania
 * liczone z konfiguracji i prog wpisany z reki jako 90 minut. Obie liczby
 * wygladaly poprawnie i rozjechalyby sie przy pierwszej zmianie kadencji.
 */
describe("prog zaleglego uzgodnienia", () => {
  it("wynika z kadencji, a nie z wpisanej liczby", () => {
    expect(RECONCILE_OVERDUE_MS).toBe(Math.round(1.5 * RECONCILE_EVERY_TICKS * DEFAULT_TICK_INTERVAL_MS));
    // Kontrola zdrowego rozsadku: przy domyslnej kadencji to poltorej godziny.
    expect(RECONCILE_OVERDUE_MS).toBe(90 * 60_000);
  });
});

/**
 * JEDEN kontrakt zdrowia i kompletnosci (P0.4).
 *
 * Wczesniej byly dwie niezalezne prawdy: `mayReportEmptyQueue` patrzyla
 * wylacznie na stan zrodel, a `reconcileOverdue` zylo obok, jako pole
 * informacyjne. Kanal z zywymi webhookami i bez pelnego uzgodnienia od doby
 * spelnial pierwsza i lamal druga, wiec interfejs mogl napisac „brak spraw"
 * w chwili, gdy nikt nie potwierdzil, ze niczego nie brakuje.
 */
describe("kontrakt zdrowia i kompletnosci", () => {
  const META = { provider: "facebook", accountKey: "page-1" };
  const EMAIL = { provider: "email", accountKey: "sklep" };

  it("zywe webhooki przez pelna godzine NIE oglaszaja kompletnosci ani stalego alarmu", () => {
    const store = freshStore();
    // Ostatnie PELNE uzgodnienie dawno za progiem. Webhooki plyna dalej,
    // wiec ODBIOR jest swiezy i kropka nie ma powodu byc czerwona.
    recordSuccess(
      store,
      { key: META, label: "Facebook", active: true },
      NOW - RECONCILE_OVERDUE_MS - 60_000,
    );
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, NOW);

    for (let minuta = 0; minuta <= 60; minuta += 1) {
      const at = NOW + minuta * 60_000;
      if (minuta % 3 === 0) {
        recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, at);
      }
      const zdrowie = channelFreshness(store, at);
      // Bez stalego alarmu: alarm swiecacy zawsze przestaje byc alarmem.
      expect(zdrowie.state, `minuta ${minuta}`).not.toBe("red");
      expect(zdrowie.degradedSources, `minuta ${minuta}`).toHaveLength(0);
      // ...ale ANI RAZU nie wolno oglosic kompletnosci.
      expect(zdrowie.completeView, `minuta ${minuta}`).toBe(false);
      expect(mayReportEmptyQueue(zdrowie), `minuta ${minuta}`).toBe(false);
      expect(zdrowie.reconcileOverdue, `minuta ${minuta}`).toContain("facebook:page-1");
      expect(zdrowie.incompleteBecause, `minuta ${minuta}`).toContain("reconcile_overdue");
    }

    // Dopiero UDANE uzgodnienie przywraca kompletnosc.
    const koniec = NOW + 60 * 60_000;
    recordSuccess(store, { key: META, label: "Facebook", active: true }, koniec);
    const po = channelFreshness(store, koniec);
    expect(po.reconcileOverdue).toHaveLength(0);
    expect(po.completeView).toBe(true);
    expect(mayReportEmptyQueue(po)).toBe(true);
    expect(po.incompleteBecause).toHaveLength(0);
  });

  it("ODBIOR i UZGODNIENIE sa w DTO osobno, nie sklejone w jedno pole", () => {
    const store = freshStore();
    const uzgodnienie = NOW - 20 * 60_000;
    recordSuccess(store, { key: META, label: "Facebook", active: true }, uzgodnienie);
    recordInboundReceipt(store, { key: META, label: "Facebook", active: true }, NOW);

    const zdrowie = channelFreshness(store, NOW);
    expect(zdrowie.contractVersion).toBe(INBOX_HEALTH_CONTRACT_VERSION);
    const zrodlo = zdrowie.sources.find((entry) => entry.source === "facebook:page-1")!;
    expect(zrodlo.lastReconciledAt).toBe(uzgodnienie);
    expect(zrodlo.lastReceiptAt).toBe(NOW);
    expect(zdrowie.lastReceiptAt).toBe(NOW);
    expect(zdrowie.oldestReconciledAt).toBe(uzgodnienie);
  });

  it("tlumaczenie nazw stanu zyje w ADAPTERZE, a kontrakt tylko waliduje", () => {
    /*
     * Poprzednia wersja tego testu wpisywala do magazynu `state: "ready" as never`
     * i dowodzila, ze kontrakt to przetlumaczy. To byla asercja na stanie,
     * ktorego produkcja nie wytwarza: adapter Allegro tlumaczy `ready` na `ok`
     * ZANIM cokolwiek trafi do magazynu. Istnialy wiec dwie rownolegle tabele
     * tlumaczen dla jednej decyzji i zaczely sie rozjezdzac.
     *
     * Zostaje jedna, przy zrodle. Kontrakt pilnuje juz tylko tego, zeby nie
     * wszedl do niego stan spoza zbioru.
     */
    const przetlumaczone = toSourceHealth(
      {
        status: "ready",
        scopeState: "ready",
        lastSuccessfulSyncAt: NOW,
        nextAttemptAt: null,
        ageMs: 0,
        stale: false,
        message: null,
      },
      "sklep",
      "E-mail sklep",
      true,
    );
    expect(przetlumaczone.state).toBe("ok");

    // Kontrakt: znane stany przechodza, nieznane sa BLEDEM, nie cichym „ok".
    expect(normalizeSourceState("ok")).toBe("ok");
    expect(normalizeSourceState("rate_limited")).toBe("rate_limited");
    expect(normalizeSourceState("cokolwiek_nowego")).toBe("error");
    // Nazwa spoza kontraktu tez jest bledem: gdyby przemknela jako „ok",
    // zielona kropka klamalaby przy zrodle, ktorego nikt nie przetlumaczyl.
    expect(normalizeSourceState("ready")).toBe("error");
  });

  it("prog zaleglosci idzie z RZECZYWISTEJ kadencji, nie ze stalej", () => {
    expect(reconcileOverdueMsFor(DEFAULT_TICK_INTERVAL_MS)).toBe(RECONCILE_OVERDUE_MS);
    expect(reconcileOverdueMsFor(60_000)).toBe(18 * 60_000);

    const store = freshStore();
    recordSuccess(store, { key: EMAIL, label: "sklep", active: true }, NOW - 30 * 60_000);

    // Przy domyslnej kadencji (5 min) prog to 90 minut: jeszcze nie zaleglo.
    expect(channelFreshness(store, NOW).reconcileOverdue).toHaveLength(0);
    expect(channelFreshness(store, NOW).completeView).toBe(true);

    // Przy kadencji minutowej prog to 18 minut: to samo zrodlo JUZ zaleglo.
    const gestaKadencja = channelFreshness(store, NOW, {
      reconcileOverdueMs: reconcileOverdueMsFor(60_000),
    });
    expect(gestaKadencja.reconcileOverdue).toContain("email:sklep");
    expect(gestaKadencja.completeView).toBe(false);
    expect(gestaKadencja.reconcileOverdueMs).toBe(18 * 60_000);
  });

  it("zrodlo bez ANI JEDNEGO uzgodnienia nie moze oglosic kompletnosci", () => {
    const store = freshStore();
    store.setHealth({
      provider: "email",
      accountKey: "hurt",
      label: "E-mail hurt",
      state: "ok",
      active: true,
      lastSuccessfulSyncAt: null,
      lastAttemptAt: NOW,
      nextAttemptAt: null,
      consecutiveFailures: 0,
      message: null,
    });
    const zdrowie = channelFreshness(store, NOW);
    expect(zdrowie.reconcileOverdue).toContain("email:hurt");
    expect(zdrowie.completeView).toBe(false);
  });
});
