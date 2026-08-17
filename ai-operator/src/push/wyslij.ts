import webpush from "web-push";
import type { Subskrypcje } from "./subskrypcje.js";

/**
 * Wysłanie powiadomienia na urządzenia właściciela.
 *
 * ── Dlaczego Web Push, a nie gotowa aplikacja typu ntfy/Pushover ──────────────
 * Bo ładunek jest szyfrowany **end-to-end** (RFC 8291): klucze pochodzą
 * z subskrypcji konkretnego urządzenia, a bramka push — u nas Apple —
 * przekazuje szyfrogram. Przy alertach zawierających nazwy klientów i numery
 * zamówień to jest różnica między „treść widzi tylko właściciel" a „treść widzi
 * także cudzy serwer". Dodatkowo: zero kosztów i ani jednej nowej usługi.
 *
 * ── Czego ten moduł NIE robi ──────────────────────────────────────────────────
 * Nie decyduje, CO jest warte powiadomienia. Dostaje gotowy alert i go wysyła.
 * Dobór treści to osobny problem i — jak pokazał spike UX — znacznie trudniejszy
 * niż dostarczenie.
 */

export interface Alert {
  readonly tytul: string;
  readonly tresc: string;
  readonly waga: Waga;
  /** Gdy ustawiony, nowe powiadomienie ZASTĘPUJE poprzednie o tym samym tagu. */
  readonly tag?: string | undefined;
}

export type Waga = "pilne" | "zwykle" | "informacja";

export interface KonfiguracjaPush {
  readonly publiczny: string;
  readonly prywatny: string;
  /** Adres kontaktowy wymagany przez VAPID — bramka push może się odezwać. */
  readonly kontakt: string;
}

/**
 * Alert starszy niż cztery godziny stracił sens: albo sprawa została załatwiona,
 * albo dawno przestała być „natychmiast". Bramka push wyrzuci go wtedy sama,
 * zamiast dostarczyć nieaktualny.
 */
const TTL_SEK = 4 * 3600;

export function konfiguracjaZeSrodowiska(): KonfiguracjaPush | null {
  const publiczny = (process.env["VAPID_PUBLIC_KEY"] ?? "").trim();
  const prywatny = (process.env["VAPID_PRIVATE_KEY"] ?? "").trim();
  if (!publiczny || !prywatny) return null;
  const kontakt = (process.env["VAPID_SUBJECT"] ?? "mailto:kontakt@brownhouseandtea.pl").trim();
  return { publiczny, prywatny, kontakt };
}

export interface WynikWysylki {
  readonly wyslane: number;
  readonly usuniete: number;
  readonly bledy: string[];
}

/**
 * Wysyła alert na wszystkie zapisane urządzenia.
 *
 * Subskrypcje, które bramka odrzuca jako nieistniejące (404/410), są **kasowane**.
 * Bez tego lista rośnie o martwe wpisy, a każdy z nich to jedno nieudane
 * połączenie przy każdym alercie — czyli powolne psucie się czegoś, co wygląda
 * na działające.
 */
export async function wyslij(
  cfg: KonfiguracjaPush,
  magazyn: Subskrypcje,
  alert: Alert,
): Promise<WynikWysylki> {
  webpush.setVapidDetails(cfg.kontakt, cfg.publiczny, cfg.prywatny);

  const ladunek = JSON.stringify({
    tytul: alert.tytul,
    tresc: alert.tresc,
    waga: alert.waga,
    tag: alert.tag ?? null,
  });

  let wyslane = 0;
  let usuniete = 0;
  const bledy: string[] = [];

  for (const s of magazyn.wszystkie()) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
        ladunek,
        { TTL: TTL_SEK, urgency: alert.waga === "pilne" ? "high" : "normal" },
      );
      wyslane += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        magazyn.usun(s.endpoint);
        usuniete += 1;
      } else {
        // Adresu bramki NIE wpisujemy do błędu — jest sekretem urządzenia.
        bledy.push(`${status ?? "?"}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { wyslane, usuniete, bledy };
}
