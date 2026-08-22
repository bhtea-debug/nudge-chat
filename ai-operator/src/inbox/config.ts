import { CapabilityError } from "../capability/types.js";
import type { EmailAccount } from "./providers/email/normalize.js";
import type { MetaAccount } from "./providers/meta/webhook.js";

/**
 * Konfiguracja kanału obsługi klienta — wyłącznie ze zmiennych środowiskowych.
 *
 * Nazwy są jawne i per konto, bo trzy skrzynki muszą mieć trzy niezależne
 * sekrety. Jeden wspólny login do wszystkiego znaczyłby, że rotacja hasła
 * jednej skrzynki wyłącza obsługę klienta w całej firmie.
 *
 * Nic tu nie ma wartości domyślnej, która mogłaby coś wysłać. Brak
 * konfiguracji = funkcja wyłączona i powiedziane wprost, a nie ciche „działa".
 */

export interface InboxEmailSource extends EmailAccount {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
}

export interface InboxMetaSource extends MetaAccount {
  /**
   * Identyfikator używany w wywołaniach Graph API.
   *
   * Dla Instagrama to PAGE ID połączonej strony, a NIE identyfikator konta
   * Instagram: wysyłka i lista rozmów idą pod adres strony, natomiast webhooki
   * przychodzą z `entry.id` równym identyfikatorowi konta IG. Zmieszanie tych
   * dwóch identyfikatorów daje 404 przy wysyłce i nierozpoznane konto przy
   * odbiorze. Zweryfikowane w dokumentacji Meta 2026-08-22.
   */
  readonly pageId: string;
  readonly accessToken: string;
}

export interface InboxOutboundConfig {
  /** Klucz Resend o minimalnych uprawnieniach. Brak = wysyłka e-mail wyłączona. */
  readonly resendApiKey: string | null;
  readonly resendWebhookSecret: string | null;
  /** Sekret aplikacji Meta do weryfikacji podpisu webhooka. */
  readonly metaAppSecret: string | null;
  readonly metaVerifyToken: string | null;
}

export interface InboxConfig {
  readonly enabled: boolean;
  readonly stateDir: string;
  readonly email: readonly InboxEmailSource[];
  readonly meta: readonly InboxMetaSource[];
  /** Czy adapter Allegro (przez TeaBrew) jest częścią kolejki. */
  readonly allegroEnabled: boolean;
  readonly outbound: InboxOutboundConfig;
  /** Ile dni historii bierze pierwszy import. Rekomendacja, nie automat. */
  readonly backfillDays: number;
  /**
   * Rytm synchronizacji. Pierwszy przebieg jest opóźniony, żeby health po
   * starcie nie czekał na połączenie IMAP.
   */
  readonly tickFirstDelayMs: number;
  readonly tickIntervalMs: number;
  /**
   * Pierwszy import jest OSOBNĄ, jawną decyzją.
   *
   * Bez tego pierwsze uruchomienie zaciąga całą historię skrzynki, a zakres
   * historyczny jest nieodwracalny. Domyślnie tryb jest podglądowy: adapter
   * policzy, ile wiadomości mieści się w oknie, i nie zapisze ani jednej.
   */
  readonly backfillMode: "preview" | "import";
}

function envKey(accountKey: string): string {
  return accountKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function value(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function required(name: string): string {
  const raw = value(name);
  if (!raw) {
    throw new CapabilityError("not_configured", `brak zmiennej środowiskowej ${name}`);
  }
  return raw;
}

export function loadInboxConfig(): InboxConfig {
  const accountsRaw = value("INBOX_EMAIL_ACCOUNTS");
  const metaRaw = value("INBOX_META_ACCOUNTS");

  const email = (accountsRaw ? accountsRaw.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((accountKey): InboxEmailSource => {
      const prefix = `INBOX_EMAIL_${envKey(accountKey)}`;
      const port = Number(value(`${prefix}_PORT`) ?? "993");
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new CapabilityError("not_configured", `${prefix}_PORT musi być numerem portu`);
      }
      return {
        accountKey,
        label: value(`${prefix}_LABEL`) ?? `E-mail ${accountKey}`,
        host: required(`${prefix}_HOST`),
        port,
        secure: (value(`${prefix}_TLS`) ?? "true") !== "false",
        user: required(`${prefix}_USER`),
        pass: required(`${prefix}_PASSWORD`),
        address: required(`${prefix}_ADDRESS`).toLowerCase(),
        folder: value(`${prefix}_FOLDER`) ?? "INBOX",
        // Folder wysłanych służy WYŁĄCZNIE obserwacji. Nigdy nie jest ledgerem
        // wysyłki: Resend tam nie zapisuje, więc brak kopii nie znaczy „nie poszło".
        sentFolder: value(`${prefix}_SENT_FOLDER`),
      };
    });

  const meta = (metaRaw ? metaRaw.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((alias): InboxMetaSource => {
      const prefix = `INBOX_META_${envKey(alias)}`;
      const provider = required(`${prefix}_PROVIDER`);
      if (provider !== "instagram" && provider !== "facebook") {
        throw new CapabilityError(
          "not_configured",
          `${prefix}_PROVIDER musi być "instagram" albo "facebook"`,
        );
      }
      return {
        provider,
        // Klucz konta to identyfikator strony/konta Meta, nie alias z listy:
        // po nim przychodzą webhooki i po nim rozpoznajemy właściciela rozmowy.
        accountKey: required(`${prefix}_ID`),
        // Dla Facebooka strona jest tym samym kontem; dla Instagrama trzeba
        // podać PAGE ID osobno, bo webhook i API mówią o innych numerach.
        pageId: value(`${prefix}_PAGE_ID`) ?? required(`${prefix}_ID`),
        label: value(`${prefix}_LABEL`) ?? (provider === "instagram" ? "Instagram" : "Facebook"),
        accessToken: required(`${prefix}_TOKEN`),
      };
    });

  const backfillDays = Number(value("INBOX_BACKFILL_DAYS") ?? "30");
  const tickFirstDelay = Number(value("INBOX_TICK_FIRST_DELAY_MS") ?? "25000");
  const tickInterval = Number(value("INBOX_TICK_INTERVAL_MS") ?? "300000");
  const backfillMode = value("INBOX_BACKFILL_MODE") === "import" ? "import" : "preview";

  return {
    enabled: (value("INBOX_ENABLED") ?? "false") === "true",
    stateDir: value("INBOX_STATE_DIR") ?? "state",
    email,
    meta,
    allegroEnabled: (value("INBOX_ALLEGRO_ENABLED") ?? "true") !== "false",
    outbound: {
      resendApiKey: value("INBOX_RESEND_API_KEY"),
      resendWebhookSecret: value("INBOX_RESEND_WEBHOOK_SECRET"),
      metaAppSecret: value("INBOX_META_APP_SECRET"),
      metaVerifyToken: value("INBOX_META_VERIFY_TOKEN"),
    },
    backfillDays: Number.isFinite(backfillDays) && backfillDays > 0 ? Math.floor(backfillDays) : 30,
    // Dolne ograniczenia są celowe: tick co sekundę zajechałby serwer poczty,
    // a zerowe opóźnienie startu blokowałoby health tuż po deployu.
    tickFirstDelayMs:
      Number.isFinite(tickFirstDelay) && tickFirstDelay >= 100 ? Math.floor(tickFirstDelay) : 25_000,
    tickIntervalMs:
      Number.isFinite(tickInterval) && tickInterval >= 1_000 ? Math.floor(tickInterval) : 300_000,
    backfillMode,
  };
}

/**
 * Czy wolno wysyłać e-mail.
 *
 * Fail-closed: bez klucza i bez potwierdzonej tożsamości nadawcy przycisk
 * wysyłki ma być nieaktywny, a nie „spróbujmy i zobaczymy".
 */
export function emailOutboundReady(config: InboxConfig, accountKey: string): boolean {
  if (!config.outbound.resendApiKey) return false;
  return config.email.some((source) => source.accountKey === accountKey);
}

export function metaOutboundReady(config: InboxConfig, accountKey: string): boolean {
  return config.meta.some((source) => source.accountKey === accountKey && source.accessToken.length > 0);
}
