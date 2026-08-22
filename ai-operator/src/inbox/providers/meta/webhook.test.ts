import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxStore } from "../../store.js";
import { ingestMetaEvents, reconcileMetaAccount } from "./ingest.js";
import {
  MetaWebhookPayload,
  metaSendWindow,
  metaVerificationChallenge,
  normalizeMetaPayload,
  verifyMetaSignature,
  type MetaAccount,
} from "./webhook.js";

const APP_SECRET = "tajny-sekret-aplikacji-meta";
const dirs: string[] = [];

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-meta-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const accounts: MetaAccount[] = [
  { provider: "facebook", accountKey: "1234567890", label: "Facebook" },
  { provider: "instagram", accountKey: "ig-999", label: "Instagram" },
];

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

function payload(entryId: string, messaging: unknown[]): string {
  return JSON.stringify({ object: "page", entry: [{ id: entryId, time: 1, messaging }] });
}

function incoming(mid: string, text = "Czy macie matche w puszce?", timestamp = 1_000) {
  return {
    sender: { id: "klient-77" },
    recipient: { id: "1234567890" },
    timestamp,
    message: { mid, text },
  };
}

describe("webhook Meta", () => {
  it("przyjmuje poprawny podpis i odrzuca zmieniony ladunek", () => {
    const body = payload("1234567890", [incoming("m_1")]);
    expect(verifyMetaSignature({ rawBody: body, header: sign(body), appSecret: APP_SECRET })).toBe(true);

    const tampered = body.replace("matche", "kawe");
    expect(verifyMetaSignature({ rawBody: tampered, header: sign(body), appSecret: APP_SECRET })).toBe(false);
    expect(verifyMetaSignature({ rawBody: body, header: null, appSecret: APP_SECRET })).toBe(false);
    expect(verifyMetaSignature({ rawBody: body, header: "sha1=abc", appSecret: APP_SECRET })).toBe(false);
    expect(verifyMetaSignature({ rawBody: body, header: sign(body), appSecret: "" })).toBe(false);
  });

  it("handshake weryfikacyjny wymaga dokladnego tokenu", () => {
    expect(
      metaVerificationChallenge({
        mode: "subscribe",
        token: "oczekiwany",
        challenge: "42",
        expectedToken: "oczekiwany",
      }),
    ).toBe("42");
    expect(
      metaVerificationChallenge({
        mode: "subscribe",
        token: "inny",
        challenge: "42",
        expectedToken: "oczekiwany",
      }),
    ).toBeNull();
    expect(
      metaVerificationChallenge({
        mode: "unsubscribe",
        token: "oczekiwany",
        challenge: "42",
        expectedToken: "oczekiwany",
      }),
    ).toBeNull();
  });

  it("powtorzony webhook nie tworzy drugiej wiadomosci", () => {
    const store = freshStore();
    const parsed = MetaWebhookPayload.parse(JSON.parse(payload("1234567890", [incoming("m_dup")])));
    const events = normalizeMetaPayload(parsed, accounts, 5_000);

    expect(ingestMetaEvents(store, events).stored).toBe(1);
    expect(ingestMetaEvents(store, events).duplicates).toBe(1);
    expect(store.allMessages()).toHaveLength(1);
  });

  it("zdarzenia w odwroconej kolejnosci daja ten sam stan sprawy", () => {
    const first = freshStore();
    const second = freshStore();
    const parsed = MetaWebhookPayload.parse(
      JSON.parse(
        payload("1234567890", [
          incoming("m_a", "Pierwsza wiadomosc", 1_000),
          incoming("m_b", "Druga wiadomosc", 2_000),
        ]),
      ),
    );
    const events = normalizeMetaPayload(parsed, accounts, 9_000);

    ingestMetaEvents(first, events);
    ingestMetaEvents(second, [...events].reverse());

    const a = first.listCases()[0]!;
    const b = second.listCases()[0]!;
    expect(a.caseId).toBe(b.caseId);
    expect(a.lastMessageAt).toBe(b.lastMessageAt);
    expect(a.lastIncomingMessageId).toBe(b.lastIncomingMessageId);
    expect(a.messageCount).toBe(b.messageCount);
  });

  it("echo wlasnej wiadomosci nie tworzy nowej sprawy ani wpisu przychodzacego", () => {
    const store = freshStore();
    const incomingEvents = normalizeMetaPayload(
      MetaWebhookPayload.parse(JSON.parse(payload("1234567890", [incoming("m_in")]))),
      accounts,
      1_000,
    );
    ingestMetaEvents(store, incomingEvents);
    const caseId = store.listCases()[0]!.caseId;

    const echoEvents = normalizeMetaPayload(
      MetaWebhookPayload.parse(
        JSON.parse(
          payload("1234567890", [
            {
              sender: { id: "1234567890" },
              recipient: { id: "klient-77" },
              timestamp: 2_000,
              message: { mid: "m_echo", text: "Juz wysylamy", is_echo: true },
            },
          ]),
        ),
      ),
      accounts,
      2_000,
    );
    const result = ingestMetaEvents(store, echoEvents);

    expect(result.echoes).toBe(1);
    expect(store.listCases()).toHaveLength(1);
    const echo = store.allMessages().find((message) => message.externalMessageId === "m_echo")!;
    expect(echo.direction).toBe("outgoing");
    expect(echo.caseId).toBe(caseId);
    // Po naszej odpowiedzi sprawa nie wymaga juz reakcji.
    expect(store.getCase(caseId)!.requiresResponse).toBe(false);
  });

  it("Instagram i Facebook maja rozdzielne sprawy mimo jednej aplikacji", () => {
    const store = freshStore();
    const fb = normalizeMetaPayload(
      MetaWebhookPayload.parse(JSON.parse(payload("1234567890", [incoming("m_fb")]))),
      accounts,
      1_000,
    );
    const igBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-999",
          time: 1,
          messaging: [
            {
              sender: { id: "klient-77" },
              recipient: { id: "ig-999" },
              timestamp: 1_000,
              message: { mid: "m_ig", text: "Czy macie matche w puszce?" },
            },
          ],
        },
      ],
    });
    const ig = normalizeMetaPayload(MetaWebhookPayload.parse(JSON.parse(igBody)), accounts, 1_000);

    ingestMetaEvents(store, fb);
    ingestMetaEvents(store, ig);

    const cases = store.listCases();
    expect(cases).toHaveLength(2);
    expect(new Set(cases.map((entry) => entry.provider))).toEqual(new Set(["facebook", "instagram"]));
  });

  it("nieznane konto nie zaklada sprawy", () => {
    const store = freshStore();
    const events = normalizeMetaPayload(
      MetaWebhookPayload.parse(JSON.parse(payload("obce-konto", [incoming("m_x")]))),
      accounts,
      1_000,
    );
    const result = ingestMetaEvents(store, events);
    expect(result.stored).toBe(0);
    expect(result.ignored).toBe(1);
  });

  it("uzgodnienie odzyskuje wiadomosc, ktorej webhook nie dostarczyl", async () => {
    const store = freshStore();
    const missing = normalizeMetaPayload(
      MetaWebhookPayload.parse(JSON.parse(payload("1234567890", [incoming("m_lost", "Zgubiona", 3_000)]))),
      accounts,
      3_000,
    )[0]!.message!;

    const result = await reconcileMetaAccount({
      store,
      account: accounts[0]!,
      sinceMs: 0,
      fetcher: { listConversations: async () => [missing] },
    });

    expect(result.stored).toBe(1);
    expect(store.allMessages()).toHaveLength(1);

    // Spozniony webhook z tym samym mid nie robi duplikatu.
    const late = normalizeMetaPayload(
      MetaWebhookPayload.parse(JSON.parse(payload("1234567890", [incoming("m_lost", "Zgubiona", 3_000)]))),
      accounts,
      4_000,
    );
    expect(ingestMetaEvents(store, late).duplicates).toBe(1);
    expect(store.allMessages()).toHaveLength(1);
  });

  it("potwierdzenia dostarczenia i odczytu nie tworza spraw", () => {
    const store = freshStore();
    const body = payload("1234567890", [
      { delivery: { mids: ["m_1"] } },
      { read: { watermark: 123 } },
    ]);
    const events = normalizeMetaPayload(MetaWebhookPayload.parse(JSON.parse(body)), accounts, 1_000);
    const result = ingestMetaEvents(store, events);

    expect(result.stored).toBe(0);
    expect(result.deliveries).toEqual(["m_1"]);
    expect(store.listCases()).toHaveLength(0);
  });

  it("okno wysylki zamyka sie po 24 h i po braku wiadomosci klienta", () => {
    const base = 1_700_000_000_000;
    expect(metaSendWindow(base, base + 60_000).open).toBe(true);
    expect(metaSendWindow(base, base + 25 * 3_600_000)).toEqual({
      open: false,
      expiresAt: base + 24 * 3_600_000,
      reason: "window_expired",
    });
    expect(metaSendWindow(null, base).reason).toBe("customer_never_wrote");
  });
});
