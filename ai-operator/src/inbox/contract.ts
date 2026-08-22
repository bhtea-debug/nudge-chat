import { z } from "zod";

/**
 * Generyczny model domenowy kanału „Obsługa klienta".
 *
 * Powstał, bo kolejka przestała być kolejką Allegro. Nazwy `allegro*` opisywały
 * jedno źródło; tu opisujemy KAŻDE źródło, więc identyfikator dostawcy jest
 * zwykłym stringiem walidowanym przez rejestr, a nie zamkniętą unią w zapisie.
 * Dodanie WhatsAppa ma być wpisem w rejestrze, nie migracją schematu.
 */

/** Identyfikator dostawcy. Walidację „czy znany" robi rejestr, nie typ. */
export const ProviderId = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, "provider: małe litery, cyfry i podkreślenie");
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * Konto w obrębie dostawcy: skrzynka `sklep|biuro|hurt`, strona FB, konto IG,
 * a dla Allegro rozróżnienie Centrum wiadomości i Dyskusji.
 *
 * Osobny klucz konta jest tu po to, żeby każde konto miało własny kursor,
 * własne zdrowie i własną tożsamość nadawcy. Jedna zdrowa skrzynka nie może
 * zamaskować zepsutej, a odpowiedź nie może wyjść z cudzego adresu.
 */
export const AccountKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "accountKey: bez spacji i znaków sterujących");
export type AccountKey = z.infer<typeof AccountKey>;

export const SourceKey = z.object({ provider: ProviderId, accountKey: AccountKey }).strict();
export type SourceKey = z.infer<typeof SourceKey>;

export function sourceKeyString(key: SourceKey): string {
  return `${key.provider}:${key.accountKey}`;
}

export const MessageDirection = z.enum(["incoming", "outgoing", "system"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const AttachmentMeta = z
  .object({
    id: z.string().min(1).max(256),
    fileName: z.string().max(256).nullable(),
    mimeType: z.string().max(128).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

/**
 * Wiadomość znormalizowana. `sourceCreatedAt` to czas ŹRÓDŁA — nigdy czas
 * kliknięcia ani czas zapisu. Gdy źródło go nie poda, pole jest null i UI ma
 * o tym mówić, zamiast podstawiać własny zegar (patrz `receivedAt`).
 */
export const InboxMessage = z
  .object({
    provider: ProviderId,
    accountKey: AccountKey,
    externalConversationId: z.string().min(1).max(256),
    externalMessageId: z.string().min(1).max(512),
    caseId: z.string().min(1).max(128),
    direction: MessageDirection,
    /** Czas nadania wg źródła. */
    sourceCreatedAt: z.number().int().positive().nullable(),
    /** Czas trwałego zapisu u nas. Służy do diagnostyki, nie do SLA. */
    receivedAt: z.number().int().positive(),
    authorLabel: z.string().max(256).nullable(),
    subject: z.string().max(998).nullable(),
    body: z.string().max(64_000),
    bodyTruncated: z.boolean(),
    attachments: z.array(AttachmentMeta).max(50),
    /** Nagłówki wątkowania RFC — wyłącznie e-mail. */
    rfcMessageId: z.string().max(998).nullable().default(null),
    rfcInReplyTo: z.string().max(998).nullable().default(null),
    rfcReferences: z.array(z.string().max(998)).max(50).default([]),
    /** Echo własnej wysyłki rozpoznane po webhooku/ledgerze. */
    isEcho: z.boolean().default(false),
    /**
     * Odcisk treści: nadawca, czas, temat, ciało. Rozstrzyga kolizję
     * identyfikatorów, gdy nadawca wysyła serię z jednym `Message-ID`.
     * Ten sam odcisk to ta sama wiadomość i dedup ma ją pochłonąć; inny odcisk
     * pod tym samym identyfikatorem to DWIE wiadomości i obie muszą przeżyć.
     */
    contentFingerprint: z.string().min(8).max(64),
  })
  .strict();
export type InboxMessage = z.infer<typeof InboxMessage>;

export const WorkflowState = z.enum(["new", "in_progress", "closed"]);
export type WorkflowState = z.infer<typeof WorkflowState>;

/**
 * Powód klasyfikacji. Zapisujemy powód i wersję, żeby reklasyfikacja była
 * odtwarzalna i żeby dało się zobaczyć, czemu coś trafiło (albo nie trafiło)
 * do kolejki — bez trzymania treści.
 */
export const ClassificationReason = z.enum([
  "customer_message",
  "answered",
  "pending_action",
  "bulk_or_marketing",
  "automated_report",
  "internal_sender",
  "thanks_only",
  "low_confidence_fail_open",
  "classifier_error_fail_open",
  "source_closed",
]);
export type ClassificationReason = z.infer<typeof ClassificationReason>;

export const CLASSIFIER_VERSION = 1;

export const InboxCase = z
  .object({
    caseId: z.string().min(1).max(128),
    provider: ProviderId,
    accountKey: AccountKey,
    externalConversationId: z.string().min(1).max(256),
    subject: z.string().max(998).nullable(),
    participantLabel: z.string().max(256).nullable(),
    orderRef: z.string().max(128).nullable(),
    firstSeenAt: z.number().int().positive(),
    lastMessageAt: z.number().int().positive().nullable(),
    lastIncomingMessageId: z.string().max(512).nullable(),
    lastIncomingAt: z.number().int().positive().nullable(),
    messageCount: z.number().int().nonnegative(),
    requiresResponse: z.boolean(),
    pendingAction: z.boolean(),
    classifierVersion: z.number().int().nonnegative(),
    classificationReason: ClassificationReason,
    sourceClosed: z.boolean(),
    hasAttachments: z.boolean(),
  })
  .strict();
export type InboxCase = z.infer<typeof InboxCase>;

export const HealthState = z.enum([
  "ok",
  "backoff",
  "reconnect_required",
  "missing_scope",
  "rate_limited",
  "error",
  "never_synced",
  "disabled",
]);
export type HealthState = z.infer<typeof HealthState>;

/**
 * Zdrowie pojedynczego źródła. `lastSuccessfulSyncAt` jest osobno od
 * `lastAttemptAt`, bo „próbowaliśmy" nie jest tym samym co „mamy dane".
 */
export const SourceHealth = z
  .object({
    provider: ProviderId,
    accountKey: AccountKey,
    label: z.string().min(1).max(64),
    state: HealthState,
    active: z.boolean(),
    lastSuccessfulSyncAt: z.number().int().positive().nullable(),
    lastAttemptAt: z.number().int().positive().nullable(),
    nextAttemptAt: z.number().int().positive().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    /** Krótki, nietechniczny komunikat. Bez treści, adresów i payloadów. */
    message: z.string().max(200).nullable(),
  })
  .strict();
export type SourceHealth = z.infer<typeof SourceHealth>;

/**
 * Progi świeżości trzymane centralnie. W UI nie ma być magicznych liczb —
 * inaczej za pół roku „5 minut" znaczy co innego na karcie i w alarmie.
 */
export const FRESHNESS_POLICY = {
  okMs: 5 * 60_000,
  warnMs: 10 * 60_000,
  alarmMs: 15 * 60_000,
} as const;

export type OverallFreshnessState = "green" | "yellow" | "red";

/**
 * Ogólna świeżość liczona z NAJSTARSZEGO sukcesu wśród aktywnych źródeł.
 * Wersja z najnowszym sukcesem pokazuje zielono, gdy jedna skrzynka żyje,
 * a trzy pozostałe leżą — czyli dokładnie wtedy, kiedy nie wolno.
 */
export function overallFreshness(
  sources: readonly SourceHealth[],
  now: number,
): {
  state: OverallFreshnessState;
  oldestSuccessAt: number | null;
  ageMs: number | null;
  degradedSources: string[];
} {
  const active = sources.filter((s) => s.active);
  if (active.length === 0) {
    return { state: "red", oldestSuccessAt: null, ageMs: null, degradedSources: [] };
  }
  const degraded = active
    .filter((s) => s.state === "reconnect_required" || s.state === "missing_scope" || s.state === "error")
    .map((s) => sourceKeyString(s));
  const neverSynced = active.filter((s) => s.lastSuccessfulSyncAt === null);
  if (neverSynced.length > 0) {
    return {
      state: "red",
      oldestSuccessAt: null,
      ageMs: null,
      degradedSources: [...new Set([...degraded, ...neverSynced.map((s) => sourceKeyString(s))])],
    };
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const source of active) {
    if (source.lastSuccessfulSyncAt !== null && source.lastSuccessfulSyncAt < oldest) {
      oldest = source.lastSuccessfulSyncAt;
    }
  }
  const oldestSuccessAt = Number.isFinite(oldest) ? oldest : null;
  const ageMs = oldestSuccessAt === null ? null : Math.max(0, now - oldestSuccessAt);
  let state: OverallFreshnessState = "green";
  if (degraded.length > 0) state = "red";
  else if (ageMs !== null && ageMs >= FRESHNESS_POLICY.alarmMs) state = "red";
  else if (ageMs !== null && ageMs >= FRESHNESS_POLICY.okMs) state = "yellow";
  return { state, oldestSuccessAt, ageMs, degradedSources: degraded };
}

/** Tryb treści. `model` redaguje dane kontaktowe przed analizą AI. */
export const ContentMode = z.enum(["none", "display", "model"]);
export type ContentMode = z.infer<typeof ContentMode>;
