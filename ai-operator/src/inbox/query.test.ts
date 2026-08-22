import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "./contract.js";
import { recordFailure, recordSuccess } from "./health.js";
import { queryQueue } from "./query.js";
import { InboxStore, type StoredCase } from "./store.js";

/**
 * Stronicowanie kolejki.
 *
 * Powód istnienia: odbiorca brał 300 rekordów i raportował widok jako pełny.
 * Firma z czterystoma sprawami widziała trzysta i nie miała jak się dowiedzieć,
 * że setka zniknęła.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-query-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: InboxStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const record: StoredCase = {
      caseId: `ic_${String(index).padStart(4, "0")}`,
      provider: "email",
      accountKey: "sklep",
      externalConversationId: `conv-${index}`,
      subject: null,
      participantLabel: null,
      orderRef: null,
      firstSeenAt: NOW - index * 1_000,
      lastMessageAt: NOW - index * 1_000,
      lastIncomingMessageId: `mid:${index}`,
      lastIncomingAt: NOW - index * 1_000,
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
  }
}

function drain(store: InboxStore, pageSize: number): { ids: string[]; pages: number } {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (; pages < 50; pages += 1) {
    const page = queryQueue(store, { now: NOW, state: "all", limit: pageSize, cursor });
    ids.push(...page.cases.map((entry) => entry.caseId));
    if (!page.truncated) {
      pages += 1;
      break;
    }
    expect(page.nextCursor).toBeTruthy();
    cursor = page.nextCursor;
  }
  return { ids, pages };
}

describe("stronicowanie kolejki", () => {
  it("ponad 300 spraw przechodzi w całości, bez luk i duplikatów", () => {
    const store = freshStore();
    seed(store, 437);

    const { ids } = drain(store, 200);
    expect(ids).toHaveLength(437);
    expect(new Set(ids).size).toBe(437);
  });

  it("pierwsza strona jawnie mówi, że nie jest całością", () => {
    const store = freshStore();
    seed(store, 437);

    const page = queryQueue(store, { now: NOW, state: "all", limit: 200 });
    expect(page.cases).toHaveLength(200);
    expect(page.count).toBe(437);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  });

  it("ostatnia strona zamyka listę kursorem null", () => {
    const store = freshStore();
    seed(store, 250);

    const first = queryQueue(store, { now: NOW, state: "all", limit: 200 });
    const second = queryQueue(store, {
      now: NOW,
      state: "all",
      limit: 200,
      cursor: first.nextCursor,
    });
    expect(second.cases).toHaveLength(50);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("sprawy o identycznym czasie nie gubią się między stronami", () => {
    const store = freshStore();
    for (let index = 0; index < 10; index += 1) {
      store.upsertCase({
        caseId: `ic_same_${index}`,
        provider: "email",
        accountKey: "sklep",
        externalConversationId: `conv-${index}`,
        subject: null,
        participantLabel: null,
        orderRef: null,
        firstSeenAt: NOW,
        // Ten sam czas dla wszystkich: bez całkowitego porządku kursor
        // przeskakiwałby rekordy.
        lastMessageAt: NOW,
        lastIncomingMessageId: `mid:${index}`,
        lastIncomingAt: NOW,
        messageCount: 1,
        requiresResponse: true,
        pendingAction: false,
        classifierVersion: CLASSIFIER_VERSION,
        classificationReason: "customer_message",
        needsReview: false,
        sourceClosed: false,
        hasAttachments: false,
      });
    }

    const { ids } = drain(store, 3);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("nieznany kursor zaczyna od początku zamiast zgadywać pozycję", () => {
    const store = freshStore();
    seed(store, 5);
    const page = queryQueue(store, {
      now: NOW,
      state: "all",
      limit: 10,
      cursor: Buffer.from("123|ic_nie_istnieje", "utf8").toString("base64url"),
    });
    expect(page.cases).toHaveLength(5);
  });

  it("kompletność widoku zależy od zdrowia źródeł, nie od liczby rekordów", () => {
    const store = freshStore();
    seed(store, 3);
    recordSuccess(
      store,
      { key: { provider: "email", accountKey: "sklep" }, label: "sklep", active: true },
      NOW,
    );
    expect(queryQueue(store, { now: NOW, state: "all" }).completeView).toBe(true);

    recordFailure(
      store,
      { key: { provider: "email", accountKey: "biuro" }, label: "biuro", active: true },
      "error",
      "polaczenie odrzucone",
      NOW,
    );
    expect(queryQueue(store, { now: NOW, state: "all" }).completeView).toBe(false);
  });
});
