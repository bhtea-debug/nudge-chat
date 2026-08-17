import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CopilotStore } from "../src/state/store.js";
import { buildTimeline, lastIncoming, sourceSummary } from "../src/state/timeline.js";
import { matchIssue } from "../src/state/correlate.js";
import { assignLanes, headStatus, isNow } from "../src/ui/lanes.js";
import { renderCase, renderInbox, renderLogin, type SyncState } from "../src/ui/views.js";
import { LoginThrottle, UiAuth } from "../src/ui/auth.js";
import {
  chatMessageId,
  ingestChatMessage,
  messageFromWebhook,
  verifySignature,
} from "../src/connecteam/ingest.js";
import type { ConnecteamSourceRef, Issue, MailSourceRef } from "../src/state/types.js";

/**
 * Testy BHT Copilota — interfejsu, nie protokołu.
 *
 * Pytanie, na które ten plik odpowiada, jest inne niż w pozostałych testach:
 * nie „czy dane są poprawne", ale **„czy właściciel to zobaczy"**. Sprawa, która
 * wypadła ze wszystkich sekcji, jest technicznie w porządku i produktowo
 * katastrofalna, bo jest ukryta. Kilka testów tutaj pilnuje właśnie tego.
 */

const fresh = (): string => mkdtempSync(join(tmpdir(), "bht-ui-"));
const store = (): CopilotStore => new CopilotStore({ dir: fresh(), actor: "operator" });

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

const sync = (over: Partial<SyncState> = {}): SyncState => ({
  lastOkScanAt: new Date().toISOString(),
  checkpoints: [],
  integrityWarning: null,
  ...over,
});

// ── podział na sekcje ─────────────────────────────────────────────────────────

describe("sekcje ekranu głównego", () => {
  it("NIE GUBI żadnej sprawy — każda otwarta trafia dokładnie do jednej sekcji", () => {
    // To jest najważniejszy test w tym pliku. Sprawa, która wypadłaby ze
    // wszystkich sekcji, byłaby niewidoczna, a właściciel nie miałby jak się
    // dowiedzieć, że istnieje.
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
    const lanes = assignLanes(wszystkie);
    const rozdane = lanes.flatMap((l) => l.issues.map((i) => i.id));

    expect(rozdane.sort()).toEqual(wszystkie.map((i) => i.id).sort());
    // I ani jednej dwa razy — inaczej liczniki kłamią.
    expect(new Set(rozdane).size).toBe(rozdane.length);
  });

  it("zamknięte sprawy nie zaśmiecają żadnej sekcji", () => {
    const lanes = assignLanes([issue({ id: "z", status: "resolved" })]);
    expect(lanes.flatMap((l) => l.issues)).toHaveLength(0);
  });

  it("numer, którego nie ma w TeaBrew, ląduje w TERAZ", () => {
    const brak = issue({ lastErpSummary: "zamówienia 2307348 NIE MA w TeaBrew" });
    expect(isNow(brak)).toBe(true);
    const lanes = assignLanes([brak]);
    expect(lanes.find((l) => l.id === "teraz")?.issues).toHaveLength(1);
  });

  it("prawdopodobnie nieistotne NIE wchodzi do TERAZ, nawet z wysokim priorytetem", () => {
    // Inaczej jeden newsletter z natrętnym tematem zająłby najważniejsze
    // miejsce na ekranie.
    expect(isNow(issue({ likelyIrrelevant: true, priority: "high" }))).toBe(false);
  });

  it("oznaczenie „wymaga mojej decyzji” przenosi sprawę do DECYZJI", () => {
    const lanes = assignLanes([issue({ status: "waiting_for_owner" })]);
    expect(lanes.find((l) => l.id === "decyzje")?.issues).toHaveLength(1);
    expect(lanes.find((l) => l.id === "odpowiedzi")?.issues).toHaveLength(0);
  });
});

describe("liczniki nad listą", () => {
  it("liczą to samo, co delta dla Claude — sprawa pokazana i niezmieniona nie jest „zmianą”", () => {
    // Gdyby te dwa liczniki się rozjechały, właściciel dostałby dwie różne
    // prawdy o tym samym stanie: jedną na ekranie, drugą w rozmowie.
    const pokazana = issue({
      lastPresentedAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T09:14:00.000Z",
    });
    expect(headStatus([pokazana]).changed).toBe(0);

    const zmieniona = issue({
      lastPresentedAt: "2026-08-18T09:00:00.000Z",
      updatedAt: "2026-08-18T09:30:00.000Z",
    });
    expect(headStatus([zmieniona]).changed).toBe(1);
  });

  it("nieistotne nie podbijają liczby otwartych spraw", () => {
    expect(headStatus([issue({ likelyIrrelevant: true })]).open).toBe(0);
  });
});

// ── chronologia źródeł ────────────────────────────────────────────────────────

describe("chronologia źródeł jednej sprawy", () => {
  it("zszywa mail, Connecteam i TeaBrew w jeden ciąg po czasie", () => {
    const i = issue({
      sourceRefs: [mailRef(), chatRef()],
      lastEvidenceAt: "2026-08-18T09:35:00.000Z",
      lastErpSummary: "2307348: produkcja w toku",
    });
    const os = buildTimeline(i);

    expect(os.map((e) => e.source)).toEqual(["E-mail", "Connecteam · Produkcja", "TeaBrew"]);
    expect(os.map((e) => e.at)).toEqual([...os.map((e) => e.at)].sort());
    expect(sourceSummary(i)).toBe("E-mail + Connecteam + TeaBrew");
  });

  it("„co przyszło ostatnio” to komunikacja, NIE nasz własny odczyt z TeaBrew", () => {
    // Na prawdziwym ekranie to samo zdanie o TeaBrew wychodziło trzy razy, raz
    // jako „co przyszło ostatnio" — czyli nieprawda o tym, kto się ruszył.
    // My zapytaliśmy TeaBrew; nic nie przyszło.
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

  it("nazwa kanału jest przy źródle, nie wciśnięta między autora i treść", () => {
    // Na prawdziwym wyjściu wychodziło „Ania — Produkcja — nie mamy etykiet".
    // Nazwa kanału powtarzała się w miejscu, gdzie właściciel czyta treść.
    const wpis = buildTimeline(issue({ sourceRefs: [chatRef()] }))[0]!;
    expect(wpis.who).toBe("Ania");
    expect(wpis.what).toBe("nie mamy etykiet do tego Rossmanna");
    expect(wpis.what).not.toContain("Produkcja");
    expect(wpis.source).toContain("Produkcja");
  });

  it("NIE wstawia „odpowiedzieliśmy”, bo nie zna godziny odpowiedzi", () => {
    // Flaga IMAP mówi, ŻE odpowiedzieliśmy, nie KIEDY. Wstawienie tego
    // w zgadniętym miejscu przestawiłoby kolejność zdarzeń.
    const os = buildTimeline(issue({ waitingFor: "odpowiedzieliśmy — ruch po drugiej stronie" }));
    expect(os.some((e) => /odpowiedzieliśmy/i.test(e.what))).toBe(false);
  });

  it("wpisy monitora nie zaśmiecają chronologii, działania właściciela owszem", () => {
    const os = buildTimeline(
      issue({
        history: [
          { at: "2026-08-18T09:15:00.000Z", what: "utworzona ze wiadomości <a@x>", by: "operator" },
          { at: "2026-08-18T11:00:00.000Z", what: "status: zamknięta przez właściciela", by: "wlasciciel" },
        ],
      }),
    );
    expect(os.filter((e) => e.own)).toHaveLength(1);
    expect(os.some((e) => /utworzona/.test(e.what))).toBe(false);
  });
});

// ── Connecteam → sprawy ───────────────────────────────────────────────────────

describe("Connecteam zasila te same sprawy", () => {
  const wiadomosc = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    conversationId: "produkcja",
    conversationName: "Produkcja",
    at: "2026-08-18T09:32:00.000Z",
    authorName: "Ania",
    text: "nie mamy etykiet do zamówienia 2307348",
    ...over,
  });

  it("wiadomość o numerze zamówienia DOŁĄCZA do istniejącej sprawy z maila", () => {
    // Sedno §14: mail od klienta + wiadomość produkcji + stan TeaBrew to JEDNA
    // sprawa, nie trzy pozycje na liście.
    const s = store();
    const spr = s.createIssue({
      title: "Rossmann — 2307348",
      summary: "Klient pyta o termin.",
      category: "reply",
      priority: "normal",
      status: "new",
      ref: mailRef(),
      relatedOrderRefs: ["2307348"],
    });

    const out = ingestChatMessage(s, wiadomosc());

    expect(out.outcome).toBe("merged");
    expect(out.issueId).toBe(spr.id);
    expect(s.get(spr.id)!.sourceRefs).toHaveLength(2);
    expect(sourceSummary(s.get(spr.id)!)).toContain("Connecteam");
  });

  it("ten sam webhook dwa razy NIE tworzy drugiej sprawy", () => {
    const s = store();
    const pierwszy = ingestChatMessage(s, wiadomosc());
    const drugi = ingestChatMessage(s, wiadomosc());

    expect(pierwszy.outcome).toBe("created");
    expect(drugi.outcome).toBe("duplicate");
    expect(s.all()).toHaveLength(1);
  });

  it("przy numerze wskazującym DWIE sprawy nie scala — duplikat jest mniej groźny", () => {
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
    const out = ingestChatMessage(s, wiadomosc());
    expect(out.outcome).toBe("created");
    expect(s.all()).toHaveLength(3);
  });

  it("wiadomość bez numeru zakłada osobną sprawę o niskim priorytecie", () => {
    const s = store();
    const out = ingestChatMessage(s, wiadomosc({ text: "kto dziś zamyka halę?" }));
    expect(out.outcome).toBe("created");
    expect(s.get(out.issueId!)!.priority).toBe("low");
    expect(s.get(out.issueId!)!.source).toBe("connecteam");
  });

  it("usunięcie wiadomości u źródła NIE wymazuje sprawy", () => {
    const s = store();
    const created = ingestChatMessage(s, wiadomosc());
    const del = ingestChatMessage(s, wiadomosc({ id: "m2" }), "message_deleted");
    expect(del.outcome).toBe("ignored");
    expect(s.get(created.issueId!)).not.toBeNull();
  });

  it("brak treści u dostawcy mówi to wprost, zamiast udawać pustą wiadomość", () => {
    const s = store();
    const out = ingestChatMessage(s, wiadomosc({ text: "" }));
    expect(s.get(out.issueId!)!.summary).toContain("nie przekazał treści");
  });

  it("identyfikator jest prefiksowany — kolizja z Message-ID poczty jest niemożliwa", () => {
    expect(chatMessageId("produkcja", "m1")).toBe("ct:produkcja:m1");
    expect(chatMessageId("produkcja", "m1").startsWith("ct:")).toBe(true);
  });

  it("konwersacja czatu nie scala się z wątkiem poczty o tym samym identyfikatorze", () => {
    // Kolizja łańcuchów między dwoma systemami nie może być dowodem na nic.
    const mailowa = issue({ sourceRefs: [mailRef({ threadId: "zbieznosc" })] });
    const wynik = matchIssue([mailowa], {
      ref: chatRef({ conversationId: "zbieznosc", messageId: "ct:zbieznosc:9" }),
      parentIds: [],
      orderRefs: [],
    });
    expect(wynik.confidence).toBe("none");
  });
});

describe("ładunek webhooka", () => {
  it("czyta zagnieżdżone `data` i znacznik uniksowy", () => {
    const out = messageFromWebhook({
      eventType: "message_created",
      data: { id: 77, chatId: "kanal", timestamp: 1_755_500_000, text: "cześć", senderName: "Ania" },
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.id).toBe("77");
    expect(out.conversationId).toBe("kanal");
    expect(out.at.startsWith("20")).toBe(true);
  });

  it("odrzuca ładunek bez czasu, zamiast wstawiać „teraz”", () => {
    // Podstawienie bieżącej godziny za brakujący znacznik zepsułoby chronologię
    // sprawy w sposób niewidoczny.
    const out = messageFromWebhook({ data: { id: "1", conversationId: "k" } });
    expect("error" in out).toBe(true);
  });
});

describe("podpis webhooka", () => {
  const body = '{"eventType":"message_created"}';

  it("przyjmuje poprawny podpis i odrzuca podmieniony", () => {
    const secret = "sekret-testowy";
    const dobry = verifySignature(body, signature(body, secret), secret);
    expect(dobry).toBe(true);
    expect(verifySignature(body + " ", signature(body, secret), secret)).toBe(false);
  });

  it("brak sekretu daje `null`, nie `true` — „nie sprawdzam” to nie „zgadza się”", () => {
    expect(verifySignature(body, null, null)).toBeNull();
  });

  it("sekret ustawiony, a podpisu brak → odrzucenie", () => {
    expect(verifySignature(body, null, "sekret")).toBe(false);
  });

  function signature(payload: string, secret: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    return `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
  }
});

// ── brama ─────────────────────────────────────────────────────────────────────

describe("brama do UI", () => {
  const auth = (): UiAuth =>
    new UiAuth({ password: "haslo-do-testow-1234", signingKey: "klucz-testowy", secureCookie: true });

  it("wpuszcza z poprawnym hasłem, odrzuca zbliżone", () => {
    const a = auth();
    expect(a.passwordMatches("haslo-do-testow-1234")).toBe(true);
    expect(a.passwordMatches("haslo-do-testow-1235")).toBe(false);
    expect(a.passwordMatches("haslo-do-testow-123")).toBe(false);
    expect(a.passwordMatches("")).toBe(false);
  });

  it("ciasteczko sesji jest podpisane — podmieniona data wygaśnięcia nie działa", () => {
    const a = auth();
    const dobre = a.issue();
    expect(a.valid(dobre)).toBe(true);

    const podmienione = `9999999999.${dobre.slice(dobre.lastIndexOf(".") + 1)}`;
    expect(a.valid(podmienione)).toBe(false);
    expect(a.valid("cokolwiek")).toBe(false);
    expect(a.valid(null)).toBe(false);
  });

  it("sesja wygasa", () => {
    const a = auth();
    const wydane = a.issue(Date.now());
    expect(a.valid(wydane, Date.now() + 8 * 24 * 3600_000)).toBe(false);
  });

  it("ciasteczko ma HttpOnly, SameSite i Secure — i NIE zawiera hasła", () => {
    const a = auth();
    const header = a.cookieHeader(a.issue());
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
    expect(header).not.toContain("haslo-do-testow");
  });

  it("klucz podpisujący nie da się odtworzyć z ciasteczka", () => {
    const a = auth();
    expect(a.issue()).not.toContain("klucz-testowy");
  });

  it("ogranicznik prób blokuje po piątej i zwalnia po resecie", () => {
    const t = new LoginThrottle(5, 60_000);
    for (let i = 0; i < 5; i += 1) {
      expect(t.allow("ip")).toBe(true);
      t.record("ip");
    }
    expect(t.allow("ip")).toBe(false);
    t.reset("ip");
    expect(t.allow("ip")).toBe(true);
  });
});

// ── widoki ────────────────────────────────────────────────────────────────────

describe("ekran główny", () => {
  it("mówi liczbami, nie tym, że strona się otworzyła", () => {
    const html = renderInbox([issue({ lastErpSummary: "2307348 NIE MA w TeaBrew" })], sync());
    expect(html).toContain("wymaga Twojej uwagi");
    expect(html).toContain("Rossmann");
    expect(html).toContain("w wiadomości jest numer zamówienia 2307348");
  });

  it("nie rysuje pustych sekcji", () => {
    const html = renderInbox([issue({ category: "monitor" })], sync());
    expect(html).toContain("Obserwuj");
    expect(html).not.toContain("🟠 Decyzje");
  });

  it("nieistotne są zwinięte, ale obecne", () => {
    const html = renderInbox([issue({ id: "s", likelyIrrelevant: true, title: "PsiBufet" })], sync());
    expect(html).toContain("<details");
    expect(html).toContain("PsiBufet");
  });

  it("brak skanu mówi wprost, że lista może być niepełna", () => {
    const html = renderInbox([], sync({ lastOkScanAt: null }));
    expect(html).toContain("może być niepełna");
  });

  it("stara synchronizacja jest nazwana, nie przemilczana", () => {
    const dawno = new Date(Date.now() - 3 * 3600_000).toISOString();
    const html = renderInbox([issue()], sync({ lastOkScanAt: dawno }));
    expect(html).toContain("nie była synchronizowana");
  });

  it("nieudany folder daje ostrzeżenie po ludzku, bez stack trace", () => {
    const html = renderInbox(
      [issue()],
      sync({
        checkpoints: [
          {
            folder: "INBOX",
            processedThrough: null,
            lastScanAt: null,
            lastOkScanAt: null,
            lastError: "Error: ECONNREFUSED 10.0.0.1:993\n    at Socket.emit",
            messagesSeen: 0,
          },
        ],
      }),
    );
    expect(html).toContain("Nie udało mi się sprawdzić części poczty");
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("at Socket.emit");
  });

  it("nie wstawia treści z poczty do HTML bez ucieczki", () => {
    const html = renderInbox([issue({ title: '<img src=x onerror="alert(1)">' })], sync());
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("ucieka apostrof — wartość w atrybucie nie może z niego wyjść", () => {
    const html = renderCase(issue({ title: "to' onclick='zle()" }), sync(), null);
    expect(html).not.toContain("onclick='zle()");
    expect(html).toContain("&#39;");
  });
});

describe("ekran sprawy", () => {
  it("pokazuje co się dzieje, dane i chronologię", () => {
    const html = renderCase(
      issue({
        sourceRefs: [mailRef(), chatRef()],
        lastEvidenceAt: "2026-08-18T09:35:00.000Z",
        lastErpSummary: "2307348: produkcja w toku",
      }),
      sync(),
      null,
    );
    expect(html).toContain("Co się dzieje");
    expect(html).toContain("produkcja w toku");
    expect(html).toContain("Connecteam");
    expect(html).toContain("Ania");
  });

  it("NIE pokazuje żargonu: nazw narzędzi, korelacji ani JSON-a", () => {
    const html = renderCase(issue(), sync(), null);
    for (const zargon of ["copilot_get_issue", "mail_get_thread", "teabrew_get_order", "correlationId", "effectClass", "jsonrpc"]) {
      expect(html).not.toContain(zargon);
    }
  });

  it("mówi wprost, że zamknięcie nie wysyła niczego", () => {
    const html = renderCase(issue(), sync(), null);
    expect(html).toContain("Nic nie zostaje wysłane");
    expect(html).toContain("Załatwione");
  });

  it("polecenie do Claude niesie identyfikator sprawy i zakaz rozmowy o innych", () => {
    const html = renderCase(issue({ id: "spr_abc123" }), sync(), null);
    expect(html).toContain("spr_abc123");
    expect(html).toContain("Rozmawiaj tylko o tej sprawie");
  });
});

describe("ekran logowania", () => {
  it("nie zdradza, czy hasło było blisko", () => {
    const html = renderLogin("Nieprawidłowe hasło.");
    expect(html).toContain("Nieprawidłowe hasło.");
    expect(html).not.toMatch(/za krótkie|zły znak|prawie/i);
  });

  it("prosi przeglądarkę, by nie indeksowała tej strony", () => {
    expect(renderLogin(null)).toContain("noindex");
  });
});
