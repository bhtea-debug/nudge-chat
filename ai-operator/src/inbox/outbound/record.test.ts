import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, type InboxMessage } from "../contract.js";
import { projectCase } from "../project.js";
import { InboxStore, type StoredCase } from "../store.js";
import { sendReply, type SendTransport } from "./send.js";
import { ingestMetaEvents } from "../providers/meta/ingest.js";

/**
 * Wysłana odpowiedź jako pełna część wątku.
 *
 * Powód istnienia: sukces u dostawcy aktualizował ledger i na tym się kończył.
 * Wątek nie miał naszej wiadomości, sprawa dalej „wymagała reakcji", a kolejny
 * odczyt wyglądał jak klient bez odpowiedzi. System pokazywał jako niezrobioną
 * pracę, którą właśnie wykonano.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-record-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: InboxStore, overrides: Partial<StoredCase> = {}): StoredCase {
  const incoming: InboxMessage = {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: "mid:klient-1",
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
    authorLabel: "klient@example.com",
    subject: "Zamowienie 4411",
    body: "Gdzie moja paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: "klient-1@example.com",
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: "fp-in",
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.accountKey ? { accountKey: overrides.accountKey } : {}),
    ...(overrides.caseId ? { caseId: overrides.caseId } : {}),
    ...(overrides.externalConversationId
      ? { externalConversationId: overrides.externalConversationId }
      : {}),
  };
  store.claimMessage(incoming);

  const record: StoredCase = {
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    subject: "Zamowienie 4411",
    participantLabel: "klient@example.com",
    orderRef: null,
    firstSeenAt: NOW - 10_000,
    lastMessageAt: NOW - 5_000,
    lastIncomingMessageId: "mid:klient-1",
    lastIncomingAt: NOW - 5_000,
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
  store.upsertCase(record);
  return record;
}

const transport = (result: Awaited<ReturnType<SendTransport["send"]>>): SendTransport => ({
  send: async () => result,
});

describe("odpowiedz w watku", () => {
  it("po wyslaniu wiadomosc jest w historii, a sprawa nie czeka juz na reakcje", async () => {
    const store = freshStore();
    seed(store);

    const result = await sendReply({
      store,
      requestId: "req-0000000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj, numer nadania w mailu.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-42" }),
      now: () => NOW,
    });

    expect(result.status).toBe("sent");
    const messages = store.messagesForCase("ic_sprawa");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.direction).toBe("outgoing");
    expect(messages[1]!.body).toContain("Paczka wyszla dzisiaj");
    // Kolejka przestaje pokazywać sprawę jako wymagającą reakcji.
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("kolejna wiadomosc klienta znow otwiera sprawe", async () => {
    const store = freshStore();
    seed(store);
    await sendReply({
      store,
      requestId: "req-0000000000000002",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-42" }),
      now: () => NOW,
    });
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(false);

    store.claimMessage({
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      externalMessageId: "mid:klient-2",
      caseId: "ic_sprawa",
      direction: "incoming",
      sourceCreatedAt: NOW + 60_000,
      receivedAt: NOW + 60_000,
      authorLabel: "klient@example.com",
      subject: "Re: Zamowienie 4411",
      body: "Numer nadania nie dziala, co dalej?",
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: "klient-2@example.com",
      rfcInReplyTo: "klient-1@example.com",
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp-in-2",
    });
    const projected = projectCase(store, "ic_sprawa", { internalSenders: ["sklep@brownhouseandtea.pl"] });
    store.upsertCase(projected!);

    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
    expect(store.getCase("ic_sprawa")!.lastIncomingMessageId).toBe("mid:klient-2");
  });

  it("echo Meta sklei sie z zapisana odpowiedzia zamiast ja podwoic", async () => {
    const store = freshStore();
    seed(store, {
      caseId: "ic_sprawa",
      provider: "facebook",
      accountKey: "page-123",
      externalConversationId: "klient-77",
    });

    await sendReply({
      store,
      requestId: "req-0000000000000003",
      caseId: "ic_sprawa",
      text: "Juz sprawdzam",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "m_out_1" }),
      now: () => NOW,
    });

    const before = store.messagesForCase("ic_sprawa").length;

    // Meta odsyła echo tej samej wiadomości z tym samym `mid`.
    const echo = ingestMetaEvents(store, [
      {
        kind: "message",
        message: {
          provider: "facebook",
          accountKey: "page-123",
          externalConversationId: "klient-77",
          externalMessageId: "m_out_1",
          caseId: "ic_sprawa",
          direction: "outgoing",
          sourceCreatedAt: NOW + 500,
          receivedAt: NOW + 500,
          authorLabel: null,
          subject: null,
          body: "Juz sprawdzam",
          bodyTruncated: false,
          attachments: [],
          rfcMessageId: null,
          rfcInReplyTo: null,
          rfcReferences: [],
          isEcho: true,
          bulkHint: false,
          contentFingerprint: "fp-echo",
        },
      },
    ]);

    expect(echo.duplicates).toBe(1);
    expect(echo.stored).toBe(0);
    expect(store.messagesForCase("ic_sprawa")).toHaveLength(before);
  });

  it("brak identyfikatora od dostawcy nie gubi odpowiedzi z watku", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000004",
      caseId: "ic_sprawa",
      text: "Odpowiedz bez identyfikatora",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "" }),
      now: () => NOW,
    });

    const outgoing = store.messagesForCase("ic_sprawa").filter((m) => m.direction === "outgoing");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.externalMessageId).toContain("attempt:");
  });

  it("nieudana wysylka NIE dopisuje wiadomosci do watku", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000005",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "failed", code: "http_422", message: "odrzucone" }),
      now: () => NOW,
    });

    expect(store.messagesForCase("ic_sprawa")).toHaveLength(1);
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
  });

  it("stan niepewny tez nie dopisuje wiadomosci: nie wiemy, czy poszla", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000006",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "uncertain", code: "timeout", message: "brak potwierdzenia" }),
      now: () => NOW,
    });

    expect(store.messagesForCase("ic_sprawa")).toHaveLength(1);
    // Sprawa zostaje otwarta: dopisanie odpowiedzi udawałoby wiedzę, której nie mamy.
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
  });
});
