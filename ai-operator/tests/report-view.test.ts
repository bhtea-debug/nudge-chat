import { describe, expect, it } from "vitest";
import { renderReportHtml, summarize, type ReportInput } from "../src/agent/report-view.js";
import type { FolderCheckpoint, Issue } from "../src/state/types.js";

/**
 * Raport dzienny jest jedyną rzeczą, którą właściciel czyta BEZ zadania pytania.
 * Jeśli przemilczy niepełny skan albo nieudany folder, to nie jest raport —
 * to jest gorsze niż brak raportu, bo wygląda na komplet.
 */

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "spr_1",
  createdAt: "2026-08-18T09:00:00.000Z",
  updatedAt: "2026-08-18T09:00:00.000Z",
  source: "mail",
  sourceRefs: [
    {
      kind: "mail",
      messageId: "<a@rossmann.example>",
      threadId: null,
      folder: "INBOX",
      date: "2026-08-18T09:00:00.000Z",
      subject: "Zamówienie 2307029",
      from: "zakupy@rossmann.example",
    },
  ],
  title: "Rossmann — Zamówienie 2307029",
  summary: "przesyłamy zamówienie w załączeniu",
  category: "reply",
  priority: "normal",
  status: "new",
  classifier: "deterministic",
  whyListed: "nadawca znany, brak odpowiedzi z naszej strony",
  likelyIrrelevant: false,
  relatedOrderRefs: ["2307029"],
  relatedProductRefs: [],
  lastEvidenceAt: "2026-08-18T09:05:00.000Z",
  lastErpSummary: "zamówienia 2307029 NIE MA w TeaBrew",
  waitingFor: "wiadomość bez odpowiedzi z naszej strony",
  lastPresentedAt: null,
  notificationCandidate: true,
  notificationReason: "pisze o zamówieniu, którego nie ma w TeaBrew",
  history: [],
  ...over,
});

const checkpoint = (over: Partial<FolderCheckpoint> = {}): FolderCheckpoint => ({
  folder: "INBOX",
  processedThrough: "2026-08-18T09:00:00.000Z",
  lastScanAt: new Date().toISOString(),
  lastOkScanAt: new Date().toISOString(),
  lastError: null,
  messagesSeen: 12,
  ...over,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  issues: [issue()],
  checkpoints: [checkpoint()],
  integrityWarning: null,
  ...over,
});

describe("podsumowanie do powiadomienia", () => {
  it("mówi o liczbach, nie o tym, że raport istnieje", () => {
    const s = summarize(input());
    expect(s).toContain("1 numeru nie ma w TeaBrew");
    expect(s).toContain("1 nowych");
    // „Raport gotowy" nie jest informacją, po której ktokolwiek cokolwiek zrobi.
    expect(s.toLowerCase()).not.toContain("gotowy");
  });

  it("bez udanego skanu NIE twierdzi, że nic nie przyszło", () => {
    const s = summarize(input({ issues: [], checkpoints: [checkpoint({ lastOkScanAt: null })] }));
    expect(s).toContain("jeszcze nie skanował");
    expect(s).not.toContain("nic nowego");
  });

  it("spokojny dzień z działającym monitorem mówi „nic nowego”", () => {
    const s = summarize(input({ issues: [] }));
    expect(s).toContain("nic nowego");
  });
});

describe("panel raportu", () => {
  it("stawia brakujące numery na pierwszym miejscu", () => {
    const html = renderReportHtml(input(), new Date("2026-08-18T09:15:00Z"));
    const missing = html.indexOf("Nie ma tego w TeaBrew");
    const waiting = html.indexOf("Korespondencja");
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(waiting);
    expect(html).toContain("2307029");
    expect(html).toContain("Rossmann");
  });

  it("brak jakiegokolwiek skanu jest widoczny na górze", () => {
    const html = renderReportHtml(
      input({ issues: [], checkpoints: [checkpoint({ lastOkScanAt: null })] }),
      new Date(),
    );
    expect(html).toContain("nie wykonał ani jednego udanego skanu");
    expect(html).toContain("NIE znaczy");
  });

  it("stary skan mówi, że raport pokazuje stan z tamtego momentu", () => {
    const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const html = renderReportHtml(
      input({ checkpoints: [checkpoint({ lastOkScanAt: old, lastScanAt: old })] }),
      new Date(),
    );
    expect(html).toContain("Ostatni udany skan");
    expect(html).toContain("nie z teraz");
  });

  it("nieudany folder jest wypisany, nie przemilczany", () => {
    const html = renderReportHtml(
      input({ checkpoints: [checkpoint({ lastError: "połączenie odrzucone" })] }),
      new Date(),
    );
    expect(html).toContain("połączenie odrzucone");
  });

  it("uszkodzona pamięć spraw jest zgłoszona", () => {
    const html = renderReportHtml(input({ integrityWarning: "3 nieczytelnych wpisów" }), new Date());
    expect(html).toContain("3 nieczytelnych wpisów");
  });

  it("gdy wszystko się zgadza, nie straszy", () => {
    const html = renderReportHtml(
      input({ issues: [issue({ lastErpSummary: "2307029: confirmed / paid" })] }),
      new Date(),
    );
    expect(html).toContain("Każdy numer z poczty, który sprawdziłem, jest w TeaBrew");
    expect(html).not.toContain("banner stop");
  });

  it("mówi, skąd bierze się priorytet i podział", () => {
    const html = renderReportHtml(input(), new Date());
    expect(html).toContain("wynikają z FAKTÓW");
    expect(html).toContain("nic nie jest przeformułowane");
  });

  it("rozdziela prawdopodobnie nieistotne do osobnej, zwiniętej sekcji", () => {
    // Zarzut właściciela: „nie rozdziela spamu od wiadomości". Rozdzielenie
    // musi być widoczne w strukturze, nie tylko w danych.
    const html = renderReportHtml(
      input({
        issues: [
          issue({ id: "spr_ok", likelyIrrelevant: false, lastErpSummary: null }),
          issue({
            id: "spr_szum",
            title: "PsiBufet — Złap podwójną zniżkę",
            likelyIrrelevant: true,
            priority: "low",
            whyListed: "nigdy nie pisaliśmy do psibufet.example, brak numeru i brak wątku",
            lastErpSummary: null,
            relatedOrderRefs: [],
          }),
        ],
      }),
      new Date(),
    );
    expect(html).toContain("Prawdopodobnie nieistotne");
    expect(html).toContain("nigdy nie pisaliśmy do psibufet.example");
    // Sekcja jest ZWINIĘTA, ale sprawa nadal w dokumencie — nie usuwamy jej.
    expect(html).toContain("<details>");
    expect(html).toContain("PsiBufet");
  });

  it("każda pozycja niesie priorytet i powód, dla którego tu jest", () => {
    const html = renderReportHtml(
      input({ issues: [issue({ priority: "high", whyListed: "w wiadomości jest numer zamówienia 2307029" })] }),
      new Date(),
    );
    expect(html).toContain("w wiadomości jest numer zamówienia 2307029");
    expect(html).toContain("prio-high");
    expect(html).toContain("wysoki");
  });

  it("nie wstawia treści poczty do HTML bez ucieczki", () => {
    const html = renderReportHtml(
      input({ issues: [issue({ title: '<script>alert("x")</script>' })] }),
      new Date(),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
