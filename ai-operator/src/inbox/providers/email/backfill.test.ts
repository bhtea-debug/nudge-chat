import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedRecord } from "../../../mail/imap.js";
import { InboxStore } from "../../store.js";
import type { EmailAccount } from "./normalize.js";
import { syncEmailAccount, type ImapReader } from "./sync.js";

/**
 * Pierwszy import.
 *
 * Powód istnienia: pierwszy skan szedł zakresem `1:*`, więc skrzynka
 * z dziesięcioletnią historią trafiłaby w całości do pamięci procesu i do
 * kolejki obsługi klienta. Import historyczny jest nieodwracalny — nie da się
 * „odimportować" korespondencji sprzed pięciu lat bez ręcznego sprzątania.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-backfill-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const account: EmailAccount = {
  accountKey: "sklep",
  address: "sklep@brownhouseandtea.pl",
  label: "E-mail sklep",
  folder: "INBOX",
  sentFolder: null,
};

function record(uid: number, ageDays: number): ParsedRecord {
  const date = new Date(NOW - ageDays * DAY).toISOString();
  const id = `mid-${uid}@example.com`;
  return {
    message: {
      id,
      providerRef: `imap:INBOX:${uid}`,
      threadId: id,
      subject: `Sprawa ${uid}`,
      from: { name: null, address: `klient${uid}@example.com` },
      to: [{ name: null, address: account.address }],
      cc: [],
      replyTo: null,
      date,
      folder: "INBOX",
      seen: false,
      answered: false,
      inReplyTo: null,
      references: [],
      bulk: false,
      attachments: [],
      snippet: "Pytanie",
    },
    body: "Czy macie matche w puszce?",
  };
}

/** Czytnik z pełną skrzynką: 5 wiadomości świeżych, 5 sprzed roku. */
class ArchiveReader implements ImapReader {
  fetchedRanges: string[] = [];
  searchedSince: Date | null = null;

  private readonly all = new Map<number, { record: ParsedRecord; ageDays: number }>([
    [1, { record: record(1, 400), ageDays: 400 }],
    [2, { record: record(2, 380), ageDays: 380 }],
    [3, { record: record(3, 370), ageDays: 370 }],
    [4, { record: record(4, 360), ageDays: 360 }],
    [5, { record: record(5, 350), ageDays: 350 }],
    [6, { record: record(6, 5), ageDays: 5 }],
    [7, { record: record(7, 4), ageDays: 4 }],
    [8, { record: record(8, 3), ageDays: 3 }],
    [9, { record: record(9, 2), ageDays: 2 }],
    [10, { record: record(10, 1), ageDays: 1 }],
  ]);

  async uidsSince(since: Date): Promise<number[]> {
    this.searchedSince = since;
    return [...this.all.entries()]
      .filter(([, entry]) => NOW - entry.ageDays * DAY >= since.getTime())
      .map(([uid]) => uid)
      .sort((a, b) => a - b);
  }

  async mailboxState() {
    return { path: "INBOX", uidValidity: 11, uidNext: 11, messages: this.all.size };
  }

  async fetchRange(range: string) {
    this.fetchedRanges.push(range);
    const uids = range.split(",").map((value) => Number(value.trim()));
    const records = uids
      .map((uid) => this.all.get(uid)?.record)
      .filter((value): value is ParsedRecord => Boolean(value));
    return { records, problems: [] };
  }
}

describe("pierwszy import", () => {
  it("domyślnie tylko LICZY i nie zapisuje ani jednej wiadomości", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();

    const result = await syncEmailAccount({ account, store, reader, now: NOW, backfillDays: 30 });

    expect(result.previewOnly).toBe(true);
    expect(result.previewCount).toBe(5);
    expect(result.stored).toBe(0);
    expect(store.allMessages()).toHaveLength(0);
    // Kursor nie ruszył: podgląd nie jest importem.
    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
    expect(reader.fetchedRanges).toHaveLength(0);
  });

  it("po jawnej aktywacji importuje WYŁĄCZNIE okno historii", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();

    const result = await syncEmailAccount({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "import",
    });

    expect(result.previewOnly).toBe(false);
    expect(result.stored).toBe(5);
    // Wiadomości sprzed roku NIE zostały zaimportowane.
    const uids = store
      .allMessages()
      .map((message) => Number(/mid-(\d+)@/.exec(message.rfcMessageId ?? "")?.[1] ?? 0))
      .sort((a, b) => a - b);
    expect(uids).toEqual([6, 7, 8, 9, 10]);
  });

  it("okno historii jest liczone od podanej liczby dni", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();
    await syncEmailAccount({ account, store, reader, now: NOW, backfillDays: 7 });
    expect(reader.searchedSince?.getTime()).toBe(NOW - 7 * DAY);
  });

  it("import idzie partiami, a nie jednym zapytaniem o wszystko", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();

    const result = await syncEmailAccount({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "import",
      batchSize: 2,
    });

    expect(result.batches).toBe(3);
    expect(reader.fetchedRanges).toEqual(["6,7", "8,9", "10"]);
    // Zakres to lista UID-ów, nie `od:do`: po skasowanych wiadomościach
    // przedział zwracałby więcej, niż wybraliśmy.
    expect(reader.fetchedRanges.every((range) => !range.includes(":"))).toBe(true);
  });

  it("import jest oznaczony jako backfill, żeby nie wywołał lawiny powiadomień", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();
    const result = await syncEmailAccount({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "import",
    });
    expect(result.backfill).toBe(true);
  });

  it("kolejne przebiegi nie są już backfillem i idą przyrostowo", async () => {
    const store = freshStore();
    const reader = new ArchiveReader();
    await syncEmailAccount({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "import",
    });

    const next = new ArchiveReader();
    const second = await syncEmailAccount({ account, store, reader: next, now: NOW + 60_000 });
    expect(second.backfill).toBe(false);
    expect(second.previewOnly).toBe(false);
    // Drugi przebieg pyta zakresem przyrostowym, nie listą z wyszukiwania.
    expect(next.fetchedRanges[0]).toMatch(/^\d+:\*$/);
    expect(next.searchedSince).toBeNull();
  });
});
