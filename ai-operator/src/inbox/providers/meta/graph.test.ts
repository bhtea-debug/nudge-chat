import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxStore, type StoredCase } from "../../store.js";
import { sendViaMeta } from "../../outbound/meta-send.js";
import { prepareAttempt } from "../../outbound/ledger.js";
import { CLASSIFIER_VERSION } from "../../contract.js";
import { fetchConversations, GraphError, type GraphAccount } from "./graph.js";
import { ingestMetaEvents } from "./ingest.js";
import { MetaWebhookPayload, normalizeMetaPayload } from "./webhook.js";

/**
 * Uzgodnienie Meta przez Graph API.
 *
 * Poprzednia wersja zapisywała sukces źródła tylko dlatego, że konto było
 * skonfigurowane: kropka świeciła na zielono, nie wykonawszy ani jednego
 * odczytu. Tutaj zielone światło daje wyłącznie prawdziwy odczyt.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-graph-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const facebook: GraphAccount = {
  provider: "facebook",
  accountKey: "page-123",
  pageId: "page-123",
  label: "Facebook",
  accessToken: "token",
};

const instagram: GraphAccount = {
  provider: "instagram",
  // Webhooki przychodzą z identyfikatorem KONTA Instagram...
  accountKey: "ig-999",
  // ...ale API woła się pod adresem POŁĄCZONEJ STRONY.
  pageId: "page-123",
  label: "Instagram",
  accessToken: "token",
};

function conversationsPayload(messages: unknown[], next?: string) {
  return {
    data: [
      {
        id: "conv-1",
        updated_time: "2026-08-20T10:00:00+0000",
        participants: { data: [{ id: "page-123" }, { id: "klient-77" }] },
        messages: { data: messages },
      },
    ],
    ...(next ? { paging: { next } } : {}),
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("odczyt rozmow z Graph API", () => {
  it("pyta o wlasciwa platforme i wlasciwy identyfikator", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return jsonResponse(conversationsPayload([]));
    }) as unknown as typeof fetch;

    await fetchConversations({ account: facebook, sinceMs: 0, now: NOW, fetchImpl: fakeFetch });
    await fetchConversations({ account: instagram, sinceMs: 0, now: NOW, fetchImpl: fakeFetch });

    expect(urls[0]).toContain("/page-123/conversations");
    expect(urls[0]).toContain("platform=messenger");
    expect(urls[1]).toContain("platform=instagram");
    // Instagram NIE jest wołany pod identyfikatorem konta IG.
    expect(urls[1]).toContain("/page-123/conversations");
    expect(urls[1]).not.toContain("/ig-999/conversations");
  });

  it("wysylka Instagrama idzie pod PAGE ID, a nie pod konto IG", async () => {
    const store = freshStore();
    const record: StoredCase = {
      caseId: "ic_ig",
      provider: "instagram",
      accountKey: "ig-999",
      externalConversationId: "klient-77",
      subject: null,
      participantLabel: null,
      orderRef: null,
      firstSeenAt: NOW - 1_000,
      lastMessageAt: NOW - 1_000,
      lastIncomingMessageId: "m_1",
      lastIncomingAt: NOW - 1_000,
      messageCount: 1,
      requiresResponse: true,
      pendingAction: false,
      classifierVersion: CLASSIFIER_VERSION,
      classificationReason: "customer_message",
      needsReview: false,
      sourceClosed: false,
      hasAttachments: false,
    };
    store.upsertCase(record);
    const prepared = prepareAttempt({
      store,
      requestId: "req-ig-0000000000001",
      caseId: "ic_ig",
      text: "Juz sprawdzam",
      expectedLastIncomingMessageId: "m_1",
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare failed");

    let calledUrl = "";
    await sendViaMeta({
      account: { provider: "instagram", accountKey: "ig-999", pageId: "page-123", accessToken: "t" },
      recipientId: "klient-77",
      text: "Juz sprawdzam",
      attempt: prepared.attempt,
      lastIncomingAt: NOW - 1_000,
      now: NOW,
      fetchImpl: (async (url: string) => {
        calledUrl = url;
        return jsonResponse({ message_id: "m_out" });
      }) as unknown as typeof fetch,
    });

    expect(calledUrl).toContain("/page-123/messages");
    expect(calledUrl).not.toContain("/ig-999/messages");
  });

  it("odzyskuje wiadomosc, ktorej webhook nie dostarczyl", async () => {
    const store = freshStore();
    const result = await fetchConversations({
      account: facebook,
      sinceMs: 0,
      now: NOW,
      fetchImpl: (async () =>
        jsonResponse(
          conversationsPayload([
            {
              id: "m_lost",
              message: "Gdzie moja paczka?",
              created_time: "2026-08-20T10:00:00+0000",
              from: { id: "klient-77" },
            },
          ]),
        )) as unknown as typeof fetch,
    });

    const ingested = ingestMetaEvents(
      store,
      result.messages.map((message) => ({ kind: "message" as const, message })),
    );
    expect(ingested.stored).toBe(1);
    expect(store.listCases()).toHaveLength(1);

    // Spozniony webhook z tym samym mid nie robi duplikatu.
    const late = normalizeMetaPayload(
      MetaWebhookPayload.parse({
        object: "page",
        entry: [
          {
            id: "page-123",
            time: 1,
            messaging: [
              {
                sender: { id: "klient-77" },
                recipient: { id: "page-123" },
                timestamp: NOW,
                message: { mid: "m_lost", text: "Gdzie moja paczka?" },
              },
            ],
          },
        ],
      }),
      [facebook],
      NOW,
    );
    expect(ingestMetaEvents(store, late).duplicates).toBe(1);
    expect(store.allMessages()).toHaveLength(1);
  });

  it("nasza wiadomosc z uzgodnienia jest wychodzaca i sklei sie z echem", async () => {
    const store = freshStore();
    const result = await fetchConversations({
      account: facebook,
      sinceMs: 0,
      now: NOW,
      fetchImpl: (async () =>
        jsonResponse(
          conversationsPayload([
            {
              id: "m_ours",
              message: "Juz wysylamy",
              created_time: "2026-08-20T11:00:00+0000",
              from: { id: "page-123" },
            },
          ]),
        )) as unknown as typeof fetch,
    });

    expect(result.messages[0]!.direction).toBe("outgoing");
    expect(result.messages[0]!.isEcho).toBe(true);
    expect(result.messages[0]!.externalConversationId).toBe("klient-77");
    ingestMetaEvents(store, [{ kind: "message", message: result.messages[0]! }]);
    expect(store.allMessages()).toHaveLength(1);
  });

  it("wiadomosci starsze od okna nie sa pobierane", async () => {
    const result = await fetchConversations({
      account: facebook,
      sinceMs: Date.parse("2026-08-19T00:00:00+0000"),
      now: NOW,
      fetchImpl: (async () =>
        jsonResponse(
          conversationsPayload([
            { id: "m_old", message: "Stare", created_time: "2026-01-01T10:00:00+0000", from: { id: "klient-77" } },
            { id: "m_new", message: "Nowe", created_time: "2026-08-20T10:00:00+0000", from: { id: "klient-77" } },
          ]),
        )) as unknown as typeof fetch,
    });
    expect(result.messages.map((message) => message.externalMessageId)).toEqual(["m_new"]);
  });

  it("stronicowanie ma sufit i mowi o niepelnosci", async () => {
    let calls = 0;
    const result = await fetchConversations({
      account: facebook,
      sinceMs: 0,
      now: NOW,
      maxPages: 2,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(conversationsPayload([], "https://graph.facebook.com/next-page"));
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("wygasly token daje jasny, rozpoznawalny blad", async () => {
    await expect(
      fetchConversations({
        account: facebook,
        sinceMs: 0,
        now: NOW,
        fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(GraphError);

    try {
      await fetchConversations({
        account: facebook,
        sinceMs: 0,
        now: NOW,
        fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
      });
    } catch (error) {
      expect((error as GraphError).code).toBe("reconnect_required");
    }
  });

  it("ograniczenie tempa jest odrozniane od awarii", async () => {
    try {
      await fetchConversations({
        account: facebook,
        sinceMs: 0,
        now: NOW,
        fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
      });
      throw new Error("mialo rzucic");
    } catch (error) {
      expect((error as GraphError).code).toBe("rate_limited");
    }
  });
});
