import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, type InboxMessage } from "./contract.js";
import { InboxStore, type OutboundAttempt, type StoredCase } from "./store.js";
import { beginSending, markUncertain, prepareAttempt, resolveUncertain } from "./outbound/ledger.js";
import { sendReply } from "./outbound/send.js";
import { ingestMetaEvents } from "./providers/meta/ingest.js";

/**
 * Awarie w połowie operacji.
 *
 * Restart procesu w losowym momencie jest normalnym zdarzeniem na Railway
 * (deploy, OOM, restart platformy). Te testy sprawdzają, że każdy taki moment
 * zostawia stan, z którego da się wyjść bez utraty wiadomości i bez duplikatu.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-restart-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function message(partial: Partial<InboxMessage> = {}): InboxMessage {
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: "mid:klient-1",
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
    authorLabel: "klient@example.com",
    subject: "Zamowienie",
    body: "Gdzie paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: "klient-1@example.com",
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: "fp1",
    ...partial,
  };
}

function seedCase(store: InboxStore, overrides: Partial<StoredCase> = {}): StoredCase {
  const record: StoredCase = {
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    subject: "Zamowienie",
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

describe("restart w polowie operacji", () => {
  it("restart po trwalym zapisie, przed zatwierdzeniem kursora, nie gubi wiadomosci", () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    before.claimMessage(message());
    // Kursor NIE zostal zatwierdzony: proces padl dokladnie tutaj.

    const after = new InboxStore({ dir });
    expect(after.allMessages()).toHaveLength(1);
    expect(after.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
    // Powtorzone pobranie tej samej partii jest deduplikowane.
    expect(after.claimMessage(message())).toBe(false);
    expect(after.allMessages()).toHaveLength(1);
  });

  it("restart po claimie wysylki, przed requestem, zostawia blokade", async () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    seedCase(before);
    const prepared = prepareAttempt({
      store: before,
      requestId: "req-0000000000000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    expect(prepared.ok).toBe(true);
    beginSending(before, "req-0000000000000001", NOW);
    // Proces pada przed wykonaniem requestu.

    const after = new InboxStore({ dir });
    const attempt = after.getAttempt("req-0000000000000001")!;
    expect(attempt.status).toBe("sending");
    expect(attempt.postStartedAt).toBe(NOW);

    // Inny requestId nie moze wystartowac: blokada przezyla restart.
    const second = await sendReply({
      store: after,
      requestId: "req-0000000000000002",
      caseId: "ic_sprawa",
      text: "Druga proba",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: { send: async () => ({ status: "sent", externalMessageId: "x" }) },
      now: () => NOW + 1_000,
    });
    expect(second).toMatchObject({ status: "rejected", code: "active_attempt_exists" });
  });

  it("restart po requescie, przed odczytem odpowiedzi, daje stan niepewny do rozstrzygniecia", () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    seedCase(before);
    prepareAttempt({
      store: before,
      requestId: "req-0000000000000003",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(before, "req-0000000000000003", NOW);
    markUncertain(before, "req-0000000000000003", "restart_before_response");

    const after = new InboxStore({ dir });
    expect(after.getAttempt("req-0000000000000003")?.status).toBe("uncertain");
    // Rozstrzygniecie recznie jest mozliwe dopiero po odczekaniu.
    expect(resolveUncertain(after, "req-0000000000000003", "sent", NOW + 1_000).ok).toBe(false);
    expect(resolveUncertain(after, "req-0000000000000003", "sent", NOW + 200_000).ok).toBe(true);
  });

  it("spozniony webhook po recznym rozstrzygnieciu nie tworzy nowej sprawy", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store, { caseId: "ic_meta", provider: "facebook", accountKey: "123" });

    const echo = message({
      provider: "facebook",
      accountKey: "123",
      caseId: "ic_meta",
      externalConversationId: "klient-77",
      externalMessageId: "m_echo",
      direction: "outgoing",
      isEcho: true,
      bulkHint: false,
      body: "Juz wysylamy",
      rfcMessageId: null,
      replyToAddress: null,
    });

    expect(ingestMetaEvents(store, [{ kind: "message", message: echo }]).stored).toBe(1);
    // Ten sam webhook przychodzi drugi raz, juz po tym, jak czlowiek
    // rozstrzygnal wynik recznie.
    const late = ingestMetaEvents(store, [{ kind: "message", message: echo }]);
    expect(late.stored).toBe(0);
    expect(late.duplicates).toBe(1);
    expect(store.listCases().filter((entry) => entry.provider === "facebook")).toHaveLength(1);
  });

  it("ucieta ostatnia linia dziennika nie kasuje historii", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message());
    store.claimMessage(message({ externalMessageId: "mid:klient-2", contentFingerprint: "fp2" }));

    // Proces zabity w trakcie zapisu: ostatnia linia jest niepelna.
    appendFileSync(join(dir, "inbox.jsonl"), '{"t":"message","at":1,"messa', "utf8");

    const after = new InboxStore({ dir });
    expect(after.allMessages()).toHaveLength(2);
    expect(after.damageReport()?.lines).toBe(1);
    // Alarm integralnosci jest TRWALY: przezywa restart jako rekord zdrowia.
    expect(after.getHealth({ provider: "store", accountKey: "integrity" })?.state).toBe("error");
  });

  it("stan przezywa kompakcje dziennika", () => {
    const dir = newDir();
    const store = new InboxStore({ dir, compactAbove: 10, allowCompaction: true });
    seedCase(store);
    for (let index = 0; index < 40; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:seq-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    const attempt: OutboundAttempt = {
      requestId: "req-000000000000ledger",
      caseId: "ic_sprawa",
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      contentSha256: "abc",
      contentLength: 3,
      expectedLastIncomingMessageId: "mid:klient-1",
      expectedLastIncomingAt: NOW,
      idempotencyKey: "key",
      status: "sent",
      externalMessageId: "resend-1",
      postStartedAt: NOW,
      completedAt: NOW,
      failureCode: null,
      createdAt: NOW,
      deliveryState: "delivered",
    };
    store.putAttempt(attempt);
    store.commitCursor({ provider: "email", accountKey: "sklep" }, "7:41");

    const after = new InboxStore({ dir });
    // Dziennik zostal skompaktowany do snapshotu, ale nic z niego nie zniknelo.
    expect(readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n").length).toBeLessThan(10);
    expect(after.allMessages()).toHaveLength(40);
    expect(after.getCase("ic_sprawa")).not.toBeNull();
    expect(after.getAttempt("req-000000000000ledger")?.deliveryState).toBe("delivered");
    expect(after.getCursor({ provider: "email", accountKey: "sklep" })).toBe("7:41");
  });

  it("store BEZ prawa do kompakcji nie przepisuje pliku pod nogami drugiego pisarza", () => {
    const dir = newDir();
    // Domyslnie kompakcja jest WYLACZONA: to bezpieczna wartosc dla procesu,
    // ktory tylko dopisuje. Przepisanie pliku nie jest atomowe wobec appendu,
    // wiec pisarz bez wyznaczenia odlinkowalby i-wezel drugiemu.
    const store = new InboxStore({ dir, compactAbove: 5 });
    for (let index = 0; index < 30; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:nowriter-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    store.close();

    const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n");
    // Plik NIE zostal skompaktowany: wszystkie zdarzenia sa nadal osobno.
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.some((line) => line.includes('"t":"snapshot"'))).toBe(false);

    const reopened = new InboxStore({ dir });
    expect(reopened.allMessages()).toHaveLength(30);
  });

  it("wyznaczony pisarz kompaktuje i nic nie ginie", () => {
    const dir = newDir();
    const store = new InboxStore({ dir, compactAbove: 5, allowCompaction: true });
    for (let index = 0; index < 30; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:writer-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    store.close();

    const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(10);
    expect(new InboxStore({ dir }).allMessages()).toHaveLength(30);
  });
});
