import { describe, expect, it } from "vitest";
import { classifyCase, failOpenClassification, normalizeForMatch } from "./classify.js";
import type { InboxMessage } from "./contract.js";

let clock = 1_700_000_000_000;

function message(partial: Partial<InboxMessage> & { body: string }): InboxMessage {
  clock += 60_000;
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: `m-${clock}`,
    caseId: "ic_test",
    direction: "incoming",
    sourceCreatedAt: clock,
    receivedAt: clock,
    authorLabel: "klient@example.com",
    subject: "Zamowienie",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: `fp-${clock}`,
    ...partial,
  };
}

const ours = (body: string) =>
  message({ body, direction: "outgoing", authorLabel: "sklep@brownhouseandtea.pl" });

describe("klasyfikacja wiadomosci klienta", () => {
  it("normalizuje polskie znaki do porownan", () => {
    expect(normalizeForMatch("Dziękuję!")).toBe("dziekuje");
    expect(normalizeForMatch("Gorąco  dziękuję...")).toBe("goraco dziekuje");
  });

  it("pytanie przed zakupem wymaga reakcji", () => {
    const result = classifyCase({
      messages: [message({ body: "Czy matcha ceremonialna jest dostepna w 100 g?" })],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(true);
    expect(result.reason).toBe("customer_message");
  });

  it("reklamacja wymaga reakcji", () => {
    const result = classifyCase({
      messages: [message({ body: "Puszka dotarla wgnieciona, prosze o wymiane." })],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(true);
  });

  it("problem platnosci i wysylki wymaga reakcji", () => {
    expect(
      classifyCase({
        messages: [message({ body: "Zaplacilem dwa razy za zamowienie 4411." })],
        sourceClosed: false,
      }).requiresResponse,
    ).toBe(true);
    expect(
      classifyCase({
        messages: [message({ body: "Paczka nie dotarla, sledzenie stoi od tygodnia." })],
        sourceClosed: false,
      }).requiresResponse,
    ).toBe(true);
  });

  it("newsletter nie alarmuje", () => {
    const result = classifyCase({
      messages: [message({ body: "Nowosci w naszej ofercie", subject: "Newsletter sierpien" })],
      sourceClosed: false,
      bulkHint: true,
    });
    expect(result.requiresResponse).toBe(false);
    expect(result.reason).toBe("bulk_or_marketing");
  });

  it("automatyczna odpowiedz nie alarmuje", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Jestem na urlopie do 30 sierpnia.", subject: "Automatyczna odpowiedz" }),
      ],
      sourceClosed: false,
    });
    // Autoresponder ma teraz wlasna, dokladniejsza kategorie.
    expect(result.reason).toBe("auto_reply");
  });

  it("faktura bez pytania nie alarmuje, ale faktura z pytaniem trafia do weryfikacji", () => {
    // Faktury z systemu ksiegowego niosa naglowki automatu (Auto-Submitted).
    expect(
      classifyCase({
        messages: [message({ body: "W zalaczeniu faktura.", subject: "Faktura 12/2026", bulkHint: true })],
        sourceClosed: false,
      }).requiresResponse,
    ).toBe(false);

    // Wiadomosc masowa Z pytaniem: nie zgadujemy, zostawiamy do sprawdzenia.
    const withQuestion = classifyCase({
      messages: [
        message({
          body: "W zalaczeniu faktura. Czy mozecie poprawic NIP?",
          subject: "Faktura 12/2026",
          bulkHint: true,
        }),
      ],
      sourceClosed: false,
    });
    expect(withQuestion.requiresResponse).toBe(true);
    expect(withQuestion.needsReview).toBe(true);
  });

  it("powiadomienie o niedoreczeniu nie jest sprawa klienta, nawet gdy cytuje pytanie", () => {
    const result = classifyCase({
      messages: [
        message({
          subject: "Delivery Status Notification (Failure)",
          body: "Nie dostarczono. Oryginalna tresc: Czy mozecie poprawic NIP?",
        }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(false);
    expect(result.reason).toBe("bounce");
  });

  it("korespondencja miedzy firmowymi skrzynkami nie jest sprawa klienta", () => {
    const result = classifyCase({
      messages: [message({ body: "Przekazuje zamowienie hurtowe.", authorLabel: "hurt@brownhouseandtea.pl" })],
      sourceClosed: false,
      companyDomains: ["brownhouseandtea.pl"],
    });
    expect(result.reason).toBe("internal_sender");
  });

  it("domena firmowa dziala takze dla adresu spoza listy", () => {
    const result = classifyCase({
      messages: [message({ body: "Nowa osoba, pierwszy dzien.", authorLabel: "nowa.osoba@brownhouseandtea.pl" })],
      sourceClosed: false,
      internalSenders: ["sklep@brownhouseandtea.pl"],
      companyDomains: ["brownhouseandtea.pl"],
    });
    expect(result.reason).toBe("internal_sender");
  });

  it("wiadomosc wewnetrzna nie alarmuje", () => {
    const result = classifyCase({
      messages: [message({ body: "Kasia, dorzuc prosze etykiety.", authorLabel: "kasia@brownhouseandtea.pl" })],
      sourceClosed: false,
      internalSenders: ["kasia@brownhouseandtea.pl"],
    });
    expect(result.reason).toBe("internal_sender");
  });

  it("samo podziekowanie po naszej odpowiedzi zamyka SLA", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Czy zamowienie 4411 jest juz spakowane?" }),
        ours("Tak, zamowienie jest spakowane i czeka na kuriera."),
        message({ body: "Dziekuje!" }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(false);
    expect(result.reason).toBe("thanks_only");
  });

  it("podziekowanie po obietnicy wysylki zostawia sprawe jako czekajaca na realizacje", () => {
    // Zobowiazanie firmy jest wazniejsze od uprzejmosci klienta: sprawa nie ma
    // juz zegara odpowiedzi, ale nie wolno jej uznac za zalatwiona.
    const result = classifyCase({
      messages: [
        message({ body: "Kiedy wyslecie zamowienie?" }),
        ours("Wysylamy jutro rano."),
        message({ body: "Dziekuje!" }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(false);
    expect(result.pendingAction).toBe(true);
    expect(result.reason).toBe("pending_action");
  });

  it("podziekowanie z pytaniem NIE zamyka sprawy", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Kiedy wyslecie zamowienie?" }),
        ours("Wysylamy jutro rano."),
        message({ body: "Dziekuje, a czy dorzucicie probki?" }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(true);
  });

  it("podziekowanie bez naszej odpowiedzi nie zamyka wiszacego pytania", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Prosze o fakture do zamowienia 4411." }),
        message({ body: "Dziekuje" }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(true);
  });

  it("nowa wiadomosc klienta po naszej odpowiedzi znow wymaga reakcji", () => {
    const answered = classifyCase({
      messages: [message({ body: "Gdzie moja paczka?" }), ours("Nadana wczoraj, numer w mailu.")],
      sourceClosed: false,
    });
    expect(answered.requiresResponse).toBe(false);
    expect(answered.reason).toBe("answered");

    const reopened = classifyCase({
      messages: [
        message({ body: "Gdzie moja paczka?" }),
        ours("Nadana wczoraj, numer w mailu."),
        message({ body: "Numer nie dziala, co dalej?" }),
      ],
      sourceClosed: false,
    });
    expect(reopened.requiresResponse).toBe(true);
  });

  it("zamkniete zrodlo wylacza SLA", () => {
    const result = classifyCase({
      messages: [message({ body: "Czy mozna zmienic adres?" })],
      sourceClosed: true,
    });
    expect(result.requiresResponse).toBe(false);
    expect(result.reason).toBe("source_closed");
  });

  it("obietnica wysylki daje pendingAction, a klient czekajacy nie generuje SLA", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Gdzie moja paczka?" }),
        ours("Wysylamy zastepcza dzisiaj."),
        message({ body: "Czekam wiec" }),
      ],
      sourceClosed: false,
    });
    expect(result.pendingAction).toBe(true);
    expect(result.requiresResponse).toBe(false);
  });

  it("pytanie po obietnicy wysylki wraca do kolejki", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Gdzie moja paczka?" }),
        ours("Wysylamy zastepcza dzisiaj."),
        message({ body: "Czy dostane numer nadania?" }),
      ],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(true);
    expect(result.pendingAction).toBe(false);
  });

  it("zalacznik po obietnicy wysylki nie jest bezpiecznym czekaniem", () => {
    const result = classifyCase({
      messages: [
        message({ body: "Gdzie moja paczka?" }),
        ours("Wysylamy zastepcza dzisiaj."),
        message({
          body: "Czekam",
          attachments: [{ id: "a1", fileName: "zdjecie.jpg", mimeType: "image/jpeg", sizeBytes: 10 }],
        }),
      ],
      sourceClosed: false,
    });
    expect(result.pendingAction).toBe(false);
    expect(result.requiresResponse).toBe(true);
  });

  it("awaria klasyfikatora daje sprawe w kolejce, nie cisze", () => {
    expect(failOpenClassification()).toEqual({
      requiresResponse: true,
      pendingAction: false,
      reason: "classifier_error_fail_open",
      // Awaria oceny jest widoczna jako do sprawdzenia, a nie wtopiona w kolejke.
      needsReview: true,
    });
  });

  it("echo wlasnej wiadomosci nie jest liczone jako wiadomosc klienta", () => {
    const result = classifyCase({
      messages: [message({ body: "Wysylamy dzisiaj.", direction: "outgoing", isEcho: true })],
      sourceClosed: false,
    });
    expect(result.requiresResponse).toBe(false);
  });
});
