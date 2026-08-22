import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSIFIER_VERSION, type InboxMessage } from "../contract.js";
import { InboxStore, type StoredCase } from "../store.js";
import {
  applyDeliveryEvent,
  cancelPrepared,
  deriveIdempotencyKey,
  prepareAttempt,
  resolveUncertain,
} from "./ledger.js";
import { sendReply, type SendTransport } from "./send.js";
import { replySubject, sendViaResend, threadingHeaders } from "./resend.js";
import { sendViaMeta } from "./meta-send.js";
import { WebhookDedup, resendDeliveryState, verifyResendWebhook } from "./webhooks.js";

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-out-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

function transport(result: Awaited<ReturnType<SendTransport["send"]>>, calls: string[] = []): SendTransport {
  return {
    send: async (attempt) => {
      calls.push(attempt.idempotencyKey);
      return result;
    },
  };
}

const baseRequest = (store: InboxStore) => ({
  store,
  requestId: "req-0000000000000001",
  caseId: "ic_sprawa",
  text: "Zamowienie wyszlo dzisiaj, numer nadania w mailu.",
  expectedLastIncomingMessageId: "mid:klient-1" as string | null,
  now: () => NOW,
});

describe("wysylka odpowiedzi", () => {
  it("zapisuje ledger przed pierwszym requestem", async () => {
    const store = freshStore();
    seedCase(store);
    let ledgerAtRequest: string | null = null;

    const result = await sendReply({
      ...baseRequest(store),
      transport: {
        send: async (attempt) => {
          ledgerAtRequest = store.getAttempt(attempt.requestId)?.status ?? null;
          return { status: "sent", externalMessageId: "resend-1" };
        },
      },
    });

    expect(ledgerAtRequest).toBe("sending");
    expect(result.status).toBe("sent");
    expect(store.getAttempt("req-0000000000000001")?.status).toBe("sent");
  });

  it("dwa rownolegle requestId nie wykonaja dwoch POSTow", async () => {
    const store = freshStore();
    seedCase(store);
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow: SendTransport = {
      send: async (attempt) => {
        calls.push(attempt.requestId);
        await gate;
        return { status: "sent", externalMessageId: "resend-1" };
      },
    };

    const first = sendReply({ ...baseRequest(store), transport: slow });
    // Drugie zadanie startuje, gdy pierwsze jest juz w stanie sending.
    await Promise.resolve();
    const second = await sendReply({
      ...baseRequest(store),
      requestId: "req-0000000000000002",
      transport: slow,
    });

    release();
    const firstResult = await first;

    expect(firstResult.status).toBe("sent");
    expect(second.status).toBe("rejected");
    expect(second).toMatchObject({ code: "active_attempt_exists" });
    expect(calls).toEqual(["req-0000000000000001"]);
  });

  it("nowa wiadomosc klienta uniewaznia przygotowana odpowiedz", async () => {
    const store = freshStore();
    seedCase(store);
    const result = await sendReply({
      ...baseRequest(store),
      expectedLastIncomingMessageId: "mid:stary-marker",
      transport: transport({ status: "sent", externalMessageId: "x" }),
    });
    expect(result).toMatchObject({ status: "rejected", code: "stale_marker" });
  });

  it("wiadomosc klienta miedzy potwierdzeniem a POSTem blokuje wysylke", async () => {
    const store = freshStore();
    seedCase(store);
    const calls: string[] = [];

    const result = await sendReply({
      ...baseRequest(store),
      transport: {
        send: async (attempt) => {
          calls.push(attempt.requestId);
          return { status: "sent", externalMessageId: "x" };
        },
      },
      // Marker zmienia sie po przygotowaniu, ale przed brama wysylki.
      now: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return NOW;
          }
          seedCase(store, { lastIncomingMessageId: "mid:klient-2", lastIncomingAt: NOW });
          return NOW + 1;
        };
      })(),
    });

    expect(result).toMatchObject({ status: "failed", code: "stale_marker" });
    expect(calls).toEqual([]);
  });

  it("ten sam requestId zwraca pierwotny wynik zamiast drugiej wysylki", async () => {
    const store = freshStore();
    seedCase(store);
    const calls: string[] = [];
    const once = transport({ status: "sent", externalMessageId: "resend-1" }, calls);

    const first = await sendReply({ ...baseRequest(store), transport: once });
    const repeat = await sendReply({ ...baseRequest(store), transport: once });

    expect(first.status).toBe("sent");
    expect(repeat).toMatchObject({ status: "sent", externalMessageId: "resend-1" });
    expect(calls).toHaveLength(1);
  });

  it("ten sam requestId z INNA trescia jest odrzucany", async () => {
    const store = freshStore();
    seedCase(store);
    await sendReply({ ...baseRequest(store), transport: transport({ status: "sent", externalMessageId: "a" }) });

    const other = await sendReply({
      ...baseRequest(store),
      text: "Zupelnie inna tresc odpowiedzi",
      transport: transport({ status: "sent", externalMessageId: "b" }),
    });
    expect(other).toMatchObject({ status: "rejected", code: "request_id_reused" });
  });

  it("klucz idempotencji jest deterministyczny i nie zmienia sie przy ponowieniu", () => {
    const a = deriveIdempotencyKey("req-1", "ic_1", "sha-1");
    const b = deriveIdempotencyKey("req-1", "ic_1", "sha-1");
    const c = deriveIdempotencyKey("req-2", "ic_1", "sha-1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("timeout daje uncertain i zero automatycznych ponowien", async () => {
    const store = freshStore();
    seedCase(store);
    const calls: string[] = [];
    const result = await sendReply({
      ...baseRequest(store),
      transport: transport({ status: "uncertain", code: "timeout", message: "brak potwierdzenia" }, calls),
    });

    expect(result).toMatchObject({ status: "uncertain", code: "timeout" });
    expect(calls).toHaveLength(1);
    expect(store.getAttempt("req-0000000000000001")?.status).toBe("uncertain");

    // Niepewna proba trzyma blokade: inny requestId nie moze wystartowac.
    const another = await sendReply({
      ...baseRequest(store),
      requestId: "req-0000000000000009",
      transport: transport({ status: "sent", externalMessageId: "x" }),
    });
    expect(another).toMatchObject({ status: "rejected", code: "active_attempt_exists" });
  });

  it("wyjatek transportu jest niepewny, nie nieudany", async () => {
    const store = freshStore();
    seedCase(store);
    const result = await sendReply({
      ...baseRequest(store),
      transport: {
        send: async () => {
          throw new Error("ECONNRESET");
        },
      },
    });
    expect(result).toMatchObject({ status: "uncertain", code: "transport_exception" });
  });

  it("Wroc do edycji anuluje tylko stan prepared", () => {
    const store = freshStore();
    seedCase(store);
    const prepared = prepareAttempt({
      store,
      requestId: "req-prep-000000000001",
      caseId: "ic_sprawa",
      text: "Szkic",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    expect(prepared.ok).toBe(true);

    expect(cancelPrepared(store, "req-prep-000000000001", NOW)).toEqual({ ok: true, code: null });
    // Po anulowaniu nie ma niewidzialnej blokady.
    expect(store.activeAttemptForCase("ic_sprawa")).toBeNull();

    const second = prepareAttempt({
      store,
      requestId: "req-prep-000000000002",
      caseId: "ic_sprawa",
      text: "Szkic",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    expect(second.ok).toBe(true);
  });

  it("stanu uncertain nie da sie anulowac przyciskiem edycji", async () => {
    const store = freshStore();
    seedCase(store);
    await sendReply({
      ...baseRequest(store),
      transport: transport({ status: "uncertain", code: "timeout", message: "x" }),
    });
    expect(cancelPrepared(store, "req-0000000000000001", NOW).ok).toBe(false);
    expect(store.activeAttemptForCase("ic_sprawa")).not.toBeNull();
  });

  it("reczne rozstrzygniecie wymaga odczekania i nie wymysla czasu wiadomosci", async () => {
    const store = freshStore();
    seedCase(store);
    await sendReply({
      ...baseRequest(store),
      transport: transport({ status: "uncertain", code: "timeout", message: "x" }),
    });

    expect(resolveUncertain(store, "req-0000000000000001", "sent", NOW + 1_000)).toMatchObject({
      ok: false,
      code: "too_early",
    });

    const resolved = resolveUncertain(store, "req-0000000000000001", "sent", NOW + 200_000);
    expect(resolved.ok).toBe(true);
    const attempt = store.getAttempt("req-0000000000000001")!;
    expect(attempt.status).toBe("sent");
    // Czas rozstrzygniecia, nie czas rzekomej wysylki.
    expect(attempt.completedAt).toBe(NOW + 200_000);
    expect(attempt.externalMessageId).toBeNull();
  });
});

describe("Resend", () => {
  it("uzywa wlasciwego nadawcy i naglowkow watkowania", async () => {
    const store = freshStore();
    seedCase(store);
    const prepared = prepareAttempt({
      store,
      requestId: "req-resend-0000000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare failed");

    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ id: "resend-42" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const original: InboxMessage = {
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
      rfcReferences: ["root@example.com"],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp",
    };

    const result = await sendViaResend({
      apiKey: "re_test",
      mailbox: { accountKey: "sklep", fromAddress: "sklep@brownhouseandtea.pl", fromName: "Brown House & Tea" },
      to: "klient@example.com",
      subject: replySubject("Zamowienie 4411"),
      text: "Odpowiedz",
      attempt: prepared.attempt,
      inReplyTo: original,
      fetchImpl: fakeFetch,
    });

    expect(result).toEqual({ status: "sent", externalMessageId: "resend-42" });
    const body = JSON.parse(String(captured.init?.body));
    expect(body.from).toBe("Brown House & Tea <sklep@brownhouseandtea.pl>");
    expect(body.reply_to).toBe("sklep@brownhouseandtea.pl");
    expect(body.subject).toBe("Re: Zamowienie 4411");
    expect(body.headers["In-Reply-To"]).toBe("<klient-1@example.com>");
    expect(body.headers.References).toBe("<root@example.com> <klient-1@example.com>");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(prepared.attempt.idempotencyKey);
  });

  it("kazda skrzynka odpowiada z wlasnego adresu", () => {
    for (const key of ["sklep", "biuro", "hurt"]) {
      const headers = threadingHeaders(null);
      expect(headers).toEqual({});
      expect(`${key}@brownhouseandtea.pl`).toMatch(/^(sklep|biuro|hurt)@brownhouseandtea\.pl$/);
    }
  });

  it("5xx jest niepewne, 4xx jest bledem", async () => {
    const store = freshStore();
    seedCase(store);
    const prepared = prepareAttempt({
      store,
      requestId: "req-resend-0000000002",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare failed");

    const make = (status: number) =>
      (async () => new Response("{}", { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const base = {
      apiKey: "re_test",
      mailbox: { accountKey: "sklep", fromAddress: "sklep@brownhouseandtea.pl", fromName: null },
      to: "klient@example.com",
      subject: "Re: x",
      text: "Odpowiedz",
      attempt: prepared.attempt,
      inReplyTo: null,
    };

    expect((await sendViaResend({ ...base, fetchImpl: make(503) })).status).toBe("uncertain");
    expect((await sendViaResend({ ...base, fetchImpl: make(422) })).status).toBe("failed");
  });

  it("200 bez identyfikatora jest niepewne, a nie udane", async () => {
    const store = freshStore();
    seedCase(store);
    const prepared = prepareAttempt({
      store,
      requestId: "req-resend-0000000003",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare failed");

    const result = await sendViaResend({
      apiKey: "re_test",
      mailbox: { accountKey: "sklep", fromAddress: "sklep@brownhouseandtea.pl", fromName: null },
      to: "klient@example.com",
      subject: "Re: x",
      text: "Odpowiedz",
      attempt: prepared.attempt,
      inReplyTo: null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: "uncertain", code: "missing_id" });
  });
});

describe("webhook Resend", () => {
  const secret = `whsec_${Buffer.from("bardzo-tajny-sekret-webhooka").toString("base64")}`;

  function sign(id: string, timestamp: string, body: string): string {
    const bytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const digest = createHmac("sha256", bytes).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
    return `v1,${digest}`;
  }

  it("przyjmuje poprawny podpis i odrzuca podmieniony ladunek", () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "resend-42" } });
    const timestamp = String(Math.floor(NOW / 1_000));
    const ok = verifyResendWebhook({
      rawBody: body,
      svixId: "msg_1",
      svixTimestamp: timestamp,
      svixSignature: sign("msg_1", timestamp, body),
      secret,
      now: NOW,
    });
    expect(ok).toBe(true);

    expect(
      verifyResendWebhook({
        rawBody: body.replace("delivered", "bounced"),
        svixId: "msg_1",
        svixTimestamp: timestamp,
        svixSignature: sign("msg_1", timestamp, body),
        secret,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("odrzuca podpis spoza okna czasowego", () => {
    const body = "{}";
    const oldTimestamp = String(Math.floor((NOW - 60 * 60_000) / 1_000));
    expect(
      verifyResendWebhook({
        rawBody: body,
        svixId: "msg_2",
        svixTimestamp: oldTimestamp,
        svixSignature: sign("msg_2", oldTimestamp, body),
        secret,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("mapuje zdarzenia na stany dostarczenia", () => {
    expect(resendDeliveryState("email.delivered")).toBe("delivered");
    expect(resendDeliveryState("email.bounced")).toBe("bounced");
    expect(resendDeliveryState("email.complained")).toBe("complained");
    expect(resendDeliveryState("email.sent")).toBeNull();
  });

  it("powtorzony webhook jest deduplikowany", () => {
    const dedup = new WebhookDedup();
    expect(dedup.accept("msg_1", NOW)).toBe(true);
    expect(dedup.accept("msg_1", NOW + 10)).toBe(false);
    expect(dedup.accept("msg_2", NOW + 10)).toBe(true);
  });

  it("zdarzenie dostarczenia aktualizuje ledger po identyfikatorze dostawcy", async () => {
    const store = freshStore();
    seedCase(store);
    await sendReply({
      ...baseRequest(store),
      transport: transport({ status: "sent", externalMessageId: "resend-42" }),
    });

    expect(applyDeliveryEvent(store, { externalMessageId: "resend-42" }, "delivered")).toBe(true);
    expect(store.getAttempt("req-0000000000000001")?.deliveryState).toBe("delivered");
    // Powtorka nie zmienia nic drugi raz.
    expect(applyDeliveryEvent(store, { externalMessageId: "resend-42" }, "delivered")).toBe(false);
  });
});

describe("Meta Send API", () => {
  const store = freshStore();
  seedCase(store, { caseId: "ic_meta", provider: "facebook", accountKey: "1234567890" });
  const prepared = prepareAttempt({
    store,
    requestId: "req-meta-000000000001",
    caseId: "ic_meta",
    text: "Juz sprawdzam",
    expectedLastIncomingMessageId: "mid:klient-1",
    now: NOW,
  });

  const attempt = prepared.ok ? prepared.attempt : null;

  it("wygasle okno blokuje wysylke przed jakimkolwiek requestem", async () => {
    const spy = vi.fn();
    const result = await sendViaMeta({
      account: { provider: "facebook", accountKey: "1234567890", pageId: "1234567890", accessToken: "token" },
      recipientId: "klient-77",
      text: "Juz sprawdzam",
      attempt: attempt!,
      lastIncomingAt: NOW - 25 * 3_600_000,
      now: NOW,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: "failed", code: "window_expired" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("5xx nie powoduje drugiej wysylki", async () => {
    let calls = 0;
    const result = await sendViaMeta({
      account: { provider: "facebook", accountKey: "1234567890", pageId: "1234567890", accessToken: "token" },
      recipientId: "klient-77",
      text: "Juz sprawdzam",
      attempt: attempt!,
      lastIncomingAt: NOW - 1_000,
      now: NOW,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 502, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe("uncertain");
    expect(calls).toBe(1);
  });

  it("wygasly token daje jasny stan reconnect", async () => {
    const result = await sendViaMeta({
      account: { provider: "instagram", accountKey: "ig-999", pageId: "page-555", accessToken: "token" },
      recipientId: "klient-77",
      text: "Juz sprawdzam",
      attempt: attempt!,
      lastIncomingAt: NOW - 1_000,
      now: NOW,
      fetchImpl: (async () =>
        new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: "failed", code: "reconnect_required" });
  });
});
