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

export interface ImapReader {
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
  const range =
    mode === "reconcile"
      ? reconciliationRange(effectiveCursor, options.reconcileLookback ?? DEFAULT_RECONCILE_LOOKBACK)
      : incrementalRange(effectiveCursor, options.overlap ?? DEFAULT_OVERLAP);

  const { records, problems } = await reader.fetchRange(range, account.folder, options.signal);

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
