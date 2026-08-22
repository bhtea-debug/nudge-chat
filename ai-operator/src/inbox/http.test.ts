import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromPackageRoot } from "../paths.js";
import type { InboxConfig } from "./config.js";
import { CLASSIFIER_VERSION } from "./contract.js";
import { handleInboxRead, handleInboxReply, handleMetaWebhook, handleResendWebhook } from "./http.js";
import { recordFailure, recordSuccess } from "./health.js";
import { createRuntime } from "./runtime.js";
import { InboxStore, type OutboundAttempt, type StoredCase } from "./store.js";

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
    replyToAddress: null,
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
      replyToAddress: null,
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

// ── webhook Resend: kolejnosc dedup wobec zastosowania ───────────────────────

const RESEND_SECRET = `whsec_${Buffer.from("sekret-webhooka-resend-1234").toString("base64")}`;

function resendRuntime() {
  return runtimeWith({
    outbound: {
      resendApiKey: null,
      resendWebhookSecret: RESEND_SECRET,
      metaAppSecret: null,
      metaVerifyToken: null,
    },
  });
}

/** Podpisany ladunek Svix. Podpis liczony z `svixId.timestamp.body`. */
function signedResend(svixId: string, rawBody: string, now: number) {
  const svixTimestamp = String(Math.floor(now / 1000));
  const key = Buffer.from(RESEND_SECRET.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`, "utf8")
    .digest("base64");
  return { rawBody, svixId, svixTimestamp, svixSignature: `v1,${signature}` };
}

function attempt(overrides: Partial<OutboundAttempt> = {}): OutboundAttempt {
  return {
    requestId: "req-0000000000000100",
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    contentSha256: "a".repeat(64),
    contentLength: 12,
    expectedLastIncomingMessageId: "mid:klient-1",
    expectedLastIncomingAt: NOW - 5_000,
    idempotencyKey: "k".repeat(48),
    status: "sent",
    externalMessageId: "resend-abc",
    postStartedAt: NOW - 2_000,
    completedAt: NOW - 1_000,
    failureCode: null,
    createdAt: NOW - 3_000,
    deliveryState: "unknown",
    ...overrides,
  };
}

describe("webhook Resend nie spala svix-id przed zastosowaniem", () => {
  it("nieznany email_id NIE konczy sie 200 i NIE zuzywa svix-id", () => {
    const runtime = resendRuntime();
    seedCase(runtime.store);
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "resend-abc" } });
    const signed = signedResend("msg_wyscig", body, NOW);

    /*
     * Wyscig webhooka odbicia z zapisem `externalMessageId` przez sciezke
     * wysylki: proby jeszcze nie ma w ledgerze. Odpowiedz 200 spalilaby
     * svix-id, a Resend nie ponowilby juz nigdy.
     */
    const pierwsza = handleResendWebhook({ runtime, ...signed, now: NOW });
    expect(pierwsza.status).not.toBe(200);
    expect(pierwsza.status).toBeGreaterThanOrEqual(500);

    // Sciezka wysylki dopisuje probe chwile pozniej.
    runtime.store.putAttempt(attempt());

    const ponowienie = handleResendWebhook({ runtime, ...signed, now: NOW + 1_000 });
    expect(ponowienie.status).toBe(200);
    expect(ponowienie.body).toMatchObject({ data: { accepted: true, applied: true } });
    expect(runtime.store.getAttempt("req-0000000000000100")?.deliveryState).toBe("bounced");
  });

  it("wyjatek przy zapisie NIE zuzywa svix-id, a ponowienie stosuje DOKLADNIE raz", () => {
    const runtime = resendRuntime();
    seedCase(runtime.store);
    runtime.store.putAttempt(attempt());
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "resend-abc" } });
    const signed = signedResend("msg_awaria", body, NOW);

    const awaria = new Error("dysk pelny");
    const spy = vi.spyOn(runtime.store, "putAttempt").mockImplementationOnce(() => {
      throw awaria;
    });
    expect(() => handleResendWebhook({ runtime, ...signed, now: NOW })).toThrow(awaria);
    expect(runtime.store.getAttempt("req-0000000000000100")?.deliveryState).toBe("unknown");

    const ponowienie = handleResendWebhook({ runtime, ...signed, now: NOW + 1_000 });
    expect(ponowienie.status).toBe(200);
    expect(ponowienie.body).toMatchObject({ data: { applied: true } });
    // Jeden nieudany zapis + jeden udany. Zdarzenie zastosowane raz.
    expect(spy).toHaveBeenCalledTimes(2);

    // Trzecie doreczenie tego samego zdarzenia jest juz duplikatem.
    const trzecia = handleResendWebhook({ runtime, ...signed, now: NOW + 2_000 });
    expect(trzecia.body).toMatchObject({ data: { duplicate: true } });
    expect(spy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("duplikat PRAWDZIWIE zastosowanego zdarzenia dalej jest duplikatem", () => {
    const runtime = resendRuntime();
    seedCase(runtime.store);
    runtime.store.putAttempt(attempt());
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "resend-abc" } });
    const signed = signedResend("msg_duplikat", body, NOW);

    const pierwsza = handleResendWebhook({ runtime, ...signed, now: NOW });
    expect(pierwsza.body).toMatchObject({ data: { accepted: true, applied: true } });

    const druga = handleResendWebhook({ runtime, ...signed, now: NOW + 1_000 });
    expect(druga.status).toBe(200);
    expect(druga.body).toMatchObject({ data: { accepted: true, duplicate: true } });
    expect(runtime.store.getAttempt("req-0000000000000100")?.deliveryState).toBe("delivered");
  });

  it("niepoprawny JSON NIE zuzywa svix-id", () => {
    const runtime = resendRuntime();
    seedCase(runtime.store);
    runtime.store.putAttempt(attempt());
    const zepsuty = signedResend("msg_json", "{to nie jest json", NOW);
    expect(handleResendWebhook({ runtime, ...zepsuty, now: NOW }).status).toBe(400);

    // Ten sam svix-id z poprawnym cialem musi jeszcze przejsc.
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "resend-abc" } });
    const poprawny = signedResend("msg_json", body, NOW + 1_000);
    const wynik = handleResendWebhook({ runtime, ...poprawny, now: NOW + 1_000 });
    expect(wynik.status).toBe(200);
    expect(wynik.body).toMatchObject({ data: { applied: true } });
  });

  it("zdarzenie bez skutku jest domykane, a nie ponawiane w nieskonczonosc", () => {
    const runtime = resendRuntime();
    seedCase(runtime.store);
    const body = JSON.stringify({ type: "email.sent", data: { email_id: "resend-abc" } });
    const signed = signedResend("msg_ignorowane", body, NOW);

    const pierwsza = handleResendWebhook({ runtime, ...signed, now: NOW });
    expect(pierwsza.status).toBe(200);
    expect(pierwsza.body).toMatchObject({
      data: { accepted: true, applied: false, reason: "unsupported_event_type" },
    });

    // Domkniete jawnie: 200 z podanym powodem, wiec dostawca nie ponawia
    // w nieskonczonosc, a powtorka nie ma zadnego skutku w ledgerze.
    const powtorka = handleResendWebhook({ runtime, ...signed, now: NOW + 1_000 });
    expect(powtorka.status).toBe(200);
    expect(powtorka.body).toMatchObject({ data: { applied: false } });
    expect(runtime.store.listAttempts()).toHaveLength(0);
  });
});

// ── rozstrzygniecie proby: nowa semantyka ledgera ────────────────────────────

describe("recznie rozstrzygniecie proby", () => {
  const REQ = "req-0000000000000100";

  function resolveBody(operation: "resolve_sent" | "resolve_not_sent") {
    return {
      operation,
      confirmation:
        operation === "resolve_sent"
          ? "CONFIRM_CUSTOMER_REPLY_WAS_SENT"
          : "CONFIRM_CUSTOMER_REPLY_WAS_NOT_SENT",
      requestId: REQ,
      caseId: "ic_sprawa",
      expectedLastIncomingMessageId: "mid:klient-1",
    };
  }

  it("zgodne ponowienie daje 200 bez zapisu, sprzeczne 409", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);
    // Utrwalone `sending`: proces padl przed odczytem odpowiedzi dostawcy.
    runtime.store.putAttempt(
      attempt({ status: "sending", externalMessageId: null, completedAt: null, postStartedAt: NOW - 600_000 }),
    );

    const pierwsze = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: resolveBody("resolve_sent"),
    });
    expect(pierwsze.status).toBe(200);
    expect(pierwsze.body).toMatchObject({
      data: { status: "sent", changed: true, repairedHistory: true, manuallyResolved: true },
    });
    const completedAt = runtime.store.getAttempt(REQ)?.completedAt;

    const powtorka = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 60_000,
      body: resolveBody("resolve_sent"),
    });
    expect(powtorka.status).toBe(200);
    expect(powtorka.body).toMatchObject({
      data: { status: "sent", changed: false, repairedHistory: false },
    });
    // Powtorka niczego nie przepisuje: czas rozstrzygniecia zostaje pierwotny.
    expect(runtime.store.getAttempt(REQ)?.completedAt).toBe(completedAt);
    // Ani nie dokleja drugiej wiadomosci do watku.
    expect(
      runtime.store.messagesForCase("ic_sprawa").filter((message) => message.direction === "outgoing"),
    ).toHaveLength(1);

    const sprzeczne = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 120_000,
      body: resolveBody("resolve_not_sent"),
    });
    expect(sprzeczne.status).toBe(409);
    expect(sprzeczne.body).toMatchObject({ error: "conflicting_resolution:sent" });
  });

  it("odpowiedz niesie FAKTYCZNY stan proby, a nie stan wywnioskowany z zadania", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    // Proba anulowana. „Nie wyslano" sie zgadza, ale statusem jest `cancelled`.
    runtime.store.putAttempt(
      attempt({ status: "cancelled", externalMessageId: null, completedAt: NOW - 1_000 }),
    );

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: resolveBody("resolve_not_sent"),
    });
    expect(wynik.status).toBe(200);
    expect(wynik.body).toMatchObject({ data: { status: "cancelled", changed: false } });
  });
});

describe("porzucone `prepared` nie blokuje sprawy na zawsze", () => {
  it("wysylka sprzata wygasle `prepared` zamiast odbic sie o nie", async () => {
    const runtime = runtimeWith({
      outbound: {
        resendApiKey: "re_test",
        resendWebhookSecret: null,
        metaAppSecret: null,
        metaVerifyToken: null,
      },
    });
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);
    /*
     * Proces padl po zapisie `prepared`, a przed pierwszym requestem. Czlowiek
     * nigdy nie zobaczyl potwierdzenia, wiec nie wie, ze jest co anulowac —
     * a `prepared` blokuje kazda kolejna probe w tej sprawie.
     */
    runtime.store.putAttempt(
      attempt({
        requestId: "req-0000000000000999",
        status: "prepared",
        externalMessageId: null,
        postStartedAt: null,
        completedAt: null,
        createdAt: NOW - 40 * 60_000,
      }),
    );

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "resend-nowy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      fetchImpl,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000001000",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Paczka wyszla dzisiaj",
      },
    });

    expect(wynik.body).toMatchObject({ data: { status: "sent", rejected: false } });
    const porzucona = runtime.store.getAttempt("req-0000000000000999")!;
    expect(porzucona.status).toBe("failed");
    expect(porzucona.failureCode).toBe("prepared_expired");
  });

  it("SWIEZE `prepared` dalej blokuje druga wysylke", async () => {
    const runtime = runtimeWith({
      outbound: {
        resendApiKey: "re_test",
        resendWebhookSecret: null,
        metaAppSecret: null,
        metaVerifyToken: null,
      },
    });
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);
    runtime.store.putAttempt(
      attempt({
        requestId: "req-0000000000000999",
        status: "prepared",
        externalMessageId: null,
        postStartedAt: null,
        completedAt: null,
        createdAt: NOW - 60_000,
      }),
    );

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      fetchImpl: (async () => {
        throw new Error("wysylka nie ma prawa tu dojsc");
      }) as unknown as typeof fetch,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: "req-0000000000001000",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Paczka wyszla dzisiaj",
      },
    });
    // Blokada zdejmowana zegarem TYLKO po TTL: minute po przygotowaniu proba
    // moze byc w toku u czlowieka, ktory wlasnie czyta tresc.
    expect(runtime.store.getAttempt("req-0000000000000999")?.status).toBe("prepared");
    expect(wynik.body).toMatchObject({ data: { rejected: true, code: "active_attempt_exists" } });
  });
});


/**
 * Ponawianie zdarzen doreczenia MUSI miec koniec.
 *
 * Nieznany `email_id` to najczesciej wyscig: webhook odbicia wyprzedzil zapis
 * identyfikatora przez sciezke wysylki. Odpowiadanie 5xx w nieskonczonosc
 * zamienialoby jednak jeden nieistotny webhook (np. wiadomosc wyslana przez to
 * samo konto Resend, ale inna integracje) w staly strumien bledow.
 */
describe("okno ponowien doreczenia Resend", () => {
  function podpisane(body: string, secret: string, id: string, ts: number) {
    const signed = `${id}.${ts}.${body}`;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signature = createHmac("sha256", key).update(signed).digest("base64");
    return { id, ts: String(ts), signature: `v1,${signature}` };
  }

  const SECRET = "whsec_" + Buffer.from("sekret-testowy-doreczen").toString("base64");

  function wyslij(runtime: ReturnType<typeof runtimeWith>, createdAt: string, id: string) {
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: createdAt,
      data: { email_id: "nieznany-identyfikator" },
    });
    const ts = Math.floor(NOW / 1000);
    const naglowki = podpisane(body, SECRET, id, ts);
    return handleResendWebhook({
      runtime,
      rawBody: body,
      svixId: naglowki.id,
      svixTimestamp: naglowki.ts,
      svixSignature: naglowki.signature,
      now: NOW,
    });
  }

  it("SWIEZE zdarzenie bez pasujacej wysylki wraca po ponowienie", () => {
    const runtime = runtimeWith({
      outbound: {
        resendApiKey: null,
        resendWebhookSecret: SECRET,
        metaAppSecret: null,
        metaVerifyToken: null,
      },
    });
    const wynik = wyslij(runtime, new Date(NOW - 10_000).toISOString(), "svix-swieze");
    // 5xx to jedyny kod, po ktorym dostawca ponowi. 200 spalilby zdarzenie.
    expect(wynik.status).toBe(503);
  });

  it("STARE zdarzenie jest przyjmowane, ale zostawia SLAD, a nie cisze", () => {
    const runtime = runtimeWith({
      outbound: {
        resendApiKey: null,
        resendWebhookSecret: SECRET,
        metaAppSecret: null,
        metaVerifyToken: null,
      },
    });
    const wynik = wyslij(runtime, new Date(NOW - 30 * 60_000).toISOString(), "svix-stare");
    expect(wynik.status).toBe(200);
    expect(wynik.body).toMatchObject({ data: { applied: false, reason: "delivery_target_not_found" } });

    // Zniknienie odbicia jest WIDOCZNE w kanale, nie tylko w logu.
    const zdrowie = runtime.store.listHealth().find((h) => h.accountKey === "resend#delivery");
    expect(zdrowie?.state).not.toBe("ok");
  });
});
