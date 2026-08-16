import { CapabilityError } from "./capability/types.js";

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
  readonly anthropicApiKey: string;
  readonly models: { readonly fast: string; readonly reason: string };
  readonly auditFile: string | undefined;
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

  const fixturesDir = opt("FIXTURES_DIR", "fixtures");

  return {
    mode,
    anthropicApiKey: req("ANTHROPIC_API_KEY"),
    models: {
      // Role, nie nazwy modeli w miejscach wywołań. Podmiana modelu to zmiana
      // jednej zmiennej środowiskowej, nie przeszukiwanie kodu.
      fast: opt("MODEL_FAST", "claude-haiku-4-5"),
      reason: opt("MODEL_REASON", "claude-opus-5"),
    },
    auditFile: process.env["AUDIT_FILE"]?.trim() || undefined,
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
