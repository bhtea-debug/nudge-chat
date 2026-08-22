import { ImapMailProvider } from "../mail/imap.js";
import { loadInboxConfig, type InboxConfig, type InboxEmailSource } from "./config.js";
import type { SourceKey } from "./contract.js";
import { recordFailure, recordSuccess, sanitizeMessage, type FailureKind } from "./health.js";
import { syncEmailAccount, type EmailSyncResult } from "./providers/email/sync.js";
import { InboxStore } from "./store.js";
import { WebhookDedup } from "./outbound/webhooks.js";
import { fetchConversations, GraphError } from "./providers/meta/graph.js";
import { ingestMetaEvents } from "./providers/meta/ingest.js";

/**
 * Uruchomienie kanału: konfiguracja, trwały stan, harmonogram synchronizacji.
 *
 * Jeden proces, jeden store. Dwa równoległe store na tym samym pliku dawałyby
 * dwie kopie stanu w pamięci i ostatni zapis wygrywałby po cichu.
 */

/** Co ile ticków zwykłych wchodzi szeroki skan uzgadniający. */
const RECONCILE_EVERY = 12;

export interface InboxRuntime {
  readonly config: InboxConfig;
  readonly store: InboxStore;
  readonly webhookDedup: WebhookDedup;
  tick(now: number, signal?: AbortSignal): Promise<TickReport>;
}

export interface MetaTickResult {
  readonly accountKey: string;
  readonly provider: string;
  readonly stored: number;
  readonly duplicates: number;
  readonly pages: number;
  readonly truncated: boolean;
}

export interface TickReport {
  readonly at: number;
  readonly email: EmailSyncResult[];
  readonly meta: MetaTickResult[];
  readonly failures: Array<{ readonly source: string; readonly kind: FailureKind; readonly message: string }>;
  readonly reconcile: boolean;
}

let runtime: InboxRuntime | null = null;

export function inboxRuntime(): InboxRuntime | null {
  if (runtime) return runtime;
  let config: InboxConfig;
  try {
    config = loadInboxConfig();
  } catch {
    // Zła albo niepełna konfiguracja wyłącza kanał w całości. Częściowo
    // skonfigurowany kanał obsługi klienta jest gorszy od wyłączonego, bo
    // wygląda na działający.
    return null;
  }
  if (!config.enabled) return null;
  runtime = createRuntime(config);
  return runtime;
}

/** Do testów: budowa runtime bez czytania środowiska. */
export function createRuntime(config: InboxConfig, store?: InboxStore): InboxRuntime {
  const state = store ?? new InboxStore({ dir: config.stateDir });
  const readers = new Map<string, ImapMailProvider>();
  let ticks = 0;

  function readerFor(source: InboxEmailSource): ImapMailProvider {
    const existing = readers.get(source.accountKey);
    if (existing) return existing;
    // Osobne połączenie na skrzynkę: wspólna pula znaczyłaby, że zerwanie
    // jednego połączenia zabiera trzy skrzynki naraz.
    const provider = new ImapMailProvider({
      host: source.host,
      port: source.port,
      user: source.user,
      pass: source.pass,
      secure: source.secure,
      folder: source.folder,
      threadFolders: source.sentFolder ? [source.sentFolder] : [],
    });
    readers.set(source.accountKey, provider);
    return provider;
  }

  async function tick(now: number, signal?: AbortSignal): Promise<TickReport> {
    ticks += 1;
    const reconcile = ticks % RECONCILE_EVERY === 0;
    const email: EmailSyncResult[] = [];
    const meta: TickReport["meta"] = [];
    const failures: TickReport["failures"] = [];

    for (const source of config.email) {
      const key: SourceKey = { provider: "email", accountKey: source.accountKey };
      const health = state.getHealth(key);
      // Backoff respektujemy per źródło. Zepsuta skrzynka nie ma prawa
      // spowalniać dwóch zdrowych.
      if (health?.nextAttemptAt && now < health.nextAttemptAt) continue;

      try {
        const result = await syncEmailAccount({
          account: source,
          store: state,
          reader: readerFor(source),
          now,
          mode: reconcile ? "reconcile" : "incremental",
          backfillDays: config.backfillDays,
          backfillMode: config.backfillMode,
          signal,
        });
        email.push(result);
        if (result.previewOnly) {
          // Podgląd nie jest synchronizacją: nie wolno mu zapalić zielonego
          // światła, bo do kolejki nie trafiła ani jedna wiadomość.
          recordFailure(
            state,
            { key, label: source.label, active: true },
            "error",
            `pierwszy import czeka na zatwierdzenie: ${result.previewCount ?? 0} wiadomości w oknie`,
            now,
          );
          failures.push({
            source: `email:${source.accountKey}`,
            kind: "error",
            message: `pierwszy import czeka na zatwierdzenie (${result.previewCount ?? 0})`,
          });
        } else if (result.problems.length > 0) {
          // Partia z nieczytelnym rekordem NIE jest sukcesem: kursor stoi,
          // a zdrowie musi to pokazać, zamiast raportować świeżość.
          recordFailure(
            state,
            { key, label: source.label, active: true },
            "error",
            `nieczytelne wiadomości: ${result.problems.length}`,
            now,
          );
          failures.push({
            source: `email:${source.accountKey}`,
            kind: "error",
            message: `nieczytelne wiadomości: ${result.problems.length}`,
          });
        } else {
          recordSuccess(state, { key, label: source.label, active: true }, now);
        }
      } catch (error) {
        const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
        const kind = classifyFailure(message);
        recordFailure(state, { key, label: source.label, active: true }, kind, message, now);
        failures.push({ source: `email:${source.accountKey}`, kind, message });
      }
    }

    /*
     * Meta: uzgodnienie przez Graph API.
     *
     * Poprzednia wersja zapisywała tu SUKCES tylko dlatego, że konto było
     * skonfigurowane. Źródło świeciło się na zielono, nie wykonawszy ani
     * jednego odczytu — czyli kropka mówiła coś, czego nikt nie sprawdził.
     * Teraz zielone światło daje wyłącznie udany odczyt albo zweryfikowany
     * webhook.
     */
    for (const source of config.meta) {
      const key: SourceKey = { provider: source.provider, accountKey: source.accountKey };
      const health = state.getHealth(key);
      if (health?.nextAttemptAt && now < health.nextAttemptAt) continue;
      // Uzgodnienie jest kosztowne; w zwykłym ticku polegamy na webhooku.
      if (!reconcile && health?.lastSuccessfulSyncAt) continue;

      try {
        const result = await fetchConversations({
          account: {
            provider: source.provider,
            accountKey: source.accountKey,
            label: source.label,
            pageId: source.pageId,
            accessToken: source.accessToken,
          },
          sinceMs: now - config.backfillDays * 24 * 60 * 60_000,
          now,
          signal,
        });
        const ingested = ingestMetaEvents(
          state,
          result.messages.map((message) => ({ kind: "message" as const, message })),
        );
        meta.push({
          accountKey: source.accountKey,
          provider: source.provider,
          stored: ingested.stored,
          duplicates: ingested.duplicates,
          pages: result.pages,
          truncated: result.truncated,
        });
        recordSuccess(state, { key, label: source.label, active: true }, now);
      } catch (error) {
        const code = error instanceof GraphError ? error.code : "error";
        const kind: FailureKind =
          code === "reconnect_required"
            ? "reconnect_required"
            : code === "rate_limited"
              ? "rate_limited"
              : "error";
        const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
        recordFailure(state, { key, label: source.label, active: true }, kind, message, now);
        failures.push({ source: `${source.provider}:${source.accountKey}`, kind, message });
      }
    }

    return { at: now, email, meta, failures, reconcile };
  }

  return { config, store: state, webhookDedup: new WebhookDedup(), tick };
}

function classifyFailure(message: string): FailureKind {
  const lower = message.toLowerCase();
  if (lower.includes("auth") || lower.includes("login") || lower.includes("credential")) {
    return "reconnect_required";
  }
  if (lower.includes("too many") || lower.includes("rate")) return "rate_limited";
  return "error";
}

/** Do testów: kasuje singleton. */
export function resetInboxRuntime(): void {
  runtime = null;
}
