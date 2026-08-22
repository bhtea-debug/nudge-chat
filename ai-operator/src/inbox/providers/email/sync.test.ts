import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedRecord } from "../../../mail/imap.js";
import { InboxStore } from "../../store.js";
import { decodeCursor } from "./cursor.js";
import type { EmailAccount } from "./normalize.js";
import { syncEmailAccount, type ImapReader } from "./sync.js";

const dirs: string[] = [];

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-test-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const account = (key: string): EmailAccount => ({
  accountKey: key,
  address: `${key}@brownhouseandtea.pl`,
  label: `E-mail ${key}`,
  folder: "INBOX",
  sentFolder: null,
});

interface FakeMail {
  readonly uid: number;
  readonly messageId: string | null;
  readonly from: string;
  readonly subject?: string;
  readonly body?: string;
  readonly date?: string;
  readonly inReplyTo?: string | null;
  readonly references?: string[];
}

function record(mail: FakeMail, folder = "INBOX"): ParsedRecord {
  const id = mail.messageId ?? `imap:${folder}:${mail.uid}`;
  return {
    message: {
      id,
      providerRef: `imap:${folder}:${mail.uid}`,
      threadId: id,
      subject: mail.subject ?? "Pytanie o zamowienie",
      from: { name: null, address: mail.from },
      to: [{ name: null, address: "sklep@brownhouseandtea.pl" }],
      cc: [],
      replyTo: null,
      date: mail.date ?? "2026-08-20T10:00:00.000Z",
      folder,
      seen: false,
      answered: false,
      inReplyTo: mail.inReplyTo ?? null,
      references: mail.references ?? [],
      bulk: false,
      attachments: [],
      snippet: (mail.body ?? "Gdzie jest moja paczka?").slice(0, 50),
    },
    body: mail.body ?? "Gdzie jest moja paczka?",
  };
}

/** Czytnik sterowany scenariuszem: kolejne wywołania mogą zwrócić co innego. */
class FakeReader implements ImapReader {
  fetchCalls: string[] = [];
  constructor(
    private readonly state: { uidValidity: number; uidNext: number; messages: number },
    private readonly batches: Array<{ records: ParsedRecord[]; problems: string[] } | Error>,
  ) {}

  async mailboxState() {
    return { path: "INBOX", ...this.state };
  }

  async fetchRange(range: string) {
    this.fetchCalls.push(range);
    const next = this.batches.shift();
    if (!next) return { records: [], problems: [] };
    if (next instanceof Error) throw next;
    return next;
  }

  setUidValidity(value: number) {
    (this.state as { uidValidity: number }).uidValidity = value;
  }
}

describe("synchronizacja IMAP", () => {
  it("zapisuje partie i przesuwa kursor na najwyzszy zapisany UID", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 7, uidNext: 200, messages: 2 }, [
      {
        records: [
          record({ uid: 10, messageId: "a@klient", from: "klient@example.com" }),
          record({ uid: 11, messageId: "b@klient", from: "inny@example.com" }),
        ],
        problems: [],
      },
    ]);

    const result = await syncEmailAccount({ account: account("sklep"), store, reader, now: 1_000 });

    expect(result.stored).toBe(2);
    expect(decodeCursor(result.cursorAfter)).toEqual({ uidValidity: 7, lastUid: 11 });
    expect(store.listCases()).toHaveLength(2);
  });

  it("trzy konta maja niezalezne kursory, awaria jednego nie rusza pozostalych", async () => {
    const store = freshStore();
    const ok1 = new FakeReader({ uidValidity: 1, uidNext: 5, messages: 1 }, [
      { records: [record({ uid: 4, messageId: "s1@k", from: "k@example.com" })], problems: [] },
    ]);
    const broken = new FakeReader({ uidValidity: 1, uidNext: 5, messages: 1 }, [
      new Error("ECONNRESET"),
    ]);
    const ok2 = new FakeReader({ uidValidity: 1, uidNext: 9, messages: 1 }, [
      { records: [record({ uid: 8, messageId: "h1@k", from: "hurt@example.com" })], problems: [] },
    ]);

    await syncEmailAccount({ account: account("sklep"), store, reader: ok1, now: 1 });
    await expect(
      syncEmailAccount({ account: account("biuro"), store, reader: broken, now: 1 }),
    ).rejects.toThrow("ECONNRESET");
    await syncEmailAccount({ account: account("hurt"), store, reader: ok2, now: 1 });

    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBe("1:4");
    expect(store.getCursor({ provider: "email", accountKey: "biuro" })).toBeNull();
    expect(store.getCursor({ provider: "email", accountKey: "hurt" })).toBe("1:8");
  });

  it("zerwanie polaczenia po czesci partii nie przesuwa kursora poza trwaly zapis", async () => {
    const store = freshStore();
    // Pierwsze podejscie: partia sie nie udala w polowie (blad na fetchu).
    const failing = new FakeReader({ uidValidity: 3, uidNext: 30, messages: 3 }, [
      new Error("socket closed"),
    ]);
    await expect(
      syncEmailAccount({ account: account("sklep"), store, reader: failing, now: 1 }),
    ).rejects.toThrow();
    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();

    // Drugie podejscie widzi caly zakres od poczatku i nic nie ginie.
    const recovering = new FakeReader({ uidValidity: 3, uidNext: 30, messages: 3 }, [
      {
        records: [
          record({ uid: 20, messageId: "x1@k", from: "k@example.com" }),
          record({ uid: 21, messageId: "x2@k", from: "k2@example.com" }),
        ],
        problems: [],
      },
    ]);
    const result = await syncEmailAccount({ account: account("sklep"), store, reader: recovering, now: 2 });
    expect(result.stored).toBe(2);
    expect(recovering.fetchCalls[0]).toBe("1:*");
  });

  it("nieczytelny rekord w partii wstrzymuje kursor", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 3, uidNext: 30, messages: 2 }, [
      {
        records: [record({ uid: 20, messageId: "y1@k", from: "k@example.com" })],
        problems: ['uid 21 w "INBOX": nie da sie sparsowac'],
      },
    ]);
    const result = await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });

    expect(result.stored).toBe(1);
    // Wiadomosc jest trwale zapisana, ale kursor NIE przeskakuje nad luka.
    expect(result.cursorAfter).toBeNull();
    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
  });

  it("duplikat UID i Message-ID nie tworzy drugiej sprawy", async () => {
    const store = freshStore();
    const first = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 1 }, [
      { records: [record({ uid: 30, messageId: "dup@k", from: "k@example.com" })], problems: [] },
    ]);
    await syncEmailAccount({ account: account("sklep"), store, reader: first, now: 1 });

    const again = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 1 }, [
      { records: [record({ uid: 30, messageId: "dup@k", from: "k@example.com" })], problems: [] },
    ]);
    const result = await syncEmailAccount({ account: account("sklep"), store, reader: again, now: 2 });

    expect(result.stored).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(store.listCases()).toHaveLength(1);
  });

  it("powtorzony Message-ID z INNA trescia zapisuje obie wiadomosci", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 2 }, [
      {
        records: [
          record({ uid: 30, messageId: "same@k", from: "k@example.com", body: "Pierwsza sprawa" }),
          record({ uid: 31, messageId: "same@k", from: "k@example.com", body: "Zupelnie inna sprawa" }),
        ],
        problems: [],
      },
    ]);
    const result = await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });

    expect(result.stored).toBe(2);
    expect(result.collisions).toBe(1);
  });

  it("brak Message-ID nie blokuje zapisu i jest stabilny miedzy przebiegami", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 1 }, [
      { records: [record({ uid: 33, messageId: null, from: "k@example.com" })], problems: [] },
    ]);
    const first = await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });
    expect(first.stored).toBe(1);

    const repeat = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 1 }, [
      { records: [record({ uid: 33, messageId: null, from: "k@example.com" })], problems: [] },
    ]);
    const second = await syncEmailAccount({ account: account("sklep"), store, reader: repeat, now: 2 });
    expect(second.stored).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("zmiana UIDVALIDITY skanuje od poczatku i nie duplikuje wiadomosci", async () => {
    const store = freshStore();
    const before = new FakeReader({ uidValidity: 5, uidNext: 40, messages: 1 }, [
      { records: [record({ uid: 30, messageId: "v1@k", from: "k@example.com" })], problems: [] },
    ]);
    await syncEmailAccount({ account: account("sklep"), store, reader: before, now: 1 });

    // Serwer odbudowal folder: nowa przestrzen UID, te same wiadomosci.
    const after = new FakeReader({ uidValidity: 9, uidNext: 3, messages: 1 }, [
      { records: [record({ uid: 1, messageId: "v1@k", from: "k@example.com" })], problems: [] },
    ]);
    const result = await syncEmailAccount({ account: account("sklep"), store, reader: after, now: 2 });

    expect(result.uidValidityChanged).toBe(true);
    expect(after.fetchCalls[0]).toBe("1:*");
    expect(result.stored).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(store.listCases()).toHaveLength(1);
    expect(decodeCursor(result.cursorAfter)).toEqual({ uidValidity: 9, lastUid: 1 });
  });

  it("wiadomosc doreczona w trakcie skanu trafia do kolejki w nastepnym ticku", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 2, uidNext: 50, messages: 1 }, [
      { records: [record({ uid: 40, messageId: "n1@k", from: "k@example.com" })], problems: [] },
      // Druga partia: wiadomosc, ktora przyszla juz po odczycie uidNext=50.
      { records: [record({ uid: 51, messageId: "n2@k", from: "k2@example.com" })], problems: [] },
    ]);

    const first = await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });
    // Kursor stoi na FAKTYCZNIE zapisanym UID, nie na uidNext odczytanym na starcie.
    expect(decodeCursor(first.cursorAfter)).toEqual({ uidValidity: 2, lastUid: 40 });

    const second = await syncEmailAccount({ account: account("sklep"), store, reader, now: 2 });
    expect(second.stored).toBe(1);
    expect(decodeCursor(second.cursorAfter)).toEqual({ uidValidity: 2, lastUid: 51 });
  });

  it("uzgodnienie odnajduje sztucznie pominiety UID", async () => {
    const store = freshStore();
    // Tick zwykly widzi tylko nowsza wiadomosc; starsza (uid 41) zostaje pominieta.
    const normal = new FakeReader({ uidValidity: 2, uidNext: 60, messages: 2 }, [
      { records: [record({ uid: 45, messageId: "r2@k", from: "k2@example.com" })], problems: [] },
    ]);
    await syncEmailAccount({ account: account("sklep"), store, reader: normal, now: 1 });
    expect(store.allMessages()).toHaveLength(1);

    const reconcile = new FakeReader({ uidValidity: 2, uidNext: 60, messages: 2 }, [
      {
        records: [
          record({ uid: 41, messageId: "r1@k", from: "k1@example.com" }),
          record({ uid: 45, messageId: "r2@k", from: "k2@example.com" }),
        ],
        problems: [],
      },
    ]);
    const result = await syncEmailAccount({
      account: account("sklep"),
      store,
      reader: reconcile,
      now: 2,
      mode: "reconcile",
    });

    expect(result.stored).toBe(1);
    expect(store.allMessages()).toHaveLength(2);
    expect(reconcile.fetchCalls[0]).toBe("1:*");
  });

  it("wlasna odpowiedz nie jest klasyfikowana jako wiadomosc przychodzaca", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 2, uidNext: 10, messages: 2 }, [
      {
        records: [
          record({ uid: 5, messageId: "q@k", from: "klient@example.com", body: "Czy wysylacie dzisiaj?" }),
          record({
            uid: 6,
            messageId: "a@my",
            from: "sklep@brownhouseandtea.pl",
            inReplyTo: "q@k",
            body: "Wysylamy jutro rano.",
            date: "2026-08-20T12:00:00.000Z",
          }),
        ],
        problems: [],
      },
    ]);

    await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });
    const messages = store.allMessages();
    expect(messages.find((m) => m.rfcMessageId === "a@my")?.direction).toBe("outgoing");
    expect(messages.find((m) => m.rfcMessageId === "q@k")?.direction).toBe("incoming");
    // Odpowiedz trafia do TEJ SAMEJ sprawy dzieki In-Reply-To.
    expect(new Set(messages.map((m) => m.caseId)).size).toBe(1);
  });

  it("wątkowanie po In-Reply-To laczy odpowiedz klienta z pierwotna sprawa", async () => {
    const store = freshStore();
    const reader = new FakeReader({ uidValidity: 2, uidNext: 10, messages: 3 }, [
      {
        records: [
          record({ uid: 1, messageId: "t1@k", from: "klient@example.com" }),
          record({ uid: 2, messageId: "t2@k", from: "klient@example.com", inReplyTo: "t1@k" }),
          record({
            uid: 3,
            messageId: "t3@k",
            from: "klient@example.com",
            references: ["t1@k", "t2@k"],
          }),
        ],
        problems: [],
      },
    ]);
    await syncEmailAccount({ account: account("sklep"), store, reader, now: 1 });
    expect(store.listCases()).toHaveLength(1);
    expect(store.listCases()[0]!.messageCount).toBe(3);
  });
});
