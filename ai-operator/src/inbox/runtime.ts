import { ImapMailProvider } from "../mail/imap.js";
import { loadInboxConfig, type InboxConfig, type InboxEmailSource } from "./config.js";
import type { SourceKey } from "./contract.js";
import { recordFailure, recordSuccess, sanitizeMessage, type FailureKind } from "./health.js";
import { syncEmailAccount, syncSentFolder, type EmailSyncResult } from "./providers/email/sync.js";
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
/**
 * Zakładka okna uzgodnienia Meta.
 *
 * Kursor cofamy o godzinę, bo `updated_time` rozmowy i czas wiadomości to dwie
 * różne rzeczy: rozmowa zaktualizowana o 12:00 może zawierać wiadomość
 * z 11:58, a okno bez zakładki zostawiłoby ją poza zakresem na zawsze.
 */
const META_WINDOW_OVERLAP_MS = 60 * 60_000;

/** Początek okna uzgodnienia: kursor albo pełny backfill przy pierwszym razie. */
function metaWindowStart(
  state: InboxStore,
  key: SourceKey,
  now: number,
  backfillDays: number,
): number {
  const raw = state.getCursor(key);
  const parsed = raw === null ? Number.NaN : Number(raw);
  const fullWindow = now - backfillDays * 24 * 60 * 60_000;
  if (!Number.isFinite(parsed)) return fullWindow;
  // Nigdy nie sięgamy dalej wstecz niż okno backfillu: kursor z przyszłości
  // albo zepsuty nie ma prawa rozszerzyć zakresu.
  return Math.max(fullWindow, parsed);
}

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
          companyDomains: config.companyDomains,
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
          /*
           * KONIEC obsługi tego źródła.
           *
           * Bez tego `continue` przebieg szedł dalej do folderu wysłanych,
           * który zapisuje wiadomości, sprawy i kursor — czyli tryb „podgląd"
           * wykonywał zapisy. Podgląd ma być całkowicie bezskutkowy, inaczej
           * jest tylko obietnicą.
           */
          continue; // podglad nie wykonuje ZADNYCH zapisow
        }

        if (result.problems.length > 0) {
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

        /*
         * Folder wysłanych: odpowiedzi udzielone POZA kanałem.
         *
         * Ktoś odpisze z telefonu albo z klienta pocztowego i kolejka nie ma
         * skąd o tym wiedzieć — pokazywałaby sprawę jako czekającą na reakcję,
         * choć klient odpowiedź dostał wczoraj.
         */
        if (source.sentFolder) {
          try {
            const sent = await syncSentFolder({
              account: source,
              store: state,
              reader: readerFor(source),
              now,
              backfillDays: config.backfillDays,
              companyDomains: config.companyDomains,
              signal,
            });
            if (sent) email.push(sent);
          } catch (error) {
            // Folder wysłanych jest sygnałem uzupełniającym: jego awaria nie
            // ma prawa zepsuć odczytu skrzynki odbiorczej.
            failures.push({
              source: `email:${source.accountKey}#sent`,
              kind: "error",
              message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
            });
          }
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
          // Okno liczone od zapisanego kursora, a nie zawsze od pełnego
          // backfillu: bez tego każde uzgodnienie przemiata miesiąc historii.
          sinceMs: metaWindowStart(state, key, now, config.backfillDays),
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

        /*
         * Niepełne uzgodnienie NIE jest sukcesem.
         *
         * Wcześniej zapisywaliśmy sukces także wtedy, gdy zostały nieprzeczytane
         * rozmowy albo wiadomości — a wtedy zielona kropka mówiła „mamy
         * wszystko" o stanie, w którym wprost wiemy, że czegoś brakuje.
         * Następny przebieg dokończy pracę; do tego czasu źródło jest
         * zdegradowane i widać to w kanale.
         */
        if (result.truncated) {
          const what = result.truncatedConversations
            ? "rozmowy poza pobranymi stronami"
            : `nieprzeczytane wiadomości w ${result.truncatedMessages.length} rozmowach`;
          recordFailure(
            state,
            { key, label: source.label, active: true },
            "error",
            `uzgodnienie niepełne: ${what}`,
            now,
          );
          failures.push({
            source: `${source.provider}:${source.accountKey}`,
            kind: "error",
            message: `uzgodnienie niepełne: ${what}`,
          });
        } else {
          recordSuccess(state, { key, label: source.label, active: true }, now);
          // Kursor okna: następne uzgodnienie startuje od ostatniej znanej
          // aktywności minus zakładka, żeby nie zostawić luki na granicy.
          if (result.newestUpdatedAt !== null) {
            state.commitCursor(key, String(result.newestUpdatedAt - META_WINDOW_OVERLAP_MS));
          }
        }
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
