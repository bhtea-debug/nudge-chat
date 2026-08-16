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
import { AUTO, planFolders, type FolderPlan, type MailboxInfo } from "./folders.js";

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
  /** Limity czasu w ms. Bez nich pojedyncze zapytanie może wisieć bez końca. */
  readonly connectionTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
}

/**
 * Domyślne limity czasu.
 *
 * `socketTimeout` jest hojny, bo IMAP SEARCH BODY na dużym folderze bez indeksu
 * pełnotekstowego to skan każdej wiadomości i serwer może liczyć długo, nie
 * przestając odpowiadać na poziomie socketu. Ale „długo" musi mieć koniec —
 * bez limitu narzędzie diagnostyczne wisi i nie mówi, na czym.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 90_000;
/** Blokada skrzynki nie może czekać w nieskończoność na zwolnienie. */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
/**
 * Ile referencji wątku najwyżej sprawdzamy. Wątki przechodzące przez systemy
 * zgłoszeniowe mają po kilkadziesiąt pozycji w References, a interesują nas
 * najbliżsi przodkowie. Przekroczenie limitu jest RAPORTOWANE jako niepełność,
 * nie przemilczane.
 */
const MAX_THREAD_LOOKUPS = 25;
/** Ile Message-ID w jednym SEARCH ... OR. Chroni przed bardzo długim poleceniem. */
const SEARCH_OR_CHUNK = 10;
/** Odczekanie przed ponownym połączeniem — daje serwerowi zwolnić stary slot. */
const RECONNECT_GRACE_MS = 1_500;
/** Łącznie prób połączenia. Jedno ponowienie, nie pętla. */
const CONNECT_ATTEMPTS = 2;

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
  private readonly requestedThreadFolders: readonly string[];
  /** Ustalane raz, po pierwszym połączeniu — patrz resolveFolders(). */
  private plan: FolderPlan | null = null;

  constructor(private readonly cfg: ImapConfig) {
    this.folder = cfg.folder ?? "INBOX";
    this.requestedThreadFolders = cfg.threadFolders ?? [AUTO];
  }

  /**
   * Foldery do rekonstrukcji wątku. Rozwiązywane po połączeniu, bo dopóki nie
   * zapytamy serwera, nie wiemy, jak nazywa się u niego folder wysłanych.
   */
  async resolveFolders(): Promise<FolderPlan> {
    if (this.plan) return this.plan;
    const client = await this.connect();
    let boxes: MailboxInfo[] = [];
    try {
      boxes = (await client.list()).map((b) => ({
        path: b.path,
        name: b.name,
        specialUse: b.specialUse,
        specialUseSource: b.specialUseSource,
        subscribed: b.subscribed,
      }));
    } catch {
      // Serwer bez LIST-a to skrajny przypadek; wtedy działamy na tym, co podano.
    }
    this.plan = planFolders(boxes, this.requestedThreadFolders, this.folder);
    return this.plan;
  }

  /** Lista folderów na serwerze — do diagnostyki, nie do logiki agenta. */
  async listMailboxes(): Promise<MailboxInfo[]> {
    const client = await this.connect();
    return (await client.list()).map((b) => ({
      path: b.path,
      name: b.name,
      specialUse: b.specialUse,
      specialUseSource: b.specialUseSource,
      subscribed: b.subscribed,
    }));
  }

  private async threadFolderList(): Promise<readonly string[]> {
    return (await this.resolveFolders()).threadFolders;
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;

    // Jeśli poprzednie połączenie padło, serwer może jeszcze trzymać zajęty
    // slot IMAP dla tego konta — a dostawcy limitują liczbę równoległych
    // połączeń. Wtedy natychmiastowa próba ponowna kończy się CONNECT_TIMEOUT.
    // Dlatego przy ponownym łączeniu domykamy stary uchwyt i dajemy chwilę.
    if (this.client) {
      const stale = this.client;
      this.client = null;
      try {
        stale.close();
      } catch {
        // Uchwyt i tak jest nieużywalny; liczy się zwolnienie socketu.
      }
      await new Promise((r) => setTimeout(r, RECONNECT_GRACE_MS));
    }

    return this.openConnection();
  }

  private async openConnection(attempt = 1): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure ?? this.cfg.port === 993,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      logger: false,
      emitLogs: false,
      connectionTimeout: this.cfg.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      greetingTimeout: this.cfg.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      socketTimeout: this.cfg.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
    });
    // Bez tego pojedynczy błąd socketu przewraca proces zamiast dać nam
    // szansę zwrócić uczciwe "nie udało się sprawdzić poczty".
    client.on("error", () => {});
    try {
      await client.connect();
    } catch (err) {
      // `connect()` obejmuje TAKŻE logowanie, więc odrzucone hasło i nieosiągalny
      // host wychodzą tym samym miejscem. Rozróżniamy je jawnie: „nie udało się
      // połączyć" przy złym haśle wysyła człowieka szukać problemu w sieci,
      // czyli dokładnie tam, gdzie go nie ma.
      const e = err as {
        authenticationFailed?: boolean;
        serverResponseCode?: string;
        code?: string;
        message?: string;
      };
      const detail = [e?.code, e?.serverResponseCode, e?.message]
        .filter(Boolean)
        .join(" | ");

      if (e?.authenticationFailed) {
        // Złe hasło nie naprawi się przez ponowienie.
        throw new CapabilityError(
          "auth_failed",
          `serwer poczty odrzucił dane logowania dla ${this.cfg.host}:${this.cfg.port} — ${detail || "serwer nie podał powodu"}`,
          err,
        );
      }

      // Timeout połączenia po stronie dostawcy bywa przejściowy: zajęty slot
      // IMAP, chwilowy limit. Jedno ponowienie z odczekaniem, potem koniec —
      // pętla ponowień na produkcji jest gorsza od uczciwego błędu.
      if (attempt < CONNECT_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RECONNECT_GRACE_MS * attempt));
        return this.openConnection(attempt + 1);
      }

      throw new CapabilityError(
        "upstream_unavailable",
        `nie udało się nawiązać połączenia z ${this.cfg.host}:${this.cfg.port} po ${attempt} próbach — ${detail || "brak szczegółów od klienta IMAP"}`,
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
    const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: LOCK_ACQUIRE_TIMEOUT_MS });
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
    const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: LOCK_ACQUIRE_TIMEOUT_MS });
    try {
      // IMAP nie ma "OR po trzech polach" w jednym prostym kryterium, więc
      // pytamy osobno i scalamy po UID. Kolejność jest kosztowa, nie estetyczna:
      // SEARCH SUBJECT i FROM idą po nagłówkach, SEARCH BODY na serwerze bez
      // indeksu pełnotekstowego skanuje treść KAŻDEJ wiadomości w folderze.
      // Na skrzynce z dziesiątkami tysięcy maili to różnica między milisekundami
      // a minutami.
      const base = opts.since ? { since: opts.since } : {};
      const cheap: Record<string, unknown>[] = [
        { ...base, subject: opts.query },
        { ...base, from: opts.query },
      ];

      const seen = new Set<number>();

      for (const q of cheap) {
        try {
          for (const u of await this.searchUids(client, q, opts.signal)) seen.add(u);
        } catch {
          // Brak wyniku z jednego kryterium nie może wywalić całego wyszukiwania.
        }
      }

      // Treść przeszukujemy WYŁĄCZNIE wtedy, gdy nagłówki nic nie dały.
      // Inaczej płacilibyśmy za pełny skan przy zapytaniu, na które już mamy
      // odpowiedź — a dla numeru zamówienia w temacie mamy ją prawie zawsze.
      if (seen.size === 0) {
        try {
          for (const u of await this.searchUids(client, { ...base, body: opts.query }, opts.signal)) {
            seen.add(u);
          }
        } catch {
          // Część serwerów odrzuca SEARCH BODY. Wtedy po prostu go nie ma.
        }
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

    // Awarie odczytu zbierane per wywołanie. Niepusta lista znaczy, że wątek
    // jest niepełny — i musi to POWIEDZIEĆ, a nie wyglądać na krótki wątek.
    const problems: string[] = [];

    // 1. Znajdź wiadomość-ziarno po nagłówku Message-ID.
    const seed = await this.findByMessageId(client, opts.messageId, opts.signal, problems);
    if (!seed) return null;

    // 2. Zbierz Message-ID całego wątku z References + In-Reply-To.
    const collected = new Map<string, ParsedRecord>([[seed.message.id, seed]]);
    const wantedIds = threadMemberIds(seed.message).filter((id) => !collected.has(id));

    // 3. Dociągnij pozostałe wiadomości wątku — JEDNYM zapytaniem na folder.
    //
    // Poprzednia wersja pytała osobno o każdą referencję w każdym folderze.
    // Na prawdziwym wątku z 28 referencjami to było ~58 zapytań i tyle samo
    // blokad skrzynki na JEDNO odtworzenie wątku — Zenbox rozłączył połączenie
    // w trakcie. `maxMessages` ograniczał wynik, ale nie ilość PRACY.
    //
    // IMAP SEARCH ma kryterium OR, więc wszystkie Message-ID idą w jednym
    // zapytaniu. Kolejność referencji jest od najstarszej do najnowszej, więc
    // bierzemy OGON — najbliżsi przodkowie są tym, co w wątku istotne.
    const lookupIds = wantedIds.slice(-MAX_THREAD_LOOKUPS);
    if (lookupIds.length < wantedIds.length) {
      problems.push(
        `wątek wskazuje ${wantedIds.length} wiadomości; sprawdzono ${lookupIds.length} najbliższych`,
      );
    }
    await this.collectByMessageIds(client, lookupIds, collected, opts, problems);

    // 4. Dołóż odpowiedzi, które wskazują na ziarno (References go zawiera).
    for (const folder of await this.threadFolderList()) {
      if (collected.size >= opts.maxMessages) break;
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: LOCK_ACQUIRE_TIMEOUT_MS });
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
            problems,
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
      incomplete: problems.length > 0,
      incompleteNote:
        problems.length > 0
          ? `${problems.length} wiadomości wątku nie udało się odczytać: ${problems.slice(0, 3).join("; ")}` +
            (problems.length > 3 ? ` (+${problems.length - 3} więcej)` : "")
          : null,
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
    /** Kolektor awarii odczytu. Przekazywany przez parametr, nie trzymany na
     *  dostawcy — stan na współdzielonym obiekcie działałby też na produkcji
     *  i mieszał wyniki równoległych wywołań. */
    problems?: string[],
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
      } catch (err) {
        // UWAGA: pierwotnie stało tu, że „agent i tak nie zmyśli tego, czego nie
        // dostał". To było błędne rozumowanie. Agent faktycznie nie wymyśli
        // brakującej wiadomości — ale z po cichu przyciętego wątku wyciągnie
        // wniosek „klient nie dostał odpowiedzi". Fałszywy wniosek z cicho
        // zgubionego dowodu to ta sama szkoda co zmyślenie.
        //
        // Dlatego awaria jest tu ZLICZANA i wystawiana wywołującemu, a nie
        // wyciszana. Jedna nieparsowalna wiadomość nadal nie wywraca całej
        // odpowiedzi — ale przestaje być niewidzialna.
        problems?.push(
          `uid ${msg.uid} w "${folder}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * Dociąga wiele wiadomości po Message-ID jednym zapytaniem na folder.
   *
   * Kryterium `or` w IMAP SEARCH zamienia N zapytań na jedno. Chunkujemy je,
   * bo polecenie SEARCH z kilkudziesięcioma nagłówkami robi się długie, a
   * części serwerów nie da się zaufać przy bardzo długich poleceniach.
   */
  private async collectByMessageIds(
    client: ImapFlow,
    ids: readonly string[],
    collected: Map<string, ParsedRecord>,
    opts: GetThreadOptions,
    problems: string[],
  ): Promise<void> {
    if (ids.length === 0) return;

    for (const folder of await this.threadFolderList()) {
      if (collected.size >= opts.maxMessages) return;

      const missing = ids.filter((id) => !collected.has(id));
      if (missing.length === 0) return;

      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(folder, {
          readOnly: true,
          acquireTimeout: LOCK_ACQUIRE_TIMEOUT_MS,
        });

        const uids = new Set<number>();
        for (let i = 0; i < missing.length; i += SEARCH_OR_CHUNK) {
          const chunk = missing.slice(i, i + SEARCH_OR_CHUNK);
          const criteria =
            chunk.length === 1
              ? { header: { "Message-ID": chunk[0]! } }
              : { or: chunk.map((id) => ({ header: { "Message-ID": id } })) };
          try {
            for (const u of await this.searchUids(client, criteria, opts.signal)) uids.add(u);
          } catch (err) {
            problems.push(
              `zbiorcze szukanie ${chunk.length} wiadomości w "${folder}" nie udało się: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        if (uids.size > 0) {
          const records = await this.fetchByUids(
            client,
            [...uids].sort((a, b) => a - b).slice(-opts.maxMessages),
            folder,
            opts.signal,
            problems,
          );
          for (const rec of records) {
            if (collected.size >= opts.maxMessages) break;
            if (!collected.has(rec.message.id)) collected.set(rec.message.id, rec);
          }
        }
      } catch (err) {
        problems.push(
          `folder "${folder}" niedostępny: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        lock?.release();
      }
    }
  }

  private async findByMessageId(
    client: ImapFlow,
    messageId: string,
    signal?: AbortSignal,
    problems?: string[],
  ): Promise<ParsedRecord | null> {
    for (const folder of await this.threadFolderList()) {
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: LOCK_ACQUIRE_TIMEOUT_MS });
        const uids = await this.searchUids(
          client,
          { header: { "Message-ID": messageId } },
          signal,
        );
        if (uids.length === 0) continue;
        const recs = await this.fetchByUids(client, uids.slice(-1), folder, signal, problems);
        if (recs[0]) return recs[0];
        // SEARCH znalazł wiadomość, ale nie dała się odczytać. To NIE jest
        // „nie ma jej" — i wywołujący musi móc tę różnicę zobaczyć.
        problems?.push(
          `wiadomość znaleziona w "${folder}" (uid ${uids.slice(-1).join(",")}), ale nieodczytana`,
        );
      } catch (err) {
        problems?.push(
          `szukanie w "${folder}" nie udało się: ${err instanceof Error ? err.message : String(err)}`,
        );
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
