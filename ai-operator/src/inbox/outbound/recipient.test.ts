import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxConfig } from "../config.js";
import { CLASSIFIER_VERSION, type InboxMessage } from "../contract.js";
import { handleInboxReply } from "../http.js";
import { createRuntime } from "../runtime.js";
import { InboxStore, type StoredCase } from "../store.js";
import { accountMatchesCase, resolveRecipient } from "./recipient.js";

/**
 * Odbiorca odpowiedzi.
 *
 * Kluczowe twierdzenie tego pliku: przeglądarka nie ma żadnego wpływu na to,
 * gdzie poleci odpowiedź. Gdyby miała, jedno spreparowane żądanie wysyłałoby
 * treść przygotowaną dla klienta pod adres napastnika, z naszej zweryfikowanej
 * domeny i z audytem mówiącym, że wszystko było w porządku.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function config(overrides: Partial<InboxConfig> = {}): InboxConfig {
  return {
    enabled: true,
    stateDir: "state",
    email: [
      {
        accountKey: "sklep",
        label: "E-mail sklep",
        address: "sklep@brownhouseandtea.pl",
        folder: "INBOX",
        sentFolder: null,
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "sklep",
        pass: "x",
      },
      {
        accountKey: "hurt",
        label: "E-mail hurt",
        address: "hurt@brownhouseandtea.pl",
        folder: "INBOX",
        sentFolder: null,
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "hurt",
        pass: "x",
      },
    ],
    meta: [],
    allegroEnabled: false,
    outbound: {
      resendApiKey: "re_test",
      resendWebhookSecret: null,
      metaAppSecret: null,
      metaVerifyToken: null,
    },
    backfillDays: 30,
    tickFirstDelayMs: 100,
    tickIntervalMs: 1_000,
    backfillMode: "preview",
    ...overrides,
  };
}

function runtimeWith(overrides: Partial<InboxConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-recipient-"));
  dirs.push(dir);
  return createRuntime(config(overrides), new InboxStore({ dir }));
}

function seedCase(store: InboxStore, overrides: Partial<StoredCase> = {}): StoredCase {
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
    sourceClosed: false,
    hasAttachments: false,
    ...overrides,
  };
  store.upsertCase(record);
  return record;
}

function seedMessage(store: InboxStore, overrides: Partial<InboxMessage> = {}): void {
  store.claimMessage({
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
    body: "Gdzie paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: "klient-1@example.com",
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    contentFingerprint: "fp1",
    ...overrides,
  });
}

describe("wyliczanie odbiorcy", () => {
  it("e-mail bierze adres z ostatniej wiadomosci klienta", () => {
    const runtime = runtimeWith();
    const record = seedCase(runtime.store);
    seedMessage(runtime.store);

    const resolved = resolveRecipient(runtime.store, record);
    expect(resolved).toMatchObject({ ok: true, recipient: "klient@example.com" });
  });

  it("bez wiadomosci klienta nie ma do kogo pisac", () => {
    const runtime = runtimeWith();
    const record = seedCase(runtime.store);
    expect(resolveRecipient(runtime.store, record)).toMatchObject({
      ok: false,
      code: "recipient_unknown",
    });
  });

  it("Meta uzywa identyfikatora rozmowy, nie pola prezentacyjnego", () => {
    const runtime = runtimeWith();
    const record = seedCase(runtime.store, {
      caseId: "ic_meta",
      provider: "facebook",
      accountKey: "123",
      externalConversationId: "klient-77",
      participantLabel: "ktos-inny",
    });
    expect(resolveRecipient(runtime.store, record)).toMatchObject({
      ok: true,
      recipient: "klient-77",
    });
  });

  it("konto nadawcze musi nalezec do zrodla sprawy", () => {
    expect(accountMatchesCase({ provider: "email", accountKey: "hurt" }, { accountKey: "hurt" })).toBe(true);
    expect(accountMatchesCase({ provider: "email", accountKey: "hurt" }, { accountKey: "sklep" })).toBe(false);
  });
});

describe("kontrakt wysylki nie przyjmuje odbiorcy od klienta", () => {
  const base = {
    operation: "send",
    confirmation: "SEND_CUSTOMER_REPLY",
    requestId: "req-0000000000000001",
    caseId: "ic_sprawa",
    expectedLastIncomingMessageId: "mid:klient-1",
    text: "Odpowiedz",
  };

  it("podany recipient jest ODRZUCANY przez kontrakt", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedMessage(runtime.store);

    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: { ...base, recipient: "napastnik@example.com" },
    });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: "invalid_reply_request" });
  });

  it("wysylka idzie do adresu z trwalej wiadomosci, nie z zadania", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedMessage(runtime.store);

    let capturedTo: unknown = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedTo = JSON.parse(String(init.body)).to;
      return new Response(JSON.stringify({ id: "resend-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: base,
      fetchImpl: fakeFetch,
    });

    expect(result.status).toBe(200);
    expect(capturedTo).toEqual(["klient@example.com"]);
  });

  it("sprawa bez wiadomosci klienta nie wysyla niczego", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);

    let called = false;
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: base,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: "recipient_unknown" });
    expect(called).toBe(false);
  });

  it("konto nadawcze spoza sprawy blokuje wysylke", async () => {
    // Sprawa ze skrzynki `hurt`, a w konfiguracji brak konta `hurt`:
    // fail-closed zamiast wysyłki z pierwszego lepszego adresu.
    const runtime = runtimeWith({ email: [config().email[0]!] });
    seedCase(runtime.store, { accountKey: "hurt" });
    seedMessage(runtime.store, { accountKey: "hurt" });

    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: base,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "email_outbound_not_configured" });
  });
});
