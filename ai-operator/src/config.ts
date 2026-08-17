import { CapabilityError } from "./capability/types.js";
import { fromPackageRoot } from "./paths.js";

/**
 * Konfiguracja wyłącznie ze zmiennych środowiskowych. W repozytorium nie ma
 * ani jednego sekretu — jest tylko .env.example z nazwami.
 *
 * Dwa tryby uruchomienia:
 *  - MODE=fixture  — poczta i TeaBrew z plików JSON. Domyślny. Działa od razu.
 *  - MODE=live     — prawdziwy IMAP (read-only) i prawdziwe TeaBrew.
 *
 * Tryb fixture nie jest zabawką: to on utrzymuje testy i pozwala pokazać całą
 * ścieżkę bez dawania agentowi dostępu do skrzynki właściciela.
 */

export type Mode = "fixture" | "live";

export interface AppConfig {
  readonly mode: Mode;
  /**
   * Pusty łańcuch, gdy klucza nie ma. NIE jest wymagany do uruchomienia:
   * tryb MCP nie woła modelu wcale (modelem jest Claude po drugiej stronie),
   * a `npm run caps` / `openapi` nie wołają niczego. Brak klucza zgłasza
   * dopiero ModelLayer, w momencie realnej potrzeby.
   */
  readonly anthropicApiKey: string;
  readonly models: { readonly fast: string; readonly reason: string };
  readonly auditFile: string | undefined;
  /** Pamięć Copilota: katalog stanu i parametry monitora w tle. */
  readonly copilot: {
    readonly stateDir: string;
    /**
     * Foldery obserwowane przez monitor. Domyślnie tylko skrzynka odbiorcza —
     * rozszerzenie wymaga DOWODU z `npm run mail:foldery`, nie założenia, że
     * wszystkie foldery są ciekawe.
     */
    readonly monitorFolders: readonly string[];
    readonly intervalMinutes: number;
    readonly firstRunDays: number;
    readonly maxPerFolder: number;
    readonly maxErpLookups: number;
    /**
     * Kto ocenia nową pocztę. `deterministic` (domyślnie) NIE woła modelu
     * i nie kosztuje nic — fakty zbieramy sami, ocenę robi Claude w momencie
     * pytania, na subskrypcji właściciela. `model` wymaga kredytów API.
     */
    readonly classifier: "deterministic" | "model";
    /**
     * Folder wysłanych — do zbudowania listy „z kim faktycznie korespondujemy".
     * To najmocniejszy dostępny bez modelu sygnał „kontrahent, nie wysyłka
     * masowa", bo wynika z naszego własnego działania.
     *
     * NIE MA WARTOŚCI DOMYŚLNEJ i to jest celowe: nazwy folderu wysłanych nie
     * wolno zgadywać (u różnych dostawców to „Sent", „Sent Items", „INBOX.Sent"
     * albo nazwa zlokalizowana). Właściwą nazwę wypisuje `npm run check:mail`,
     * który czyta ją z atrybutu IMAP SPECIAL-USE. Bez tej zmiennej sygnał jest
     * niedostępny i sprawy mówią o tym wprost, zamiast udawać ocenę.
     */
    readonly sentFolder: string | null;
  };
  readonly mail:
    | { readonly kind: "fixture"; readonly filePath: string }
    | {
        readonly kind: "imap";
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly pass: string;
        readonly folder: string;
        readonly threadFolders: readonly string[];
      };
  readonly teabrew:
    | { readonly kind: "fixture"; readonly filePath: string }
    | { readonly kind: "http"; readonly baseUrl: string; readonly token: string };
}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new CapabilityError(
      "not_configured",
      `brak zmiennej środowiskowej ${name} (patrz .env.example)`,
    );
  }
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(): AppConfig {
  const mode = (opt("MODE", "fixture") as Mode) satisfies Mode;
  if (mode !== "fixture" && mode !== "live") {
    throw new CapabilityError("not_configured", `MODE musi być "fixture" albo "live", jest "${mode}"`);
  }

  // Od katalogu pakietu, nie od katalogu roboczego — patrz paths.ts.
  const fixturesDir = fromPackageRoot(opt("FIXTURES_DIR", "fixtures"));
  const auditFileRaw = process.env["AUDIT_FILE"]?.trim();

  return {
    mode,
    anthropicApiKey: opt("ANTHROPIC_API_KEY", ""),
    models: {
      // Role, nie nazwy modeli w miejscach wywołań. Podmiana modelu to zmiana
      // jednej zmiennej środowiskowej, nie przeszukiwanie kodu.
      fast: opt("MODEL_FAST", "claude-haiku-4-5"),
      reason: opt("MODEL_REASON", "claude-opus-5"),
    },
    auditFile: auditFileRaw ? fromPackageRoot(auditFileRaw) : undefined,
    copilot: {
      stateDir: opt("COPILOT_STATE_DIR", "state"),
      monitorFolders: opt("MAIL_MONITOR_FOLDERS", opt("MAIL_FOLDER", "INBOX"))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // Kilkanaście minut, nie sekundy: poczta nie zmienia się częściej,
      // a każdy skan to połączenie IMAP i potencjalnie wywołanie modelu.
      intervalMinutes: Math.max(5, Number(opt("MONITOR_INTERVAL_MINUTES", "15"))),
      firstRunDays: Math.max(1, Number(opt("MONITOR_FIRST_RUN_DAYS", "3"))),
      maxPerFolder: Math.max(1, Number(opt("MONITOR_MAX_PER_FOLDER", "50"))),
      maxErpLookups: Math.max(0, Number(opt("MONITOR_MAX_ERP_LOOKUPS", "10"))),
      classifier: opt("MONITOR_CLASSIFIER", "deterministic") === "model" ? "model" : "deterministic",
      sentFolder: process.env["MAIL_SENT_FOLDER"]?.trim() || null,
    },
    mail:
      mode === "live"
        ? {
            kind: "imap",
            host: req("MAIL_IMAP_HOST"),
            port: Number(opt("MAIL_IMAP_PORT", "993")),
            user: req("MAIL_IMAP_USER"),
            pass: req("MAIL_IMAP_PASSWORD"),
            folder: opt("MAIL_FOLDER", "INBOX"),
            // "auto" = skrzynka odbiorcza plus folder wysłanych wykryty po
            // atrybucie SPECIAL-USE. Nazwy folderu wysłanych nie wolno zgadywać;
            // bez niego agent nie widzi naszych odpowiedzi.
            threadFolders: opt("MAIL_THREAD_FOLDERS", "auto")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : { kind: "fixture", filePath: `${fixturesDir}/mail/inbox.json` },
    teabrew:
      mode === "live"
        ? {
            kind: "http",
            baseUrl: req("TEABREW_BASE_URL"),
            token: req("TEABREW_AI_OPERATOR_TOKEN"),
          }
        : { kind: "fixture", filePath: `${fixturesDir}/teabrew/erp.json` },
  };
}
