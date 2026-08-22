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
import { beginSending, finishSent, prepareAttempt } from "./outbound/ledger.js";

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

// ── kontrola proby: `check` naprawia historie (P0.2) ─────────────────────────

/**
 * `check` byl czysto odczytowy, a `historyComplete` liczylo, czy w sprawie
 * jest JAKAKOLWIEK wiadomosc wychodzaca. Oba bledy skladaly sie na jeden
 * skutek: po awarii miedzy potwierdzeniem wysylki a zapisem historii watek
 * nie pokazywal odpowiedzi, a kontrola oglaszala „historia kompletna" i nikt
 * juz nigdy tego wpisu nie odtworzyl.
 */
describe("kontrola proby naprawia historie", () => {
  const REQ = "req-0000000000000100";

  function checkBody(requestId = REQ) {
    return {
      operation: "check",
      confirmation: "CHECK_CUSTOMER_REPLY",
      requestId,
      caseId: "ic_sprawa",
      expectedLastIncomingMessageId: "mid:klient-1",
    };
  }

  function wychodzace(runtime: ReturnType<typeof runtimeWith>) {
    return runtime.store
      .messagesForCase("ic_sprawa")
      .filter((message) => message.direction === "outgoing");
  }

  /** Atrapa dostawcy, ktora LICZY zadania. Kontrola nie ma prawa ich dolozyc. */
  function liczacyFetch(): { impl: typeof fetch; ile: () => number } {
    let ile = 0;
    const impl = (async () => {
      ile += 1;
      return new Response(JSON.stringify({ id: "resend-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, ile: () => ile };
  }

  it("odtwarza wpis po awarii miedzy potwierdzeniem a zapisem historii, BEZ zadania do dostawcy", async () => {
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
    const dostawca = liczacyFetch();

    /*
     * Awaria DOKLADNIE w oknie miedzy `finishSent` a zapisem wiadomosci:
     * ledger dostaje `sent`, a wpis w watku nie powstaje.
     */
    const zapis = runtime.store.claimMessageDurable.bind(runtime.store);
    runtime.store.claimMessageDurable = (message) =>
      message.direction === "outgoing" ? false : zapis(message);

    const wyslane = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      fetchImpl: dostawca.impl,
      body: {
        operation: "send",
        confirmation: "SEND_CUSTOMER_REPLY",
        requestId: REQ,
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
        text: "Paczka wyszla wczoraj",
      },
    });
    expect(wyslane.body).toMatchObject({ data: { status: "sent" } });
    expect(dostawca.ile()).toBe(1);
    expect(wychodzace(runtime)).toHaveLength(0);

    runtime.store.claimMessageDurable = zapis;

    const pierwsza = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 30_000,
      fetchImpl: dostawca.impl,
      body: checkBody(),
    });
    expect(pierwsza.status).toBe(200);
    expect(pierwsza.body).toMatchObject({
      data: {
        status: "sent",
        terminal: true,
        outcome: "sent",
        repairedHistory: true,
        restoredMessage: true,
        historyComplete: true,
      },
    });
    // Wpis wrocil, a do dostawcy nie poszlo ANI JEDNO dodatkowe zadanie.
    expect(wychodzace(runtime)).toHaveLength(1);
    expect(wychodzace(runtime)[0]!.externalMessageId).toBe("resend:resend-abc");
    expect(dostawca.ile()).toBe(1);

    const druga = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 60_000,
      fetchImpl: dostawca.impl,
      body: checkBody(),
    });
    expect(druga.body).toMatchObject({
      data: { status: "sent", repairedHistory: false, restoredMessage: false, historyComplete: true },
    });
    // Druga kontrola niczego nie dubluje ani nie dokłada zadan.
    expect(wychodzace(runtime)).toHaveLength(1);
    expect(dostawca.ile()).toBe(1);
  });

  it("starsza odpowiedz w sprawie NIE udaje kompletnej historii tej proby", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);

    // Odpowiedz sprzed tygodnia, z zupelnie innej proby.
    runtime.store.claimMessage({
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      externalMessageId: "resend:stara-odpowiedz",
      caseId: "ic_sprawa",
      direction: "outgoing",
      sourceCreatedAt: NOW - 604_800_000,
      receivedAt: NOW - 604_800_000,
      authorLabel: null,
      subject: "Zamowienie 4411",
      body: "Dzien dobry, sprawdzamy",
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: null,
      replyToAddress: null,
      rfcInReplyTo: null,
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp-stara",
    });
    runtime.store.putAttempt(attempt());
    expect(wychodzace(runtime)).toHaveLength(1);

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      // Atrapa, ktora WYBUCHA: kontrola nie ma prawa dotknac dostawcy.
      fetchImpl: (() => {
        throw new Error("kontrola nie moze wolac dostawcy");
      }) as unknown as typeof fetch,
      body: checkBody(),
    });

    expect(wynik.body).toMatchObject({
      data: { status: "sent", repairedHistory: true, restoredMessage: true, historyComplete: true },
    });
    // Brakujacy wpis TEJ proby powstal obok starszej odpowiedzi.
    const wpisy = wychodzace(runtime).map((message) => message.externalMessageId);
    expect(wpisy).toContain("resend:stara-odpowiedz");
    expect(wpisy).toContain("resend:resend-abc");
    expect(wpisy).toHaveLength(2);
  });

  it("nieudana naprawa NIE oglasza kompletnej historii, mimo starszej odpowiedzi w watku", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);
    runtime.store.claimMessage({
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      externalMessageId: "resend:stara-odpowiedz",
      caseId: "ic_sprawa",
      direction: "outgoing",
      sourceCreatedAt: NOW - 604_800_000,
      receivedAt: NOW - 604_800_000,
      authorLabel: null,
      subject: "Zamowienie 4411",
      body: "Dzien dobry, sprawdzamy",
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: null,
      replyToAddress: null,
      rfcInReplyTo: null,
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp-stara",
    });
    runtime.store.putAttempt(attempt());

    // Magazyn dalej odmawia zapisu: naprawa nie ma jak sie udac.
    runtime.store.claimMessageDurable = () => false;

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: checkBody(),
    });

    /*
     * Watek MA wiadomosc wychodzaca, ale nie te. Odpowiedz „historia
     * kompletna" liczona z samego KIERUNKU wiadomosci klamalaby tutaj,
     * a klamstwo konczy sie tym, ze brakujacy wpis nie powstaje juz nigdy.
     */
    expect(wynik.body).toMatchObject({
      data: {
        status: "sent",
        historyComplete: false,
        repairedHistory: false,
        restoredMessage: false,
        historyBlockedBy: "write_failed",
      },
    });
    expect(wychodzace(runtime)).toHaveLength(1);
  });

  it("niesie TERMINALNY stan proby: kiedy wolno odblokowac formularz, a kiedy nie", async () => {
    const runtime = runtimeWith();
    seedCase(runtime.store);
    seedIncomingMessage(runtime.store);

    // 1. Brak sladu proby: nic nie polecialo, wiec wolno pisac od nowa.
    const brak = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: checkBody("req-0000000000000777"),
    });
    expect(brak.body).toMatchObject({
      data: { status: "not_found", terminal: true, outcome: "not_sent", mayRetry: true, needsHumanDecision: false },
    });

    // 2. `uncertain`: NIE wolno odblokowac, decyduje czlowiek.
    runtime.store.putAttempt(
      attempt({ status: "uncertain", externalMessageId: null, completedAt: null, failureCode: "transport_exception" }),
    );
    const niepewna = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: checkBody(),
    });
    expect(niepewna.body).toMatchObject({
      data: {
        status: "uncertain",
        terminal: false,
        outcome: "unknown",
        mayRetry: false,
        needsHumanDecision: true,
        // Niewyslana proba jest spojna z definicji: w watku nie ma prawa byc
        // odpowiedzi, o ktorej nie wiemy, czy poszla.
        historyComplete: true,
        repairedHistory: false,
      },
    });
    expect(wychodzace(runtime)).toHaveLength(0);

    // 3. `failed`: terminalne i wolno ponowic.
    runtime.store.putAttempt(
      attempt({ status: "failed", externalMessageId: null, failureCode: "http_422" }),
    );
    const nieudana = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: checkBody(),
    });
    expect(nieudana.body).toMatchObject({
      data: { status: "failed", terminal: true, outcome: "not_sent", mayRetry: true, needsHumanDecision: false },
    });

    // 4. `sent`: terminalne, ale ponowienie TEJ tresci jest zabronione.
    runtime.store.putAttempt(attempt());
    const wyslana = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW,
      body: checkBody(),
    });
    expect(wyslana.body).toMatchObject({
      data: { status: "sent", terminal: true, outcome: "sent", mayRetry: false, needsHumanDecision: false },
    });
  });
});

// ── prog zaleglego uzgodnienia idzie z KONFIGURACJI (P0.4) ───────────────────

describe("kompletnosc widoku w odpowiedzi kolejki", () => {
  function czytajKolejke(runtime: ReturnType<typeof runtimeWith>, now: number) {
    const result = handleInboxRead({
      runtime,
      path: "/internal/inbox/cases",
      params: new URLSearchParams(),
      now,
      trustedChat: true,
    });
    return (
      result.body as {
        data: {
          completeView: boolean;
          freshness: {
            contractVersion: string;
            completeView: boolean;
            reconcileOverdue: string[];
            reconcileOverdueMs: number;
          };
        };
      }
    ).data;
  }

  it("kadencja z konfiguracji przesuwa prog zaleglosci widziany przez kolejke", () => {
    const gesta = runtimeWith({ tickIntervalMs: 60_000 });
    seedCase(gesta.store);
    recordSuccess(
      gesta.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      NOW - 30 * 60_000,
    );
    const zGesta = czytajKolejke(gesta, NOW);
    // Kadencja minutowa: prog to 18 minut, wiec 30 minut bez uzgodnienia
    // znaczy „nie wiemy, czy to cala kolejka".
    expect(zGesta.freshness.reconcileOverdueMs).toBe(18 * 60_000);
    expect(zGesta.freshness.reconcileOverdue).toContain("email:sklep");
    expect(zGesta.completeView).toBe(false);

    const rzadka = runtimeWith({ tickIntervalMs: 300_000 });
    seedCase(rzadka.store);
    recordSuccess(
      rzadka.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      NOW - 30 * 60_000,
    );
    const zRzadka = czytajKolejke(rzadka, NOW);
    expect(zRzadka.freshness.reconcileOverdueMs).toBe(90 * 60_000);
    expect(zRzadka.freshness.reconcileOverdue).toHaveLength(0);
    expect(zRzadka.completeView).toBe(true);
  });

  it("niespojne przewijanie zabiera kompletnosc, mimo zdrowego kanalu", () => {
    const runtime = runtimeWith();
    recordSuccess(
      runtime.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      NOW,
    );
    seedCase(runtime.store, { caseId: "ic_a", lastMessageAt: NOW - 1_000 });
    seedCase(runtime.store, { caseId: "ic_b", lastMessageAt: NOW - 2_000 });
    seedCase(runtime.store, { caseId: "ic_c", lastMessageAt: NOW - 3_000 });

    function strona(cursor: string | null) {
      const params = new URLSearchParams({ state: "all", limit: "1" });
      if (cursor) params.set("cursor", cursor);
      return (
        handleInboxRead({ runtime, path: "/internal/inbox/cases", params, now: NOW, trustedChat: true })
          .body as {
          data: {
            cases: Array<{ caseId: string }>;
            nextCursor: string | null;
            snapshotChanged: boolean;
            completeView: boolean;
            freshness: { completeView: boolean };
          };
        }
      ).data;
    }

    const pierwsza = strona(null);
    expect(pierwsza.cases.map((entry) => entry.caseId)).toEqual(["ic_a"]);
    // Pierwsza strona nie ma jak niczego zgubic: zaczyna sie od czola listy.
    expect(pierwsza.snapshotChanged).toBe(false);
    expect(pierwsza.completeView).toBe(true);

    // Sprawa jeszcze NIEWYDANA dostaje wiadomosc i leci nad kursor: to
    // przewijanie juz jej nie pokaze.
    seedCase(runtime.store, { caseId: "ic_c", lastMessageAt: NOW + 5_000 });

    const druga = strona(pierwsza.nextCursor);
    expect(druga.snapshotChanged).toBe(true);
    /*
     * Kanal jest zdrowy i uzgodniony, wiec SAMO zdrowie mowi „komplet".
     * Odpowiedz mimo to nie ma prawa tak wygladac: w sklejonym wyniku brakuje
     * sprawy. Warstwa HTTP przelicza zdrowie z konfiguracji i musi zachowac
     * drugi warunek, a nie zastapic nim pierwszego.
     */
    expect(druga.freshness.completeView).toBe(true);
    expect(druga.completeView).toBe(false);
  });

  it("/health i freshness kolejki niosa TEN SAM kontrakt", () => {
    const runtime = runtimeWith({ tickIntervalMs: 60_000 });
    seedCase(runtime.store);
    recordSuccess(
      runtime.store,
      { key: { provider: "email", accountKey: "sklep" }, label: "E-mail sklep", active: true },
      NOW - 30 * 60_000,
    );

    const zdrowie = (
      handleInboxRead({
        runtime,
        path: "/internal/inbox/health",
        params: new URLSearchParams(),
        now: NOW,
        trustedChat: true,
      }).body as { data: Record<string, unknown> }
    ).data;
    const zKolejki = czytajKolejke(runtime, NOW).freshness;

    const zeSprawy = (
      handleInboxRead({
        runtime,
        path: "/internal/inbox/case",
        params: new URLSearchParams({ id: "ic_sprawa" }),
        now: NOW,
        trustedChat: true,
      }).body as { data: { freshness: Record<string, unknown> } }
    ).data.freshness;

    // Trzy sciezki odczytu, JEDEN obiekt zdrowia. Sprawa otwarta obok kolejki
    // nie moze mowic o kanale czegos innego niz lista.
    expect(zdrowie).toEqual(zKolejki);
    expect(zeSprawy).toEqual(zKolejki);
    expect(zdrowie.contractVersion).toBe("inbox-health-1");
  });
});

/**
 * Pola stanu HISTORII musza przejsc przez granice HTTP.
 *
 * Kontrola po naprawach zlapala, ze naprawa historii byla wyliczana, opisana
 * komentarzem obiecujacym rozroznienie, i gubiona w DTO. Dla odbiorcy „wyslano"
 * brzmialo wtedy tak samo dla watku kompletnego i dla takiego, ktorego wpisu
 * nie udalo sie odtworzyc — a to jest roznica miedzy sprawa zamknieta
 * a sprawa, ktora kolejna osoba obsluzy drugi raz.
 */
describe("stan historii dociera do odbiorcy", () => {
  it("reczne rozstrzygniecie raportuje NAPRAWE historii przez HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-historia-"));
    dirs.push(dir);
    const store = new InboxStore({ dir });
    seedCase(store);
    const runtime = createRuntime(config(), store);

    prepareAttempt({
      store,
      requestId: "req-historia-00000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-historia-00000001", NOW);
    finishSent(store, "req-historia-00000001", "ext-historia-1", NOW);
    // Awaria dokladnie tutaj: ledger juz `sent`, wpisu w watku jeszcze nie ma.

    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 300_000,
      body: {
        operation: "resolve_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT",
        requestId: "req-historia-00000001",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });

    expect(wynik.status).toBe(200);
    const dane = (wynik.body as { data?: Record<string, unknown> }).data ?? {};
    // Naprawa faktycznie sie wydarzyla I zostala ZGLOSZONA odbiorcy.
    expect(dane["repairedHistory"]).toBe(true);
    expect(dane["historyPresent"]).toBe(true);
    expect(dane["historyBlockedBy"]).toBeNull();

    // Wpis jest w watku takze po restarcie procesu.
    const poRestarcie = new InboxStore({ dir });
    const wychodzace = poRestarcie
      .messagesForCase("ic_sprawa")
      .filter((message) => message.direction === "outgoing");
    expect(wychodzace).toHaveLength(1);
  });

  it("powtorzone rozstrzygniecie nie dubluje wpisu i mowi, ze nie bylo czego naprawiac", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-historia2-"));
    dirs.push(dir);
    const store = new InboxStore({ dir });
    seedCase(store);
    const runtime = createRuntime(config(), store);

    prepareAttempt({
      store,
      requestId: "req-historia-00000002",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-historia-00000002", NOW);
    finishSent(store, "req-historia-00000002", "ext-historia-2", NOW);

    const cialo = {
      operation: "resolve_sent" as const,
      confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT" as const,
      requestId: "req-historia-00000002",
      caseId: "ic_sprawa",
      expectedLastIncomingMessageId: "mid:klient-1",
    };
    await handleInboxReply({ runtime, humanConfirmation: "confirmed", now: NOW + 300_000, body: cialo });
    const drugie = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 400_000,
      body: cialo,
    });

    const dane = (drugie.body as { data?: Record<string, unknown> }).data ?? {};
    expect(drugie.status).toBe(200);
    // Nic nowego do naprawy, ale historia JEST: to dwie rozne informacje.
    expect(dane["repairedHistory"]).toBe(false);
    expect(dane["historyPresent"]).toBe(true);
    expect(
      store.messagesForCase("ic_sprawa").filter((m) => m.direction === "outgoing"),
    ).toHaveLength(1);
  });
});
