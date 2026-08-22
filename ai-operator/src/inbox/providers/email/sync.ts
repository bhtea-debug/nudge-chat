import type { InboxMessage, SourceKey } from "../../contract.js";
import type { InboxStore } from "../../store.js";
import { projectCase } from "../../project.js";
import { decodeCursor, encodeCursor, incrementalRange, reconciliationRange, type ImapCursor } from "./cursor.js";
import { normalizeEmail, subjectFallbackKey, type EmailAccount } from "./normalize.js";
import type { ParsedRecord } from "../../../mail/imap.js";

/**
 * Trwała synchronizacja jednej skrzynki.
 *
 * Cała odporność sprowadza się do kolejności trzech kroków:
 *  1. pobierz partię,
 *  2. zapisz KAŻDĄ wiadomość trwale (i dopiero wtedy klasyfikuj),
 *  3. przesuń kursor na najwyższy UID, który faktycznie został zapisany.
 *
 * Zerwanie połączenia w połowie kroku 2 zostawia kursor na starej pozycji.
 * Następny przebieg pobierze tę samą partię, dedup wchłonie zapisane rekordy
 * i dołoży brakujące. Kosztuje to jedno powtórzone pobranie — cena za to,
 * żeby wiadomość nie mogła zniknąć.
 */

/** Ile UID cofa zwykły tick. Kilka kopert za spokój o przenosiny wiadomości. */
const DEFAULT_OVERLAP = 20;
/** Jak głęboko sięga uzgodnienie. Znajduje luki, których kursor już nie widzi. */
const DEFAULT_RECONCILE_LOOKBACK = 500;
/** Domyślne okno pierwszego importu. */
const DEFAULT_BACKFILL_DAYS = 30;
/** Ile wiadomości pobieramy jednym fetchem. Sufit pamięci procesu. */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Podział UID-ów na zakresy po `size` sztuk.
 *
 * Lista UID-ów jest przekazywana wprost, a nie jako `od:do`: po skasowanych
 * wiadomościach zakres bywa dziurawy i serwer zwracałby przy nim więcej,
 * niż wybraliśmy.
 */
function chunkUids(uids: readonly number[], size: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < uids.length; index += size) {
    out.push(uids.slice(index, index + size).join(","));
  }
  return out;
}

export interface ImapReader {
  /** UID-y nie starsze niż data. Tylko pierwszy import. */
  uidsSince?(since: Date, folder?: string, signal?: AbortSignal): Promise<number[]>;
  mailboxState(
    folder?: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; uidValidity: number; uidNext: number; messages: number }>;
  fetchRange(
    range: string,
    folder?: string,
    signal?: AbortSignal,
  ): Promise<{ records: ParsedRecord[]; problems: string[] }>;
}

export interface EmailSyncOptions {
  readonly account: EmailAccount;
  readonly store: InboxStore;
  readonly reader: ImapReader;
  readonly now: number;
  readonly mode?: "incremental" | "reconcile";
  readonly overlap?: number;
  readonly reconcileLookback?: number;
  readonly signal?: AbortSignal;
  /**
   * Pierwszy przebieg importuje historię, ale nie ma prawa wywołać lawiny
   * powiadomień. Flaga jest przekazywana dalej, a nie zgadywana z liczby
   * rekordów: „dużo wiadomości" zdarza się też po dwudniowej awarii.
   */
  readonly backfill?: boolean;
  /** Ile dni historii obejmuje PIERWSZY import. */
  readonly backfillDays?: number;
  /**
   * `preview` liczy i nie zapisuje ani jednej wiadomości.
   *
   * Domyślny, bo import historyczny jest nieodwracalny: raz wciągniętej
   * korespondencji sprzed pięciu lat nie da się usunąć z kolejki obsługi
   * klienta bez ręcznego sprzątania.
   */
  readonly backfillMode?: "preview" | "import";
  /** Ile wiadomości pobieramy naraz. Chroni pamięć procesu. */
  readonly batchSize?: number;
  /** Domeny firmowe — poczta z nich nie jest sprawą klienta. */
  readonly companyDomains?: readonly string[];
}

export interface EmailSyncResult {
  readonly accountKey: string;
  readonly fetched: number;
  readonly stored: number;
  readonly duplicates: number;
  readonly collisions: number;
  readonly problems: string[];
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly uidValidityChanged: boolean;
  readonly touchedCaseIds: string[];
  readonly backfill: boolean;
  /** Ile wiadomości mieści się w oknie historii. Liczba, nigdy treść. */
  readonly previewCount: number | null;
  readonly previewOnly: boolean;
  readonly batches: number;
}

export async function syncEmailAccount(options: EmailSyncOptions): Promise<EmailSyncResult> {
  const { account, store, reader, now } = options;
  const key: SourceKey = { provider: "email", accountKey: account.accountKey };
  const rawCursor = store.getCursor(key);
  const cursorBefore = decodeCursor(rawCursor);

  const state = await reader.mailboxState(account.folder, options.signal);

  // Zmiana `uidValidity` unieważnia numerację, nie treść. Kursor startuje od
  // zera w NOWEJ przestrzeni UID, a dedup po Message-ID/odcisku pilnuje, żeby
  // ponowny odczyt tych samych wiadomości nie zrobił z nich duplikatów.
  const uidValidityChanged = cursorBefore !== null && cursorBefore.uidValidity !== state.uidValidity;
  const effectiveCursor: ImapCursor | null =
    cursorBefore === null || uidValidityChanged ? null : cursorBefore;

  const mode = options.mode ?? "incremental";
  const isFirstRun = effectiveCursor === null;
  const backfillMode = options.backfillMode ?? "preview";
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  /**
   * PIERWSZY przebieg nie skanuje `1:*`.
   *
   * Zamiast tego pyta serwer o UID-y nie starsze niż okno historii. Skrzynka
   * z dziesięcioletnią korespondencją inaczej trafiłaby w całości do pamięci
   * procesu i do kolejki obsługi klienta — nieodwracalnie.
   */
  let ranges: string[];
  let previewCount: number | null = null;
  let previewOnly = false;

  if (isFirstRun && reader.uidsSince) {
    const days = Math.max(1, options.backfillDays ?? DEFAULT_BACKFILL_DAYS);
    const since = new Date(now - days * 24 * 60 * 60_000);
    const uids = await reader.uidsSince(since, account.folder, options.signal);
    previewCount = uids.length;

    if (backfillMode === "preview") {
      // Podgląd: liczba i zakres, zero zapisów. Aktywacja importu jest osobną,
      // jawną decyzją człowieka (INBOX_BACKFILL_MODE=import).
      previewOnly = true;
      return {
        accountKey: account.accountKey,
        fetched: 0,
        stored: 0,
        duplicates: 0,
        collisions: 0,
        problems: [],
        cursorBefore: rawCursor,
        cursorAfter: rawCursor,
        uidValidityChanged,
        touchedCaseIds: [],
        backfill: true,
        previewCount,
        previewOnly: true,
        batches: 0,
      };
    }
    ranges = chunkUids(uids, batchSize);
  } else {
    ranges = [
      mode === "reconcile"
        ? reconciliationRange(effectiveCursor, options.reconcileLookback ?? DEFAULT_RECONCILE_LOOKBACK)
        : incrementalRange(effectiveCursor, options.overlap ?? DEFAULT_OVERLAP),
    ];
  }

  const records: ParsedRecord[] = [];
  const problems: string[] = [];
  for (const range of ranges) {
    const batch = await reader.fetchRange(range, account.folder, options.signal);
    records.push(...batch.records);
    problems.push(...batch.problems);
  }

  const { threadIndex, subjectIndex } = buildIndexes(store, key);

  let stored = 0;
  let duplicates = 0;
  let collisions = 0;
  let highestStoredUid = effectiveCursor?.lastUid ?? 0;
  const touched = new Set<string>();

  for (const record of records) {
    options.signal?.throwIfAborted();
    const uid = uidOf(record);
    if (uid === null) {
      // Bez UID nie ma czym przesunąć kursora ani czym zrobić fingerprintu.
      problems.push(`rekord bez UID w "${account.folder}"`);
      continue;
    }

    const normalized = normalizeEmail({
      record,
      account,
      uid,
      uidValidity: state.uidValidity,
      now,
      threadIndex,
      subjectIndex,
    });

    const resolved = resolveCollision(store, key, normalized.message);
    if (resolved === "duplicate") {
      duplicates += 1;
      // Duplikat to DOWÓD, że ta wiadomość jest już trwała, więc kursor może
      // ją minąć. Bez tego overlap scan zamrażałby kursor w miejscu.
      if (uid > highestStoredUid) highestStoredUid = uid;
      continue;
    }
    if (resolved.collision) collisions += 1;

    const claimed = store.claimMessage(resolved.message);
    if (!claimed) {
      duplicates += 1;
      if (uid > highestStoredUid) highestStoredUid = uid;
      continue;
    }

    stored += 1;
    touched.add(resolved.message.caseId);
    if (uid > highestStoredUid) highestStoredUid = uid;

    // Indeksy rosną w trakcie partii: druga wiadomość z tego samego wątku ma
    // trafić do tej samej sprawy już w tym przebiegu, a nie dopiero w następnym.
    if (resolved.message.rfcMessageId) {
      threadIndex.set(resolved.message.rfcMessageId, resolved.message.externalConversationId);
    }
    subjectIndex.set(
      subjectFallbackKey(resolved.message.subject, [resolved.message.authorLabel]),
      resolved.message.externalConversationId,
    );
  }

  // Klasyfikacja PO trwałym zapisie całej partii. Odwrotna kolejność znaczyłaby,
  // że awaria oceny może zatrzymać zapis.
  for (const caseId of touched) {
    const projected = projectCase(store, caseId, {
      internalSenders: [account.address],
      companyDomains: options.companyDomains,
    });
    if (projected) store.upsertCase(projected);
  }

  /**
   * Kursor przesuwamy na najwyższy UID FAKTYCZNIE zapisany, nigdy na `uidNext`
   * odczytany na starcie. Wiadomość doręczona w trakcie skanu dostaje UID
   * wyższy od tego, co pobraliśmy; kursor z `uidNext` przeskoczyłby ją,
   * a to jest dokładnie ta cicha utrata, której zabrania kontrakt.
   */
  let cursorAfter: string | null = rawCursor;
  const hadUnreadableRecord = problems.length > 0;
  if (!hadUnreadableRecord && highestStoredUid > 0) {
    const next = encodeCursor({ uidValidity: state.uidValidity, lastUid: highestStoredUid });
    if (next !== rawCursor) {
      store.commitCursor(key, next);
      cursorAfter = next;
    }
  } else if (hadUnreadableRecord && uidValidityChanged) {
    // Nowa przestrzeń UID i nieczytelny rekord naraz: kursor zostaje pusty,
    // żeby kolejny przebieg zaczął od początku, zamiast utrwalać lukę.
    cursorAfter = rawCursor;
  }

  return {
    accountKey: account.accountKey,
    fetched: records.length,
    stored,
    duplicates,
    collisions,
    problems,
    cursorBefore: rawCursor,
    cursorAfter,
    uidValidityChanged,
    touchedCaseIds: [...touched],
    backfill: options.backfill ?? cursorBefore === null,
    previewCount,
    previewOnly,
    batches: ranges.length,
  };
}

/**
 * Odczyt folderu wysłanych.
 *
 * Potrzebny, bo odpowiedzi wychodzą też POZA kanałem: ktoś odpisze
 * z telefonu, z klienta pocztowego, z innego urządzenia. Bez tego kroku
 * kolejka pokazywałaby taką sprawę jako czekającą na reakcję, choć klient
 * odpowiedź dostał wczoraj.
 *
 * Kursor jest osobny od skrzynki odbiorczej: to inny folder i inna przestrzeń
 * UID. Wiadomości wysłane przez kanał są tu wchłaniane przez dedup — o ile
 * mają ten sam `Message-ID`, a jeśli nie, rozpozna je odcisk treści.
 */
export async function syncSentFolder(options: EmailSyncOptions): Promise<EmailSyncResult | null> {
  const { account, store, reader, now } = options;
  if (!account.sentFolder) return null;

  /*
   * Druga, niezależna bramka podglądu.
   *
   * Wywołujący ma nie wchodzić tu w trybie `preview`, ale bramka stoi także
   * tutaj: funkcja zapisująca wiadomości i kursor nie może zależeć wyłącznie
   * od dyscypliny wołającego. Jeden pominięty `continue` w pętli oznaczał
   * zapisy w trybie, który miał być bezskutkowy.
   */
  const firstRun = decodeCursor(store.getCursor({ provider: "email", accountKey: `${account.accountKey}#sent` })) === null;
  if (firstRun && (options.backfillMode ?? "preview") === "preview") return null;

  const key: SourceKey = { provider: "email", accountKey: `${account.accountKey}#sent` };
  const rawCursor = store.getCursor(key);
  const cursorBefore = decodeCursor(rawCursor);
  const state = await reader.mailboxState(account.sentFolder, options.signal);
  const uidValidityChanged = cursorBefore !== null && cursorBefore.uidValidity !== state.uidValidity;
  const effectiveCursor = cursorBefore === null || uidValidityChanged ? null : cursorBefore;

  // Pierwszy odczyt folderu wysłanych bierze tylko okno historii: nie ma
  // powodu wciągać własnej korespondencji sprzed lat.
  let range: string;
  if (effectiveCursor === null && reader.uidsSince) {
    const days = Math.max(1, options.backfillDays ?? DEFAULT_BACKFILL_DAYS);
    const uids = await reader.uidsSince(
      new Date(now - days * 24 * 60 * 60_000),
      account.sentFolder,
      options.signal,
    );
    if (uids.length === 0) return null;
    range = uids.join(",");
  } else {
    range = incrementalRange(effectiveCursor, options.overlap ?? DEFAULT_OVERLAP);
  }

  const { records, problems } = await reader.fetchRange(range, account.sentFolder, options.signal);
  const { threadIndex, subjectIndex } = buildIndexes(store, { provider: "email", accountKey: account.accountKey });

  let stored = 0;
  let duplicates = 0;
  let highestUid = effectiveCursor?.lastUid ?? 0;
  const touched = new Set<string>();

  for (const record of records) {
    const uid = uidOf(record);
    if (uid === null) continue;
    const normalized = normalizeEmail({
      record,
      account,
      uid,
      uidValidity: state.uidValidity,
      now,
      threadIndex,
      subjectIndex,
    });
    // Wszystko w tym folderze jest nasze, niezależnie od tego, co mówi From.
    const outgoing: InboxMessage = { ...normalized.message, direction: "outgoing" };

    if (store.hasMessage({ provider: "email", accountKey: account.accountKey }, outgoing.externalMessageId)) {
      duplicates += 1;
    } else if (store.claimMessage(outgoing)) {
      stored += 1;
      touched.add(outgoing.caseId);
    }
    if (uid > highestUid) highestUid = uid;
  }

  for (const caseId of touched) {
    const projected = projectCase(store, caseId, {
      internalSenders: [account.address],
      companyDomains: options.companyDomains,
    });
    if (projected) store.upsertCase(projected);
  }

  if (problems.length === 0 && highestUid > 0) {
    store.commitCursor(key, encodeCursor({ uidValidity: state.uidValidity, lastUid: highestUid }));
  }

  return {
    accountKey: key.accountKey,
    fetched: records.length,
    stored,
    duplicates,
    collisions: 0,
    problems,
    cursorBefore: rawCursor,
    cursorAfter: store.getCursor(key),
    uidValidityChanged,
    touchedCaseIds: [...touched],
    backfill: cursorBefore === null,
    previewCount: null,
    previewOnly: false,
    batches: 1,
  };
}

function uidOf(record: ParsedRecord): number | null {
  const match = /^imap:.*:(\d+)$/.exec(record.message.providerRef);
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

/**
 * Rozstrzygnięcie kolizji identyfikatorów.
 *
 * Ten sam `Message-ID` i ten sam odcisk treści to ta sama wiadomość: dedup.
 * Ten sam `Message-ID` i INNY odcisk to dwie różne wiadomości od nadawcy
 * z zepsutą konfiguracją; druga dostaje identyfikator z doklejonym odciskiem,
 * bo alternatywą jest jej zgubienie.
 */
function resolveCollision(
  store: InboxStore,
  key: SourceKey,
  message: InboxMessage,
): "duplicate" | { message: InboxMessage; collision: boolean } {
  const existing = store.getMessage(key, message.externalMessageId);
  if (!existing) return { message, collision: false };
  if (existing.contentFingerprint === message.contentFingerprint) return "duplicate";

  const disambiguated = `${message.externalMessageId}#fp:${message.contentFingerprint}`;
  const already = store.getMessage(key, disambiguated);
  if (already) return "duplicate";
  return { message: { ...message, externalMessageId: disambiguated }, collision: true };
}

function buildIndexes(
  store: InboxStore,
  key: SourceKey,
): { threadIndex: Map<string, string>; subjectIndex: Map<string, string> } {
  const threadIndex = new Map<string, string>();
  const subjectIndex = new Map<string, string>();
  for (const message of store.allMessages()) {
    if (message.provider !== key.provider || message.accountKey !== key.accountKey) continue;
    if (message.rfcMessageId) threadIndex.set(message.rfcMessageId, message.externalConversationId);
    subjectIndex.set(
      subjectFallbackKey(message.subject, [message.authorLabel]),
      message.externalConversationId,
    );
  }
  return { threadIndex, subjectIndex };
}
