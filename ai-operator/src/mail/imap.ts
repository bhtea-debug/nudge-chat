import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { CapabilityError } from "../capability/types.js";
import type {
  GetThreadOptions,
  ListRecentOptions,
  MailAddress,
  MailMessage,
  MailMessageFull,
  MailProvider,
  MailThread,
  SearchOptions,
} from "./types.js";
import {
  assignThreadIds,
  baseSubject,
  normalizeReferences,
  threadMemberIds,
} from "./thread.js";
import {
  makeSnippet,
  stripQuotedHistory,
  toPlainText,
  truncateBody,
} from "./text.js";

export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly secure?: boolean;
  /** Folder domyślny. */
  readonly folder?: string;
  /** Folder(y) dodatkowo przeszukiwane przy rekonstrukcji wątku (np. "Sent"). */
  readonly threadFolders?: readonly string[];
}

/**
 * Adapter IMAP. Read-only na trzech poziomach:
 *  1. `mailboxOpen(..., { readOnly: true })` — serwer nie pozwoli nam nic zmienić,
 *     w szczególności nie ustawi \Seen przy czytaniu,
 *  2. brak jakiegokolwiek kodu SMTP / append / store / move w tym pliku,
 *  3. interfejs MailProvider nie ma metody zapisu.
 *
 * Wzorce odzyskane z archiwalnych nudge-mail (worker IMAP) i teabrew-calendar
 * (skaner IMAP): envelope-first, fetch po UID, wyszukiwanie po nagłówku
 * Message-ID, normalizacja References. Nie przenosimy stąd niczego, co
 * dotyczyło kolejek, Turso, IDLE ani powiadomień push — MVP odpytuje na żądanie.
 */
export class ImapMailProvider implements MailProvider {
  readonly id = "imap";
  readonly features = {
    serverSideSearch: true,
    // IMAP SEARCH BODY jest po stronie serwera, ale bywa wolny i różnie
    // zaimplementowany. Traktujemy go jako "działa, ale nie jak wyszukiwarka".
    fullTextSearch: true,
    threads: true,
  } as const;

  private client: ImapFlow | null = null;
  private readonly folder: string;
  private readonly threadFolders: readonly string[];

  constructor(private readonly cfg: ImapConfig) {
    this.folder = cfg.folder ?? "INBOX";
    this.threadFolders = cfg.threadFolders ?? [this.folder];
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure ?? this.cfg.port === 993,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      logger: false,
      emitLogs: false,
    });
    // Bez tego pojedynczy błąd socketu przewraca proces zamiast dać nam
    // szansę zwrócić uczciwe "nie udało się sprawdzić poczty".
    client.on("error", () => {});
    try {
      await client.connect();
    } catch (err) {
      throw new CapabilityError(
        "upstream_unavailable",
        `nie udało się połączyć z serwerem poczty (${this.cfg.host}:${this.cfg.port})`,
        err,
      );
    }
    this.client = client;
    return client;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // Zamykanie połączenia nie jest częścią odpowiedzi dla właściciela.
    }
    this.client = null;
  }

  async listRecent(opts: ListRecentOptions): Promise<MailMessage[]> {
    const folder = opts.folder ?? this.folder;
    const client = await this.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const criteria: Record<string, unknown> = { since: opts.since };
      if (opts.unreadOnly) criteria["seen"] = false;
      const uids = await this.searchUids(client, criteria, opts.signal);
      if (uids.length === 0) return [];
      // Najnowsze na końcu listy UID — bierzemy ogon.
      const wanted = uids.slice(-opts.limit);
      const parsed = await this.fetchByUids(client, wanted, folder, opts.signal);
      return this.finalize(parsed).sort((a, b) => b.date.localeCompare(a.date));
    } finally {
      lock.release();
    }
  }

  async search(opts: SearchOptions): Promise<MailMessage[]> {
    const folder = opts.folder ?? this.folder;
    const client = await this.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      // IMAP nie ma "OR po trzech polach" w jednym prostym kryterium,
      // więc pytamy trzy razy i scalamy po UID. Kolejność zapytań od
      // najtańszego: temat, nadawca, treść.
      const base = opts.since ? { since: opts.since } : {};
      const queries: Record<string, unknown>[] = [
        { ...base, subject: opts.query },
        { ...base, from: opts.query },
        { ...base, body: opts.query },
      ];
      const seen = new Set<number>();
      for (const q of queries) {
        if (seen.size >= opts.limit * 3) break;
        let uids: number[] = [];
        try {
          uids = await this.searchUids(client, q, opts.signal);
        } catch {
          // Serwer może odrzucić SEARCH BODY. Brak wyniku z jednego kryterium
          // nie może wywalić całego wyszukiwania.
          continue;
        }
        for (const u of uids) seen.add(u);
      }
      if (seen.size === 0) return [];
      const wanted = [...seen].sort((a, b) => a - b).slice(-opts.limit);
      const parsed = await this.fetchByUids(client, wanted, folder, opts.signal);
      return this.finalize(parsed).sort((a, b) => b.date.localeCompare(a.date));
    } finally {
      lock.release();
    }
  }

  async getThread(opts: GetThreadOptions): Promise<MailThread | null> {
    const client = await this.connect();

    // 1. Znajdź wiadomość-ziarno po nagłówku Message-ID.
    const seed = await this.findByMessageId(client, opts.messageId, opts.signal);
    if (!seed) return null;

    // 2. Zbierz Message-ID całego wątku z References + In-Reply-To.
    const wantedIds = new Set(threadMemberIds(seed.message));
    const collected = new Map<string, ParsedRecord>([[seed.message.id, seed]]);

    // 3. Dociągnij pozostałe wiadomości wątku ze skonfigurowanych folderów.
    for (const id of wantedIds) {
      if (collected.has(id)) continue;
      if (collected.size >= opts.maxMessages) break;
      const found = await this.findByMessageId(client, id, opts.signal);
      if (found) collected.set(found.message.id, found);
    }

    // 4. Dołóż odpowiedzi, które wskazują na ziarno (References go zawiera).
    for (const folder of this.threadFolders) {
      if (collected.size >= opts.maxMessages) break;
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
        const uids = await this.searchUids(
          client,
          { header: { References: seed.message.id } },
          opts.signal,
        );
        if (uids.length > 0) {
          const extra = await this.fetchByUids(
            client,
            uids.slice(-opts.maxMessages),
            folder,
            opts.signal,
          );
          for (const rec of extra) {
            if (collected.size >= opts.maxMessages) break;
            if (!collected.has(rec.message.id)) collected.set(rec.message.id, rec);
          }
        }
      } catch {
        // Folder może nie istnieć u danego dostawcy — pomijamy.
      } finally {
        lock?.release();
      }
    }

    const records = [...collected.values()].sort((a, b) =>
      a.message.date.localeCompare(b.message.date),
    );
    const threadIds = assignThreadIds(records.map((r) => r.message));
    const threadId = threadIds.get(seed.message.id) ?? seed.message.id;

    const messages: MailMessageFull[] = records.map((r) => {
      const plain = stripQuotedHistory(r.body);
      const { body, truncated } = truncateBody(plain);
      return {
        ...r.message,
        threadId,
        body,
        bodyTruncated: truncated,
      };
    });

    return {
      threadId,
      subject: baseSubject(records[0]?.message.subject ?? seed.message.subject),
      messageCount: messages.length,
      messages,
    };
  }

  // ---------- warstwa IMAP ----------

  private async searchUids(
    client: ImapFlow,
    criteria: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number[]> {
    signal?.throwIfAborted();
    const res = await client.search(criteria as never, { uid: true });
    return res === false ? [] : res;
  }

  private async fetchByUids(
    client: ImapFlow,
    uids: readonly number[],
    folder: string,
    signal?: AbortSignal,
  ): Promise<ParsedRecord[]> {
    if (uids.length === 0) return [];
    const range = uids.join(",");
    const out: ParsedRecord[] = [];
    for await (const msg of client.fetch(
      range,
      { uid: true, envelope: true, source: true, internalDate: true, flags: true },
      { uid: true },
    )) {
      signal?.throwIfAborted();
      try {
        out.push(await this.toRecord(msg, folder));
      } catch {
        // Jedna nieparsowalna wiadomość nie może unieważnić całej odpowiedzi.
        // Agent zobaczy o jedną wiadomość mniej — i tak nie zmyśli tego, czego nie dostał.
      }
    }
    return out;
  }

  private async findByMessageId(
    client: ImapFlow,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ParsedRecord | null> {
    for (const folder of this.threadFolders) {
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
        const uids = await this.searchUids(
          client,
          { header: { "Message-ID": messageId } },
          signal,
        );
        if (uids.length === 0) continue;
        const recs = await this.fetchByUids(client, uids.slice(-1), folder, signal);
        if (recs[0]) return recs[0];
      } catch {
        continue;
      } finally {
        lock?.release();
      }
    }
    return null;
  }

  private async toRecord(
    msg: FetchMessageObject,
    folder: string,
  ): Promise<ParsedRecord> {
    const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
    const id =
      (parsed.messageId ?? msg.envelope?.messageId ?? "").trim() ||
      `imap:${folder}:${msg.uid}`;
    const body = toPlainText(parsed.text, parsed.html === false ? null : parsed.html);
    // internalDate bywa typowane jako string albo Date, zależnie od wersji imapflow.
    const date =
      parsed.date?.toISOString() ??
      (msg.internalDate ? new Date(msg.internalDate).toISOString() : null) ??
      new Date(0).toISOString();

    const message: MailMessage = {
      id,
      providerRef: `imap:${folder}:${msg.uid}`,
      threadId: id,
      subject: parsed.subject?.trim() || "(brak tematu)",
      from: addr(parsed.from?.value?.[0]),
      to: (parsed.to && !Array.isArray(parsed.to) ? parsed.to.value : []).map(addr).filter(nonNull),
      cc: (parsed.cc && !Array.isArray(parsed.cc) ? parsed.cc.value : []).map(addr).filter(nonNull),
      date,
      folder,
      seen: msg.flags?.has("\\Seen") ?? false,
      answered: msg.flags?.has("\\Answered") ?? false,
      inReplyTo: parsed.inReplyTo?.trim() || null,
      references: normalizeReferences(parsed.references, parsed.inReplyTo),
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? null,
        contentType: a.contentType ?? null,
        sizeBytes: typeof a.size === "number" ? a.size : null,
      })),
      snippet: makeSnippet(stripQuotedHistory(body)),
    };
    return { message, body };
  }

  /** Nadaje spójne threadId w obrębie jednej odpowiedzi. */
  private finalize(records: readonly ParsedRecord[]): MailMessage[] {
    const ids = assignThreadIds(records.map((r) => r.message));
    return records.map((r) => ({
      ...r.message,
      threadId: ids.get(r.message.id) ?? r.message.id,
    }));
  }
}

interface ParsedRecord {
  readonly message: MailMessage;
  readonly body: string;
}

function addr(v?: { name?: string; address?: string }): MailAddress | null {
  if (!v?.address) return null;
  return { name: v.name?.trim() || null, address: v.address.toLowerCase() };
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}
