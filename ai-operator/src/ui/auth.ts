import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Brama do UI.
 *
 * Ten interfejs pokazuje pocztę firmy i stan operacyjny, i stoi w internecie,
 * żeby działał z telefonu. Dlatego:
 *
 *  - **hasło nie jest w kodzie ani w repozytorium** — wyłącznie zmienna
 *    środowiskowa, jak wszystkie pozostałe sekrety w tym projekcie,
 *  - **token nigdy nie idzie w URL.** Adres trafia do historii przeglądarki,
 *    do nagłówka `Referer` i do logów pośredników. Sesja siedzi w ciasteczku
 *    `HttpOnly`, `Secure`, `SameSite=Strict`,
 *  - **ciasteczko jest podpisane, nie jest bazą sesji.** Nie trzymamy stanu
 *    sesji w pamięci procesu, bo restart kontenera wylogowywałby właściciela
 *    w środku dnia bez żadnego powodu,
 *  - **porównania w czasie stałym.** Zwykłe `===` na sekrecie wycieka długość
 *    wspólnego prefiksu.
 *
 * Świadomie NIE ma tu: rejestracji, wielu użytkowników, ról ani OAuth.
 * ARCHITEKTURA-AI-2026 §15 zabrania budowania autoryzacji wewnątrz tej warstwy,
 * a jeden aktor — właściciel — jest dziś całą listą uprawnionych. Gdy pojawi się
 * druga osoba, tożsamość wraca jako decyzja projektowa, nie jako `if` tutaj.
 */

export const SESSION_COOKIE = "bht_sesja";
/** Ile trwa sesja. Tydzień: właściciel nie ma logować się codziennie na telefonie. */
export const SESSION_TTL_SEC = 7 * 24 * 3600;
/** Minimalna długość hasła. Krótsze nie jest sekretem, tylko zagadką. */
export const MIN_PASSWORD_LENGTH = 12;

export interface AuthConfig {
  /** Hasło do UI. Puste = UI nie wstaje. */
  readonly password: string;
  /** Sekret do podpisywania ciasteczek. */
  readonly signingKey: string;
  /** Czy wymagać HTTPS na ciasteczku. Wyłączane tylko dla testów lokalnych. */
  readonly secureCookie: boolean;
}

/**
 * Hasło porównujemy przez scrypt, nie przez zwykłe porównanie łańcuchów.
 *
 * Powód praktyczny: to jedyna bramka między internetem a pocztą firmy, a scrypt
 * czyni zgadywanie kosztownym także wtedy, gdy właściciel wybierze hasło
 * krótsze, niż powinien. Sól jest stała w obrębie procesu i wyprowadzona
 * z klucza podpisującego — nie przechowujemy bazy użytkowników, więc nie ma
 * gdzie trzymać soli per wpis, a stała sól nadal spełnia swoją rolę wobec
 * ataku zdalnego (tu nie ma wykradzionej bazy haseł do porównania offline).
 */
function hash(password: string, signingKey: string): Buffer {
  return scryptSync(password, `bht-copilot:${signingKey.slice(0, 16)}`, 32);
}

export class UiAuth {
  private readonly expected: Buffer;
  private readonly signingKey: string;
  private readonly secureCookie: boolean;

  constructor(cfg: AuthConfig) {
    this.expected = hash(cfg.password, cfg.signingKey);
    this.signingKey = cfg.signingKey;
    this.secureCookie = cfg.secureCookie;
  }

  passwordMatches(provided: string): boolean {
    const got = hash(provided, this.signingKey);
    return timingSafeEqual(got, this.expected);
  }

  /** Podpisany znacznik sesji: `wygasa.podpis`. Bez danych osobowych w środku. */
  issue(now: number = Date.now()): string {
    const expires = Math.floor(now / 1000) + SESSION_TTL_SEC;
    return `${expires}.${this.sign(String(expires))}`;
  }

  /** Czy ciasteczko jest nasze i jeszcze obowiązuje. */
  valid(cookieValue: string | null, now: number = Date.now()): boolean {
    if (!cookieValue) return false;
    const dot = cookieValue.lastIndexOf(".");
    if (dot <= 0) return false;
    const expires = cookieValue.slice(0, dot);
    const signature = cookieValue.slice(dot + 1);
    if (!/^\d+$/.test(expires)) return false;

    // Kolejność ma znaczenie: najpierw podpis, potem czas. Odrzucenie po samym
    // czasie zdradzałoby, że wartość była poprawnie podpisana.
    const want = this.sign(expires);
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(want, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return Number(expires) * 1000 > now;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }

  cookieHeader(value: string): string {
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${SESSION_TTL_SEC}`,
    ];
    if (this.secureCookie) parts.push("Secure");
    return parts.join("; ");
  }

  clearCookieHeader(): string {
    const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (this.secureCookie) parts.push("Secure");
    return parts.join("; ");
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Ogranicznik prób logowania.
 *
 * Osobny od ogranicznika żądań MCP i celowo znacznie ostrzejszy: pięć prób na
 * dziesięć minut. Bez tego jedna bramka hasłowa w internecie jest zaproszeniem
 * do zgadywania, a scrypt sam wystarcza tylko przy ataku offline.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 10 * 60_000,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.attempts.set(key, recent);
    return recent.length < this.max;
  }

  record(key: string, now: number = Date.now()): void {
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

/** Sekret podpisujący, gdy właściciel go nie ustawił. Losowy per proces. */
export function ephemeralSigningKey(): string {
  return randomBytes(32).toString("base64url");
}
