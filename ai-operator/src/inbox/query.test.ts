import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "./contract.js";
import { recordFailure, recordSuccess } from "./health.js";
import { queryCase, queryQueue } from "./query.js";
import { InboxStore, type StoredCase } from "./store.js";

/**
 * Stronicowanie kolejki.
 *
 * Powód istnienia: odbiorca brał 300 rekordów i raportował widok jako pełny.
 * Firma z czterystoma sprawami widziała trzysta i nie miała jak się dowiedzieć,
 * że setka zniknęła.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-query-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Sprawa numer `index`: im wyższy numer, tym starsza — czyli tym niżej listy. */
function caseRecord(index: number, overrides: Partial<StoredCase> = {}): StoredCase {
  return {
    caseId: `ic_${String(index).padStart(4, "0")}`,
    provider: "email",
    accountKey: "sklep",
    externalConversationId: `conv-${index}`,
    subject: null,
    participantLabel: null,
    orderRef: null,
    firstSeenAt: NOW - index * 1_000,
    lastMessageAt: NOW - index * 1_000,
    lastIncomingMessageId: `mid:${index}`,
    lastIncomingAt: NOW - index * 1_000,
    messageCount: 1,
    requiresResponse: true,
    pendingAction: false,
    classifierVersion: CLASSIFIER_VERSION,
    classificationReason: "customer_message",
    needsReview: false,
    sourceClosed: false,
    hasAttachments: false,
    ...overrides,
  };
}

function seed(store: InboxStore, count: number): void {
  for (let index = 0; index < count; index += 1) store.upsertCase(caseRecord(index));
}

/** Wysiew wybranych numerów: magazyn nie umie kasować, więc brak sprawy w kolejce odwzorowujemy brakiem w wysiewie. */
function seedOnly(store: InboxStore, indices: readonly number[]): void {
  for (const index of indices) store.upsertCase(caseRecord(index));
}

function indexOfCase(caseId: string): number {
  return Number(caseId.slice("ic_".length));
}

interface DrainOptions {
  readonly cursor?: string | null;
  readonly state?: "actionable" | "all";
  readonly maxPages?: number;
}

function drain(
  store: InboxStore,
  pageSize: number,
  options: DrainOptions = {},
): { ids: string[]; pages: number } {
  const state = options.state ?? "all";
  const maxPages = options.maxPages ?? 50;
  const ids: string[] = [];
  let cursor: string | null = options.cursor ?? null;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const page = queryQueue(store, { now: NOW, state, limit: pageSize, cursor });
    ids.push(...page.cases.map((entry) => entry.caseId));
    if (!page.truncated) {
      pages += 1;
      break;
    }
    expect(page.nextCursor).toBeTruthy();
    cursor = page.nextCursor;
  }
  return { ids, pages };
}

describe("stronicowanie kolejki", () => {
  it("ponad 300 spraw przechodzi w całości, bez luk i duplikatów", () => {
    const store = freshStore();
    seed(store, 437);

    const { ids } = drain(store, 200);
    expect(ids).toHaveLength(437);
    expect(new Set(ids).size).toBe(437);
  });

  it("601 spraw: KAZDA jest osiagalna, bez luk, duplikatow i 404", () => {
    const store = freshStore();
    // Prog z handoffu. Wybrany tak, zeby przekroczyc jednoczesnie limit widoku
    // (3 strony po 200) i twardy sufit jednego odczytu (500).
    seed(store, 601);

    const { ids } = drain(store, 200);
    expect(ids).toHaveLength(601);
    expect(new Set(ids).size).toBe(601);

    // Kazda z nich daje sie tez OTWORZYC pojedynczo, a nie tylko przewinac.
    for (const caseId of ids) {
      expect(queryCase(store, caseId, NOW)?.case.caseId).toBe(caseId);
    }
  });

  it("przerwanie stronicowania zostawia JAWNY sygnal, a nie ucieta calosc", () => {
    const store = freshStore();
    seed(store, 601);

    /*
     * Widok ma sufit stron. Symulujemy dokladnie to, co robi interfejs:
     * bierze trzy strony i przestaje. Wynik NIE MOZE wygladac jak komplet.
     */
    const collected: string[] = [];
    let cursor: string | null = null;
    let lastPage = queryQueue(store, { now: NOW, state: "all", limit: 200 });
    for (let page = 0; page < 3; page += 1) {
      collected.push(...lastPage.cases.map((entry) => entry.caseId));
      cursor = lastPage.nextCursor;
      if (!lastPage.truncated || !cursor) break;
      if (page < 2) lastPage = queryQueue(store, { now: NOW, state: "all", limit: 200, cursor });
    }

    expect(collected).toHaveLength(600);
    // Kolejka ZNA swoj prawdziwy rozmiar, wiec widok ma czym powiedziec
    // „pokazuje 600 z 601", zamiast milczec.
    expect(lastPage.count).toBe(601);
    expect(lastPage.truncated).toBe(true);
    expect(lastPage.nextCursor).toBeTruthy();

    // Sprawa, ktora nie zmiescila sie w suficie, nadal daje sie otworzyc
    // bezposrednio: obciecie dotyczy WIDOKU, nie dostepnosci.
    const missing = queryQueue(store, { now: NOW, state: "all", limit: 200, cursor })
      .cases[0]!.caseId;
    expect(collected).not.toContain(missing);
    expect(queryCase(store, missing, NOW)?.case.caseId).toBe(missing);
  });

  it("pierwsza strona jawnie mówi, że nie jest całością", () => {
    const store = freshStore();
    seed(store, 437);

    const page = queryQueue(store, { now: NOW, state: "all", limit: 200 });
    expect(page.cases).toHaveLength(200);
    expect(page.count).toBe(437);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  });

  it("ostatnia strona zamyka listę kursorem null", () => {
    const store = freshStore();
    seed(store, 250);

    const first = queryQueue(store, { now: NOW, state: "all", limit: 200 });
    const second = queryQueue(store, {
      now: NOW,
      state: "all",
      limit: 200,
      cursor: first.nextCursor,
    });
    expect(second.cases).toHaveLength(50);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("sprawy o identycznym czasie nie gubią się między stronami", () => {
    const store = freshStore();
    for (let index = 0; index < 10; index += 1) {
      store.upsertCase({
        caseId: `ic_same_${index}`,
        provider: "email",
        accountKey: "sklep",
        externalConversationId: `conv-${index}`,
        subject: null,
        participantLabel: null,
        orderRef: null,
        firstSeenAt: NOW,
        // Ten sam czas dla wszystkich: bez całkowitego porządku kursor
        // przeskakiwałby rekordy.
        lastMessageAt: NOW,
        lastIncomingMessageId: `mid:${index}`,
        lastIncomingAt: NOW,
        messageCount: 1,
        requiresResponse: true,
        pendingAction: false,
        classifierVersion: CLASSIFIER_VERSION,
        classificationReason: "customer_message",
        needsReview: false,
        sourceClosed: false,
        hasAttachments: false,
      });
    }

    const { ids } = drain(store, 3);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("kursor wskazujacy nieistniejaca sprawe nadal wyznacza POZYCJE", () => {
    const store = freshStore();
    seed(store, 5);
    /*
     * Kursor niesie klucz porządku, nie wskaźnik na rekord. Sprawa o tym
     * identyfikatorze nigdy nie istniała, a mimo to wiadomo, gdzie jesteśmy:
     * czytamy wszystko ostro poniżej `NOW - 2000` w porządku kolejki.
     * „ic_0002zzz" jest w porządku alfabetycznym za „ic_0002", więc sama
     * sprawa ic_0002 (ten sam czas) zostaje POWYŻEJ kursora.
     */
    const page = queryQueue(store, {
      now: NOW,
      state: "all",
      limit: 10,
      cursor: Buffer.from(`${NOW - 2_000}|ic_0002zzz`, "utf8").toString("base64url"),
    });
    expect(page.cases.map((entry) => entry.caseId)).toEqual(["ic_0003", "ic_0004"]);
  });

  it("uszkodzony kursor czyta od poczatku zamiast wysadzac odczyt", () => {
    const store = freshStore();
    seed(store, 5);
    const uszkodzone = [
      "###nie-base64###",
      Buffer.from("bez-separatora", "utf8").toString("base64url"),
      // Kursor w starym, nieliczbowym kształcie: ma być odrzucony, nie policzony.
      Buffer.from("poczatek|ic_0001", "utf8").toString("base64url"),
      Buffer.from("|ic_0001", "utf8").toString("base64url"),
    ];
    for (const cursor of uszkodzone) {
      const page = queryQueue(store, { now: NOW, state: "all", limit: 10, cursor });
      expect(page.cases).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    }
  });

  it("sprawa, ktora przeskoczyla nad kursor, nie zabiera ze soba innych", () => {
    const store = freshStore();
    seed(store, 10);

    const first = queryQueue(store, { now: NOW, state: "all", limit: 4 });
    expect(first.cases.map((entry) => entry.caseId)).toEqual([
      "ic_0000",
      "ic_0001",
      "ic_0002",
      "ic_0003",
    ]);

    // ic_0008 leżała daleko pod kursorem i dostała nową wiadomość: ląduje na
    // czele listy, czyli nad kursorem. Wolno jej zniknąć z tego przewijania
    // (klient zobaczy ją przy odświeżeniu od góry) — reszcie nie wolno.
    store.upsertCase(caseRecord(8, { lastMessageAt: NOW + 5_000, lastIncomingAt: NOW + 5_000 }));

    const rest = drain(store, 4, { cursor: first.nextCursor });
    const widziane = [...first.cases.map((entry) => entry.caseId), ...rest.ids];

    for (const caseId of ["ic_0004", "ic_0005", "ic_0006", "ic_0007", "ic_0009"]) {
      expect(widziane).toContain(caseId);
    }
    expect(new Set(widziane).size).toBe(widziane.length);
  });

  it("zniknięcie rekordu kursora nie powtarza poprzedniej strony", () => {
    const store = freshStore();
    seedOnly(store, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const first = queryQueue(store, { now: NOW, state: "all", limit: 4 });
    expect(first.cases.map((entry) => entry.caseId)).toEqual([
      "ic_0000",
      "ic_0001",
      "ic_0002",
      "ic_0003",
    ]);

    // Sprawa z kursora znika z kolejki (scalenie wątków, czyszczenie źródła).
    const po = freshStore();
    seedOnly(po, [0, 1, 2, 4, 5, 6, 7, 8, 9]);

    const rest = drain(po, 4, { cursor: first.nextCursor });
    expect(rest.ids).toEqual(["ic_0004", "ic_0005", "ic_0006", "ic_0007", "ic_0008", "ic_0009"]);
  });

  it("nowa sprawa na czole listy nie robi luki w dalszej czesci", () => {
    const store = freshStore();
    seed(store, 10);

    const first = queryQueue(store, { now: NOW, state: "all", limit: 4 });

    // Świeże zgłoszenie: wchodzi nad kursor, więc nie należy do tego
    // przewijania. Nie wolno mu jednak przesunąć okna i zjeść ic_0004.
    store.upsertCase(
      caseRecord(99, { lastMessageAt: NOW + 10_000, lastIncomingAt: NOW + 10_000 }),
    );

    const rest = drain(store, 4, { cursor: first.nextCursor });
    expect(rest.ids).toEqual(["ic_0004", "ic_0005", "ic_0006", "ic_0007", "ic_0008", "ic_0009"]);
  });

  it('przy state="actionable" obsluzone sprawy nie zatrzymuja postepu', () => {
    const store = freshStore();
    seedOnly(store, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const zebrane: string[] = [];
    let cursor: string | null = null;
    let strony = 0;
    for (; strony < 20; strony += 1) {
      const page = queryQueue(store, { now: NOW, limit: 3, cursor });
      zebrane.push(...page.cases.map((entry) => entry.caseId));

      // Człowiek odpowiada na ostatnią sprawę strony: wypada ona z filtra
      // „do zrobienia", czyli rekord z kursora przestaje istnieć w widoku.
      const last = page.cases[page.cases.length - 1];
      if (last) {
        store.upsertCase(
          caseRecord(indexOfCase(last.caseId), {
            requiresResponse: false,
            pendingAction: false,
          }),
        );
      }

      if (!page.truncated) {
        strony += 1;
        break;
      }
      cursor = page.nextCursor;
    }

    // Postęp: cztery strony po trzy i koniec. Bez keyseta odczyt wracał na
    // początek i krążył po tych samych sprawach przy wiecznie prawdziwym
    // `truncated`.
    expect(strony).toBe(4);
    expect(zebrane).toHaveLength(12);
    expect(new Set(zebrane).size).toBe(12);
  });

  it("kompletność widoku zależy od zdrowia źródeł, nie od liczby rekordów", () => {
    const store = freshStore();
    seed(store, 3);
    recordSuccess(
      store,
      { key: { provider: "email", accountKey: "sklep" }, label: "sklep", active: true },
      NOW,
    );
    expect(queryQueue(store, { now: NOW, state: "all" }).completeView).toBe(true);

    recordFailure(
      store,
      { key: { provider: "email", accountKey: "biuro" }, label: "biuro", active: true },
      "error",
      "polaczenie odrzucone",
      NOW,
    );
    expect(queryQueue(store, { now: NOW, state: "all" }).completeView).toBe(false);
  });
});

/**
 * Odczyt pojedynczej sprawy.
 *
 * Poprzednia droga budowała stronę pięciuset spraw i szukała w niej jednej.
 * Sprawa spoza tej strony — starsza albo zepchnięta świeższym ruchem — nie
 * dawała się otworzyć mimo że siedziała w magazynie. Kolejka rośnie, więc to
 * była usterka z odroczonym zapłonem: działała, dopóki firma była mała.
 */
describe("odczyt pojedynczej sprawy", () => {
  it("otwiera sprawe POZA pierwsza strona kolejki", () => {
    const store = freshStore();
    seed(store, 640);

    // Sprawa numer 600 jest daleko poza oknem 500 rekordów.
    const far = queryCase(store, "ic_0600", NOW);
    expect(far?.case.caseId).toBe("ic_0600");

    // Kontrola: ta sama sprawa faktycznie nie mieści się na pierwszej stronie.
    const page = queryQueue(store, { now: NOW, state: "all", limit: 500 });
    expect(page.cases.some((entry) => entry.caseId === "ic_0600")).toBe(false);
  });

  it("nieistniejaca sprawa to null, nie pusty rekord", () => {
    const store = freshStore();
    seed(store, 3);
    expect(queryCase(store, "ic_9999", NOW)).toBeNull();
  });

  it("bez trybu tresci nie oddaje podgladu wiadomosci", () => {
    const store = freshStore();
    seed(store, 1);
    const found = queryCase(store, "ic_0000", NOW);
    expect(found?.case.preview ?? null).toBeNull();
  });
});
