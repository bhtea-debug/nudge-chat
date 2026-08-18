import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FirmowyChatEvent,
  firmowyChatMessageId,
  ingestFirmowyChatEvent,
  verifyFirmowyChatSignature,
  type FirmowyChatEvent as FirmowyChatEventType,
} from "../src/chat/events.js";
import { CopilotStore } from "../src/state/store.js";

const fixturePath = new URL(
  "../fixtures/contracts/firmowy-chat-message-created-v1.json",
  import.meta.url,
);

function fixture(overrides: Partial<FirmowyChatEventType> = {}): FirmowyChatEventType {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const parsed = FirmowyChatEvent.parse(raw);
  return { ...parsed, ...overrides };
}

function store(): CopilotStore {
  return new CopilotStore({
    dir: mkdtempSync(join(tmpdir(), "bht-firmowy-chat-")),
    actor: "copilot",
  });
}

describe("kontrakt zdarzeń Czatu Firmowego", () => {
  it("przyjmuje wspólną fiksturę v1 i odrzuca dodatkowe pola", () => {
    expect(FirmowyChatEvent.safeParse(fixture()).success).toBe(true);
    expect(
      FirmowyChatEvent.safeParse({ ...fixture(), nieznanePole: "nie przejdzie" }).success,
    ).toBe(false);
  });

  it("weryfikuje HMAC dokładnych bajtów wraz ze znacznikiem czasu", () => {
    const secret = "s".repeat(48);
    const timestamp = "1787068800";
    const rawBody = JSON.stringify(fixture());
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const valid = {
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: `sha256=${signature}`,
      secret,
      nowMs: 1_787_068_800_000,
    };
    expect(verifyFirmowyChatSignature(valid)).toEqual({ ok: true });
    expect(verifyFirmowyChatSignature({ ...valid, rawBody: `${rawBody} ` })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      verifyFirmowyChatSignature({ ...valid, nowMs: valid.nowMs + 5 * 60 * 1000 + 1 }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(verifyFirmowyChatSignature({ ...valid, secret: null })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });
});

describe("ingest Czatu Firmowego", () => {
  it("tworzy pilną sprawę, zachowuje zakresy i zwraca dokładne issueId", () => {
    const s = store();
    const out = ingestFirmowyChatEvent(s, fixture());
    expect(out).toMatchObject({ accepted: true, outcome: "created" });
    expect(out.issueId).not.toBeNull();
    const issue = s.get(out.issueId!);
    expect(issue).toMatchObject({
      id: out.issueId,
      source: "firmowy_chat",
      category: "urgent",
      priority: "high",
      status: "needs_attention",
      notificationCandidate: true,
      relatedOrderRefs: ["2307348"],
    });
    expect(issue!.sourceRefs[0]).toMatchObject({
      kind: "firmowy_chat",
      aiAccess: "basic",
      scopeKeys: expect.arrayContaining([
        "conversation:conv_operacje",
        "department:biuro",
      ]),
    });
  });

  it("jest idempotentny", () => {
    const s = store();
    const first = ingestFirmowyChatEvent(s, fixture());
    const second = ingestFirmowyChatEvent(s, fixture());
    expect(second).toMatchObject({ outcome: "duplicate", issueId: first.issueId });
    expect(s.all()).toHaveLength(1);
  });

  it("pomija zwykłą rozmowę bez sygnału operacyjnego", () => {
    const s = store();
    const base = fixture();
    const event = fixture({
      eventId: "firmowy-chat:message:smalltalk",
      source: { ...base.source, messageId: "smalltalk" },
      message: {
        body: "Dziękuję, do zobaczenia jutro",
        importance: "normal",
        attachments: [],
      },
    });
    expect(ingestFirmowyChatEvent(s, event)).toMatchObject({
      outcome: "ignored",
      issueId: null,
    });
    expect(s.all()).toEqual([]);
    expect(s.hasSeen(firmowyChatMessageId(event.source.conversationId, "smalltalk"))).toBe(true);
  });

  it("odpowiedź w kanale scala się tylko przez jawne replyTo, nie przez sam kanał", () => {
    const s = store();
    const first = ingestFirmowyChatEvent(s, fixture());
    const base = fixture();
    const reply = fixture({
      eventId: "firmowy-chat:message:reply",
      source: { ...base.source, messageId: "reply" },
      message: {
        body: "Etykiety już dojechały",
        importance: "normal",
        replyToMessageId: base.source.messageId,
        attachments: [],
      },
    });
    expect(ingestFirmowyChatEvent(s, reply)).toMatchObject({
      outcome: "merged",
      issueId: first.issueId,
    });
    expect(s.all()).toHaveLength(1);
    expect(s.get(first.issueId!)!.sourceRefs).toHaveLength(2);
  });
});
