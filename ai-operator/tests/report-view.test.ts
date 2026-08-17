import { describe, expect, it } from "vitest";
import { renderReportHtml, summarize } from "../src/agent/report-view.js";
import type { TriageResult } from "../src/agent/triage.js";

/**
 * Raport dzienny jest jedyną rzeczą, którą właściciel czyta BEZ zadania pytania.
 * Jeśli przemilczy niepełność albo nieudane sprawdzenie, to nie jest raport —
 * to jest gorsze niż brak raportu, bo wygląda na komplet.
 */

const msg = (over: Partial<Record<string, unknown>> = {}): any => ({
  id: "<a@x>",
  providerRef: "imap:INBOX:1",
  threadId: "<a@x>",
  subject: "Zamówienie 2307029",
  from: { name: "Rossmann", address: "zakupy@rossmann.example" },
  to: [],
  cc: [],
  date: "2026-08-17T09:12:00.000Z",
  folder: "INBOX",
  seen: false,
  answered: false,
  inReplyTo: null,
  references: [],
  attachments: [],
  snippet: "przesyłamy zamówienie",
  ...over,
});

const base: TriageResult = {
  sinceDays: 1,
  total: 2,
  items: [
    {
      category: "Do odpowiedzi",
      message: msg(),
      reason: "nowe zamówienie od klienta",
      needsReply: true,
      refs: ["2307029"],
      erp: [{ ref: "2307029", found: false, summary: "nie ma w TeaBrew" }],
    },
    {
      category: "Informacyjne",
      message: msg({ id: "<b@x>", subject: "Newsletter", from: null }),
      reason: "",
      needsReply: false,
      refs: [],
      erp: [],
    },
  ],
  unclassified: [],
  mailNote: null,
  evidence: [
    { capability: "mail_list_recent", ok: true, latencyMs: 1840, detail: "count=2" },
    { capability: "teabrew_get_order_status", ok: true, latencyMs: 220, detail: "matchedBy=none" },
  ],
  audit: [],
  correlationId: "3f2a9c11-1111-4000-8000-000000000001",
};

describe("podsumowanie do powiadomienia", () => {
  it("mówi o liczbach, nie o tym, że raport istnieje", () => {
    const s = summarize(base);
    expect(s).toContain("1 numeru nie ma w TeaBrew");
    expect(s).toContain("1 do odpowiedzi");
    // „Raport gotowy" nie jest informacją, po której ktokolwiek cokolwiek zrobi.
    expect(s.toLowerCase()).not.toContain("gotowy");
  });

  it("przy pustej skrzynce nie udaje, że coś jest", () => {
    expect(summarize({ ...base, total: 0, items: [] })).toBe("Nowej poczty nie było.");
  });

  it("dopisuje ostrzeżenie, gdy przegląd był niepełny", () => {
    expect(summarize({ ...base, mailNote: "Zwrócono 30 z 47…" })).toContain("przegląd niepełny");
  });
});

describe("panel raportu", () => {
  it("stawia brakujące numery na pierwszym miejscu i pokazuje ich źródło", () => {
    const html = renderReportHtml(base, new Date("2026-08-17T09:15:00Z"));
    const missing = html.indexOf("Nie ma tego w TeaBrew");
    const reply = html.indexOf("Czeka na odpowiedź");
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(reply);
    expect(html).toContain("2307029");
    expect(html).toContain("Rossmann");
  });

  it("nie przemilcza niepełnego przeglądu", () => {
    const html = renderReportHtml({ ...base, mailNote: "Zwrócono 30 z 47 pasujących." }, new Date());
    expect(html).toContain("Przegląd niepełny");
    expect(html).toContain("30 z 47");
  });

  it("nieudane sprawdzenie mówi wprost, że danych NIE sprawdzono", () => {
    const html = renderReportHtml(
      {
        ...base,
        evidence: [
          { capability: "teabrew_get_order_status", ok: false, latencyMs: 90_000, detail: "NIE UDAŁO SIĘ" },
        ],
      },
      new Date(),
    );
    expect(html).toContain("sprawdzeń się nie udało");
    expect(html).toContain("NIE zostały sprawdzone");
  });

  it("mówi o numerach, których nie sprawdził z powodu budżetu", () => {
    const html = renderReportHtml(
      {
        ...base,
        items: [{ ...base.items[0]!, refs: ["2307029", "2306847", "2306848"] }],
      },
      new Date(),
    );
    // Dwa numery wymienione, ale nie sprawdzone — cisza tutaj wyglądałaby jak
    // „sprawdziłem i są w porządku".
    expect(html).toContain("2 numerów bez sprawdzenia");
    expect(html).toContain("--erp 30");
  });

  it("gdy wszystko się zgadza, nie straszy", () => {
    const html = renderReportHtml(
      { ...base, items: [{ ...base.items[0]!, erp: [{ ref: "2307029", found: true, summary: "confirmed" }] }] },
      new Date(),
    );
    expect(html).toContain("Wszystkie numery z poczty, które sprawdziłem, są w TeaBrew");
    expect(html).not.toContain("banner stop");
  });

  it("nie wstawia treści poczty do HTML bez ucieczki", () => {
    const html = renderReportHtml(
      {
        ...base,
        items: [{ ...base.items[0]!, message: msg({ subject: '<script>alert("x")</script>' }) }],
      },
      new Date(),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
