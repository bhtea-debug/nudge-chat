import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNow, laneCounts, laneOf, LANE_ORDER, missingInErp, whyNow } from "../src/state/lanes.js";
import { createIssueCapabilities } from "../src/state/capabilities.js";
import { CopilotStore } from "../src/state/store.js";
import { buildTimeline, lastIncoming, sourceSummary } from "../src/state/timeline.js";
import { matchIssue } from "../src/state/correlate.js";
import { chatMessageId, ingestChatMessage, messageFromWebhook, verifySignature } from "../src/connecteam/ingest.js";
import type { ConnecteamSourceRef, Issue, MailSourceRef } from "../src/state/types.js";

/**
 * Grupowanie spraw i to, co Claude dostaje do prezentacji.
 *
 * Ten plik zastąpił testy usuniętego interfejsu. Pytanie się nie zmieniło —
 * **czy właściciel to zobaczy** — zmieniło się tylko to, kto rysuje widok.
 * Sprawa bez grupy jest dziś dokładnie tak samo niewidoczna jak wtedy, gdy
 * wypadała ze wszystkich sekcji strony.
 */

const mailRef = (over: Partial<MailSourceRef> = {}): MailSourceRef => ({
  kind: "mail",
  messageId: "<a@rossmann.example>",
  threadId: "<a@rossmann.example>",
  folder: "INBOX",
  date: "2026-08-18T09:14:00.000Z",
  subject: "Zamówienie 2307348 — termin",
  from: "zakupy@rossmann.example",
  ...over,
});

const chatRef = (over: Partial<ConnecteamSourceRef> = {}): ConnecteamSourceRef => ({
  kind: "connecteam",
  messageId: "ct:produkcja:m1",
  conversationId: "produkcja",
  conversationName: "Produkcja",
  date: "2026-08-18T09:32:00.000Z",
  authorName: "Ania",
  preview: "nie mamy etykiet do tego Rossmanna",
  ...over,
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "spr_1",
  createdAt: "2026-08-18T09:14:00.000Z",
  updatedAt: "2026-08-18T09:14:00.000Z",
  source: "mail",
  sourceRefs: [mailRef()],
  title: "Rossmann — zamówienie 2307348",
  summary: "Klient pyta o realizację zamówienia.",
  category: "reply",
  priority: "normal",
  status: "new",
  classifier: "deterministic",
  whyListed: "w wiadomości jest numer zamówienia 2307348",
  likelyIrrelevant: false,
  relatedOrderRefs: ["2307348"],
  relatedProductRefs: [],
  lastEvidenceAt: null,
  lastErpSummary: null,
  waitingFor: null,
  lastPresentedAt: null,
  notificationCandidate: false,
  notificationReason: null,
  history: [],
  ...over,
});

const store = (): CopilotStore =>
  new CopilotStore({ dir: mkdtempSync(join(tmpdir(), "bht-lane-")), actor: "operator" });

// ── grupowanie ────────────────────────────────────────────────────────────────

describe("grupowanie spraw", () => {
  it("KAŻDA sprawa dostaje grupę — także kategoria, której dziś nie przewidujemy", () => {
    // Sprawa bez grupy byłaby sprawą, której właściciel nigdzie nie zobaczy.
    const wszystkie = [
      issue({ id: "a", category: "reply" }),
      issue({ id: "b", category: "monitor" }),
      issue({ id: "c", category: "informational" }),
      issue({ id: "d", category: "urgent", priority: "high" }),
      issue({ id: "e", category: "decision" }),
      issue({ id: "f", status: "waiting_for_owner" }),
      issue({ id: "g", likelyIrrelevant: true }),
      issue({ id: "h", status: "waiting_external" }),
      issue({ id: "i", status: "probably_resolved" }),
    ];
    for (const i of wszystkie) {
      expect(LANE_ORDER).toContain(laneOf(i));
    }
    const counts = laneCounts(wszystkie);
    const suma = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(suma).toBe(wszystkie.length);
  });

  it("numer, którego nie ma w TeaBrew, trafia do TERAZ", () => {
    const brak = issue({ lastErpSummary: "zamówienia 2307348 NIE MA w TeaBrew" });
    expect(missingInErp(brak)).toBe(true);
    expect(isNow(brak)).toBe(true);
    expect(laneOf(brak)).toBe("teraz");
  });

  it("stare „nie ma w TeaBrew” NIE trzyma sprawy na szczycie bez aktualnego numeru", () => {
    // Zdarzyło się naprawdę: awizo InPostu z 24-cyfrowym numerem przesyłki
    // i NIP-em w temacie wylądowało jako najpilniejsza sprawa w firmie —
    // długo po tym, jak oba te fałszywe alarmy naprawiono w order-refs.
    // Zdanie zapisane przez starszą wersję nikogo już nie obchodzi, ale nic
    // go nie unieważniało, więc sprawa siedziała w TERAZ bez końca.
    // DOKŁADNIE ten przypadek z prawdziwej skrzynki. Uwaga na NIP: dziesięć
    // cyfr to poprawny KSZTAŁT naszego numeru zamówienia, więc kontrola samego
    // kształtu zapisanych numerów tego nie łapie — i pierwsza wersja poprawki
    // faktycznie nie zadziałała. Odrzuca to dopiero ponowne rozpoznanie.
    const przeterminowana = issue({
      title: "Wsparcie Handlowe — NIP: 8842745578 / 521000014358100142097412",
      summary:
        "Dzień dobry, przesyłka 521000014358100142097412 jest przesyłką niezgodną " +
        "z regulaminem InPost. Proszę o odebranie przesyłki z oddziału.",
      lastErpSummary: "zamówienia 8842745578 NIE MA w TeaBrew",
      relatedOrderRefs: ["8842745578", "521000014358100142097412"],
    });
    expect(przeterminowana.relatedOrderRefs.some((r) => /^\d{4,12}$/.test(r))).toBe(true);
    expect(missingInErp(przeterminowana)).toBe(false);
    expect(laneOf(przeterminowana)).not.toBe("teraz");

    // Ale prawdziwy numer naszego kształtu nadal windują na górę.
    const prawdziwa = issue({
      lastErpSummary: "zamówienia 2307411 NIE MA w TeaBrew",
      relatedOrderRefs: ["2307411"],
    });
    expect(missingInErp(prawdziwa)).toBe(true);
    expect(laneOf(prawdziwa)).toBe("teraz");
  });

  it("wysyłka masowa NIE wchodzi do TERAZ, nawet z wysokim priorytetem", () => {
    const szum = issue({ likelyIrrelevant: true, priority: "high" });
    expect(isNow(szum)).toBe(false);
    expect(laneOf(szum)).toBe("prawdopodobnie_nieistotne");
  });

  it("oznaczenie właściciela przenosi sprawę do DECYZJI", () => {
    expect(laneOf(issue({ status: "waiting_for_owner" }))).toBe("decyzje");
  });

  it("TERAZ ma pierwszeństwo nad DECYZJAMI", () => {
    // Sprawa oznaczona jako decyzja, ale z numerem nieznanym TeaBrew, jest
    // pilniejsza niż ta, którą właściciel świadomie odłożył.
    const oba = issue({ status: "waiting_for_owner", lastErpSummary: "NIE MA w TeaBrew" });
    expect(laneOf(oba)).toBe("teraz");
  });
});

// ── co dostaje Claude ─────────────────────────────────────────────────────────

describe("dane dla Claude", () => {
  const brief = async (i: Issue) => {
    const s = store();
    const created = s.createIssue({
      title: i.title,
      summary: i.summary,
      category: i.category,
      priority: i.priority,
      status: i.status,
      whyListed: i.whyListed,
      likelyIrrelevant: i.likelyIrrelevant,
      ref: i.sourceRefs[0]!,
      relatedOrderRefs: i.relatedOrderRefs,
      ...(i.waitingFor !== null ? { waitingFor: i.waitingFor } : {}),
    });
    if (i.lastErpSummary) {
      s.patchIssue(created.id, { lastErpSummary: i.lastErpSummary }, "TeaBrew");
    }
    const caps = createIssueCapabilities(() => s);
    const open = caps.find((c) => c.name === "copilot_get_open_issues")!;
    const out = (await open.handler({ limit: 50 } as never, {} as never)) as {
      issues: { lane: string; neededFromOwner: string | null; sources: string[]; missingInErp: boolean }[];
      byLane: Record<string, number>;
      laneOrder: string[];
    };
    return out;
  };

  it("niesie grupę, powód i to, czego potrzeba od właściciela", async () => {
    const out = await brief(issue({ lastErpSummary: "zamówienia 2307348 NIE MA w TeaBrew" }));
    expect(out.issues[0]!.lane).toBe("teraz");
    expect(out.issues[0]!.missingInErp).toBe(true);
    expect(out.issues[0]!.neededFromOwner).toContain("2307348");
    expect(out.laneOrder[0]).toBe("teraz");
    expect(out.byLane["teraz"]).toBe(1);
  });

  it("„czego potrzeba od właściciela” jest PUSTE, gdy nie wiadomo", async () => {
    // Wypełnienie tego zdaniem „przejrzyj sprawę" byłoby zadaniem wymyślonym
    // przez system — po tygodniu właściciel przestałby czytać całą kolumnę.
    const out = await brief(issue({ category: "monitor", waitingFor: "odpowiedzieliśmy — ruch po drugiej stronie" }));
    expect(out.issues[0]!.neededFromOwner).toBeNull();
  });

  it("mówi, z których systemów pochodzą dowody", async () => {
    const out = await brief(issue());
    expect(out.issues[0]!.sources).toEqual(["mail"]);
  });
});

// ── sprawy zapisane starszą wersją schematu ──────────────────────────────────

describe("sprawy z dziennika sprzed zmian schematu", () => {
  /** Zapisuje dziennik dokładnie w kształcie sprzed dodania whyListed. */
  const zStarymDziennikiem = (): CopilotStore => {
    const dir = mkdtempSync(join(tmpdir(), "bht-legacy-"));
    const stara = {
      t: "issue_created",
      at: "2026-08-17T10:00:00.000Z",
      issue: {
        id: "spr_f8b6d443",
        createdAt: "2026-08-17T10:00:00.000Z",
        updatedAt: "2026-08-17T10:00:00.000Z",
        source: "mail",
        sourceRefs: [mailRef()],
        title: "Wsparcie Handlowe — NIP: 8842745578",
        summary: "awizo",
        category: "reply",
        priority: "high",
        status: "new",
        relatedOrderRefs: ["8842745578"],
        relatedProductRefs: [],
        lastEvidenceAt: null,
        lastErpSummary: "numeru 8842745578 NIE MA w TeaBrew",
        waitingFor: null,
        lastPresentedAt: null,
        notificationCandidate: true,
        notificationReason: "…",
        history: [],
        // BRAK: classifier, whyListed, likelyIrrelevant — dodane później.
      },
    };
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(stara)}\n`);
    return new CopilotStore({ dir, actor: "operator" });
  };

  it("wyjście capability PRZECHODZI walidację, mimo brakujących pól w dzienniku", async () => {
    // Wyjście jest sprawdzane zodem, a `whyListed` jest wymaganym łańcuchem.
    // Sprawa sprzed dodania tego pola wywracała `copilot_get_open_issues`
    // błędem invalid_output — czyli Claude nie mógł wypisać ANI JEDNEJ sprawy,
    // bo jedna stara pozycja psuła całą odpowiedź.
    const caps = createIssueCapabilities(zStarymDziennikiem);
    const open = caps.find((c) => c.name === "copilot_get_open_issues")!;
    const out = await open.handler({ limit: 50 } as never, {} as never);
    const wynik = open.output.safeParse(out);
    expect(wynik.success).toBe(true);
  });

  it("brakujące pola dostają wartości domyślne, nie undefined", () => {
    const i = zStarymDziennikiem().get("spr_f8b6d443")!;
    expect(i.whyListed).toBe("");
    expect(i.likelyIrrelevant).toBe(false);
    expect(i.classifier).toBe("deterministic");
  });

  it("unieważnione twierdzenie ERP nie trzyma sprawy na górze przez priorytet", () => {
    // Cały przebieg ustawił naraz: lastErpSummary, priority=high
    // i notificationCandidate. Odebranie wiary jednemu polu nic nie dawało.
    const i = zStarymDziennikiem().get("spr_f8b6d443")!;
    expect(missingInErp(i)).toBe(false);
    expect(whyNow(i)).toBeNull();
    expect(laneOf(i)).not.toBe("teraz");
  });
});

// ── jedna sprawa, wiele źródeł ────────────────────────────────────────────────

describe("jedna sprawa, wiele źródeł", () => {
  const wiadomosc = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    conversationId: "produkcja",
    conversationName: "Produkcja",
    at: "2026-08-18T09:32:00.000Z",
    authorName: "Ania",
    text: "nie mamy etykiet do zamówienia 2307348",
    ...over,
  });

  const zSprawa = (s: CopilotStore) =>
    s.createIssue({
      title: "Rossmann — 2307348",
      summary: "Klient pyta o termin.",
      category: "reply",
      priority: "normal",
      status: "new",
      ref: mailRef(),
      relatedOrderRefs: ["2307348"],
    });

  it("wiadomość z Connecteam o numerze zamówienia DOŁĄCZA do sprawy z maila", () => {
    const s = store();
    const spr = zSprawa(s);
    const out = ingestChatMessage(s, wiadomosc());
    expect(out.outcome).toBe("merged");
    expect(out.issueId).toBe(spr.id);
    expect(s.get(spr.id)!.sourceRefs).toHaveLength(2);
    expect(sourceSummary(s.get(spr.id)!)).toContain("Connecteam");
  });

  it("ten sam webhook dwa razy nie tworzy drugiej sprawy", () => {
    const s = store();
    expect(ingestChatMessage(s, wiadomosc()).outcome).toBe("created");
    expect(ingestChatMessage(s, wiadomosc()).outcome).toBe("duplicate");
    expect(s.all()).toHaveLength(1);
  });

  it("numer wskazujący DWIE sprawy nie scala — duplikat jest mniej groźny", () => {
    const s = store();
    for (const id of ["<x@a.example>", "<y@b.example>"]) {
      s.createIssue({
        title: `sprawa ${id}`,
        summary: "",
        category: "reply",
        priority: "normal",
        status: "new",
        ref: mailRef({ messageId: id, threadId: id }),
        relatedOrderRefs: ["2307348"],
      });
    }
    expect(ingestChatMessage(s, wiadomosc()).outcome).toBe("created");
    expect(s.all()).toHaveLength(3);
  });

  it("konwersacja czatu nie scala się z wątkiem poczty o tym samym identyfikatorze", () => {
    const mailowa = issue({ sourceRefs: [mailRef({ threadId: "zbieznosc" })] });
    const wynik = matchIssue([mailowa], {
      ref: chatRef({ conversationId: "zbieznosc", messageId: "ct:zbieznosc:9" }),
      parentIds: [],
      orderRefs: [],
    });
    expect(wynik.confidence).toBe("none");
  });

  it("identyfikator czatu jest prefiksowany — kolizja z Message-ID niemożliwa", () => {
    expect(chatMessageId("produkcja", "m1")).toBe("ct:produkcja:m1");
  });

  it("usunięcie wiadomości u źródła nie wymazuje sprawy", () => {
    const s = store();
    const created = ingestChatMessage(s, wiadomosc());
    expect(ingestChatMessage(s, wiadomosc({ id: "m2" }), "message_deleted").outcome).toBe("ignored");
    expect(s.get(created.issueId!)).not.toBeNull();
  });

  it("brak treści u dostawcy mówi to wprost", () => {
    const s = store();
    const out = ingestChatMessage(s, wiadomosc({ text: "" }));
    expect(s.get(out.issueId!)!.summary).toContain("nie przekazał treści");
  });
});

describe("chronologia źródeł", () => {
  it("zszywa mail, Connecteam i TeaBrew w jeden ciąg po czasie", () => {
    const i = issue({
      sourceRefs: [mailRef(), chatRef()],
      lastEvidenceAt: "2026-08-18T09:35:00.000Z",
      lastErpSummary: "2307348: produkcja w toku",
    });
    const os = buildTimeline(i);
    expect(os.map((e) => e.source)).toEqual(["E-mail", "Connecteam · Produkcja", "TeaBrew"]);
    expect(os.map((e) => e.at)).toEqual([...os.map((e) => e.at)].sort());
  });

  it("„co przyszło ostatnio” to komunikacja, NIE nasz odczyt z TeaBrew", () => {
    const os = buildTimeline(
      issue({
        sourceRefs: [mailRef()],
        lastEvidenceAt: "2026-08-18T23:00:00.000Z",
        lastErpSummary: "zamówienia 2307348 NIE MA w TeaBrew",
      }),
    );
    expect(os.at(-1)!.source).toBe("TeaBrew");
    expect(lastIncoming(os)!.source).toBe("E-mail");
  });

  it("NIE wstawia „odpowiedzieliśmy”, bo nie zna godziny odpowiedzi", () => {
    const os = buildTimeline(issue({ waitingFor: "odpowiedzieliśmy — ruch po drugiej stronie" }));
    expect(os.some((e) => /odpowiedzieliśmy/i.test(e.what))).toBe(false);
  });
});

describe("webhook Connecteam", () => {
  it("czyta zagnieżdżone `data` i znacznik uniksowy", () => {
    const out = messageFromWebhook({
      eventType: "message_created",
      data: { id: 77, chatId: "kanal", timestamp: 1_755_500_000, text: "cześć", senderName: "Ania" },
    });
    expect("error" in out).toBe(false);
  });

  it("odrzuca ładunek bez czasu, zamiast wstawiać „teraz”", () => {
    expect("error" in messageFromWebhook({ data: { id: "1", conversationId: "k" } })).toBe(true);
  });

  it("brak sekretu daje `null`, nie `true`", () => {
    expect(verifySignature("{}", null, null)).toBeNull();
    expect(verifySignature("{}", null, "sekret")).toBe(false);
  });
});
