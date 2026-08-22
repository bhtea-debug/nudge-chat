import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxStore, type OutboundAttempt } from "../store.js";
import { applyDeliveryEvent } from "./ledger.js";
import { sendViaResend } from "./resend.js";
import { sendViaMeta } from "./meta-send.js";

/**
 * Stany dostarczenia i niejednoznaczne odpowiedzi dostawcy.
 *
 * Dwa problemy z przeglądu:
 *  1. deduplikacja webhooków żyła w pamięci procesu, więc restart pozwalał
 *     przetworzyć to samo zdarzenie drugi raz,
 *  2. wszystko poniżej 500 było traktowane jako pewne niewysłanie, choć
 *     408, 425 i 429 potrafią przyjść już PO przyjęciu wiadomości.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-delivery-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function attempt(store: InboxStore, overrides: Partial<OutboundAttempt> = {}): OutboundAttempt {
  const value: OutboundAttempt = {
    requestId: "req-delivery-00000001",
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    contentSha256: "a".repeat(64),
    contentLength: 10,
    expectedLastIncomingMessageId: "mid:1",
    expectedLastIncomingAt: NOW,
    idempotencyKey: "key",
    status: "sent",
    externalMessageId: "resend-1",
    postStartedAt: NOW,
    completedAt: NOW,
    failureCode: null,
    createdAt: NOW,
    deliveryState: "unknown",
    ...overrides,
  };
  store.putAttempt(value);
  return value;
}

describe("monotoniczne stany dostarczenia", () => {
  it("stan idzie w gore: unknown -> delivered", () => {
    const store = freshStore();
    attempt(store);
    expect(applyDeliveryEvent(store, { externalMessageId: "resend-1" }, "delivered")).toBe(true);
    expect(store.getAttempt("req-delivery-00000001")?.deliveryState).toBe("delivered");
  });

  it("spoznione delivered NIE kasuje informacji o odbiciu", () => {
    const store = freshStore();
    attempt(store, { deliveryState: "bounced" });
    // Webhooki przychodzą poza kolejnością: dostawca ponawia starsze zdarzenie.
    expect(applyDeliveryEvent(store, { externalMessageId: "resend-1" }, "delivered")).toBe(false);
    expect(store.getAttempt("req-delivery-00000001")?.deliveryState).toBe("bounced");
  });

  it("skarga po dostarczeniu jest przyjmowana", () => {
    const store = freshStore();
    attempt(store, { deliveryState: "delivered" });
    expect(applyDeliveryEvent(store, { externalMessageId: "resend-1" }, "complained")).toBe(true);
  });

  it("powtorzone to samo zdarzenie nic nie zmienia", () => {
    const store = freshStore();
    attempt(store, { deliveryState: "delivered" });
    expect(applyDeliveryEvent(store, { externalMessageId: "resend-1" }, "delivered")).toBe(false);
  });
});

describe("trwala deduplikacja webhookow", () => {
  it("to samo zdarzenie jest odrzucane takze PO restarcie", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-dedup-"));
    dirs.push(dir);

    const before = new InboxStore({ dir });
    expect(before.acceptWebhook("msg_1", NOW)).toBe(true);
    expect(before.acceptWebhook("msg_1", NOW + 10)).toBe(false);
    before.close();

    // Restart procesu: pamięć znika, dziennik zostaje.
    const after = new InboxStore({ dir });
    expect(after.acceptWebhook("msg_1", NOW + 1_000)).toBe(false);
    expect(after.acceptWebhook("msg_2", NOW + 1_000)).toBe(true);
  });

  it("po wygasnieciu okna zdarzenie moze zostac przyjete ponownie", () => {
    const store = freshStore();
    expect(store.acceptWebhook("msg_x", NOW, 1_000)).toBe(true);
    expect(store.acceptWebhook("msg_x", NOW + 500, 1_000)).toBe(false);
    expect(store.acceptWebhook("msg_x", NOW + 5_000, 1_000)).toBe(true);
  });
});

describe("niejednoznaczne odpowiedzi dostawcy", () => {
  const store = freshStore();
  const sample = attempt(store, { requestId: "req-ambiguous-0000001", status: "sending" });

  const resendBase = {
    apiKey: "re_test",
    mailbox: { accountKey: "sklep", fromAddress: "sklep@brownhouseandtea.pl", fromName: null },
    to: "klient@example.com",
    subject: "Re: x",
    text: "Odpowiedz",
    attempt: sample,
    inReplyTo: null,
  };

  const status = (code: number) =>
    (async () =>
      new Response("{}", { status: code, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("Resend: 408, 425 i 429 sa NIEPEWNE, nie nieudane", async () => {
    for (const code of [408, 425, 429]) {
      const result = await sendViaResend({ ...resendBase, fetchImpl: status(code) });
      expect(result.status, `kod ${code}`).toBe("uncertain");
    }
  });

  it("Resend: 422 pozostaje pewna porazka", async () => {
    const result = await sendViaResend({ ...resendBase, fetchImpl: status(422) });
    expect(result.status).toBe("failed");
  });

  it("Meta: 429 jest niepewne, bo limit bywa naliczany po przyjeciu", async () => {
    const result = await sendViaMeta({
      account: { provider: "facebook", accountKey: "page-1", pageId: "page-1", accessToken: "t" },
      recipientId: "klient-77",
      text: "Odpowiedz",
      attempt: sample,
      lastIncomingAt: NOW - 1_000,
      now: NOW,
      fetchImpl: status(429),
    });
    expect(result).toMatchObject({ status: "uncertain", code: "rate_limited" });
  });

  it("Meta: 400 pozostaje pewna porazka", async () => {
    const result = await sendViaMeta({
      account: { provider: "facebook", accountKey: "page-1", pageId: "page-1", accessToken: "t" },
      recipientId: "klient-77",
      text: "Odpowiedz",
      attempt: sample,
      lastIncomingAt: NOW - 1_000,
      now: NOW,
      fetchImpl: status(400),
    });
    expect(result.status).toBe("failed");
  });
});
