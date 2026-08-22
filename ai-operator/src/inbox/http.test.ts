import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromPackageRoot } from "../paths.js";
import type { InboxConfig } from "./config.js";
import { CLASSIFIER_VERSION } from "./contract.js";
import { handleInboxRead, handleInboxReply, handleMetaWebhook, handleResendWebhook } from "./http.js";
import { recordFailure, recordSuccess } from "./health.js";
import { createRuntime } from "./runtime.js";
import { InboxStore, type StoredCase } from "./store.js";

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
    ],
    meta: [],
    allegroEnabled: false,
    outbound: {
      resendApiKey: null,
      resendWebhookSecret: null,
      metaAppSecret: null,
      metaVerifyToken: null,
    },
    backfillDays: 30,
    tickFirstDelayMs: 100,
    tickIntervalMs: 1_000,
    backfillMode: "preview",
    companyDomains: ["brownhouseandtea.pl"],
    ...overrides,
  };
}

function runtimeWith(overrides: Partial<InboxConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-http-"));
  dirs.push(dir);
  const store = new InboxStore({ dir });
  return createRuntime(config(overrides), store);
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
    needsReview: false,
    sourceClosed: false,
    hasAttachments: false,
    ...overrides,
  };
  store.upsertCase(record);
  return record;
}

/** Wiadomosc klienta. Bez niej nie ma z czego wyliczyc odbiorcy. */
function seedIncomingMessage(store: InboxStore): void {
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
    bulkHint: false,
    contentFingerprint: "fp-seed",
  });
}

describe("kontrakt HTTP kanalu", () => {
  it("lista domyslnie nie zwraca tematu ani podgladu tresci", () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    recordSuccess(
      runtime.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      NOW,
    );

    const result = handleInboxRead({
      runtime,
      path: "/internal/inbox/cases",
      params: new URLSearchParams(),
      now: NOW,
      trustedChat: true,
    });

    const data = (result.body as { data: { cases: Array<Record<string, unknown>> } }).data;
    expect(result.status).toBe(200);
    expect(data.cases[0]!.subject).toBeNull();
    expect(data.cases[0]!.preview).toBeNull();
    expect(data.cases[0]!.participantLabel).toBeNull();
    // Metadane kolejki zostaja: bez nich nie da sie posortowac pracy.
    expect(data.cases[0]!.caseId).toBe("ic_sprawa");
    expect(data.cases[0]!.requiresResponse).toBe(true);
  });

  it("tryb display jest zastrzezony dla firmowego czatu", () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    runtime.store.claimMessage({
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
      body: "Prosze o kontakt: klient@example.com, tel. 501 234 567",
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: "klient-1@example.com",
      rfcInReplyTo: null,
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp1",
    });

    const asChat = handleInboxRead({
      runtime,
      path: "/internal/inbox/messages",
      params: new URLSearchParams({ id: "ic_sprawa", contentMode: "display" }),
      now: NOW,
      trustedChat: true,
    });
    const chatText = (asChat.body as { data: { messages: Array<{ text: string }> } }).data.messages[0]!.text;
    expect(chatText).toContain("klient@example.com");

    // Ten sam parametr od innego principala schodzi do wariantu zredagowanego.
    const asModel = handleInboxRead({
      runtime,
      path: "/internal/inbox/messages",
      params: new URLSearchParams({ id: "ic_sprawa", contentMode: "display" }),
      now: NOW,
      trustedChat: false,
    });
    const modelText = (asModel.body as { data: { messages: Array<{ text: string }> } }).data.messages[0]!.text;
    expect(modelText).toContain("[e-mail]");
    expect(modelText).toContain("[telefon]");
    expect(modelText).not.toContain("klient@example.com");
  });

  it("blad zrodla nie pozwala zaraportowac pustej kolejki", () => {
    const runtime = runtimeWith();
    recordFailure(
      runtime.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      "error",
      "polaczenie odrzucone",
      NOW,
    );

    const result = handleInboxRead({
      runtime,
      path: "/internal/inbox/cases",
      params: new URLSearchParams(),
      now: NOW,
      trustedChat: true,
    });
    const data = (result.body as { data: { cases: unknown[]; completeView: boolean; freshness: { state: string } } }).data;
    expect(data.cases).toHaveLength(0);
    expect(data.completeView).toBe(false);
    expect(data.freshness.state).toBe("red");
  });

  it("wysylka bez naglowka potwierdzenia czlowieka jest odrzucana", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: null,
      now: NOW,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000000001",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Odpowiedz",
        recipient: "klient@example.com",
      },
    });
    expect(result.status).toBe(428);
  });

  it("zalaczniki w ladunku wysylki sa odrzucane przez kontrakt", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000000001",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Odpowiedz",
        recipient: "klient@example.com",
        attachments: [{ name: "faktura.pdf" }],
      },
    });
    expect(result.status).toBe(422);
  });

  it("brak konfiguracji Resend blokuje wysylke zamiast probowac", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000000001",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Odpowiedz",
      },
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "email_outbound_not_configured" });
  });

  it("sprawa Allegro nie przechodzi ta brama", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store, { caseId: "ic_allegro", provider: "allegro", accountKey: "wiadomosci" });
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000000002",
        caseId: "ic_allegro",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Odpowiedz",
      },
    });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "provider_uses_dedicated_bridge" });
  });

  it("webhook Meta bez skonfigurowanego sekretu nie przyjmuje danych", () => {
    const runtime = runtimeWith();
    const result = handleMetaWebhook({
      runtime,
      method: "POST",
      params: new URLSearchParams(),
      rawBody: "{}",
      signatureHeader: "sha256=" + "0".repeat(64),
      now: NOW,
    });
    expect(result.status).toBe(503);
  });

  it("webhook Meta z blednym podpisem nie zapisuje niczego", () => {
    const runtime = runtimeWith({
      outbound: {
        resendApiKey: null,
        resendWebhookSecret: null,
        metaAppSecret: "sekret",
        metaVerifyToken: "verify",
      },
      meta: [{ provider: "facebook", accountKey: "123", pageId: "123", label: "Facebook", accessToken: "t" }],
    });
    const result = handleMetaWebhook({
      runtime,
      method: "POST",
      params: new URLSearchParams(),
      rawBody: JSON.stringify({ object: "page", entry: [] }),
      signatureHeader: "sha256=" + "a".repeat(64),
      now: NOW,
    });
    expect(result.status).toBe(401);
    expect(runtime.store.allMessages()).toHaveLength(0);
  });

  it("webhook Resend bez sekretu nie jest przyjmowany", () => {
    const runtime = runtimeWith();
    const result = handleResendWebhook({
      runtime,
      rawBody: "{}",
      svixId: "msg_1",
      svixTimestamp: "1",
      svixSignature: "v1,abc",
      now: NOW,
    });
    expect(result.status).toBe(503);
  });
});

describe("granica narzedzi AI", () => {
  it("rejestr narzedzi MCP nie zawiera zadnej sciezki wysylki", async () => {
    const capabilities = await import("../capability/registry.js").catch(() => null);
    // Rejestr jest budowany dynamicznie; sprawdzamy zrodla, ktore go zasilaja.
    const files = [
      "src/teabrew/capabilities.ts",
      "src/mail/capabilities.ts",
      "src/state/capabilities.ts",
    ];
    const forbidden = /name:\s*"[a-z0-9_]*(send|reply|write|post|create|update|delete)[a-z0-9_]*"/i;
    for (const file of files) {
      const source = readFileSync(fromPackageRoot(file), "utf8");
      expect(source, `${file} wystawia narzedzie zapisu`).not.toMatch(forbidden);
    }
    expect(capabilities === null || typeof capabilities === "object").toBe(true);
  });

  it("modul kanalu nie jest importowany przez rejestr narzedzi", () => {
    for (const file of ["src/teabrew/capabilities.ts", "src/mail/capabilities.ts", "src/state/capabilities.ts"]) {
      const source = readFileSync(fromPackageRoot(file), "utf8");
      expect(source).not.toContain("inbox/");
    }
  });

  it("brama wysylki nie importuje rejestru capability ani MCP", () => {
    const source = readFileSync(fromPackageRoot("src/inbox/outbound/send.ts"), "utf8");
    expect(source).not.toContain("capability/");
    expect(source).not.toContain("mcp/");
  });
});
