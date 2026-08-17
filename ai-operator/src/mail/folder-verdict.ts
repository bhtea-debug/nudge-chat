import type { FolderStat } from "./imap.js";

/**
 * Ocena folderu: monitorować, rozważyć, pominąć.
 *
 * Osobny moduł, nie funkcja w pliku bin, bo ta heurystyka na prawdziwej skrzynce
 * pomyliła się dwa razy — i musi być pokryta testami, a plik bin z `main()` na
 * poziomie modułu nie da się zaimportować bez uruchomienia narzędzia.
 *
 * Każda ocena nosi POWÓD. Heurystyka ma prawo się mylić; nie ma prawa robić
 * tego niewidocznie.
 */

export type Verdict = "monitoruj" | "rozważ" | "pomiń";

export interface Judged extends FolderStat {
  readonly verdict: Verdict;
  readonly why: string;
}

/** Folder „aktywny": coś przyszło w tym okresie. */
const ACTIVE_DAYS = 30;
/** Powyżej tyle wiadomości traktujemy folder jako archiwum, nie bieżącą pracę. */
const ARCHIVE_SIZE = 5_000;
/**
 * Udział nieprzeczytanych, powyżej którego folder wygląda na ZBIORNIK, a nie
 * na bieżącą pracę. Znalezione na prawdziwej skrzynce: folder „Blocked" miał 985
 * nieprzeczytanych z 1157 i wpadał dzisiaj — więc heurystyka „aktywny" uznała go
 * za wart monitorowania. To błąd: monitorowanie folderu, którego właściciel
 * świadomie nie czyta, karmi model pocztą bez znaczenia.
 */
const SINK_UNREAD_RATIO = 0.6;
const SINK_MIN_SIZE = 200;

const daysAgo = (iso: string | null): number | null =>
  iso === null ? null : (Date.now() - new Date(iso).getTime()) / 86_400_000;

/**
 * Ocena jest heurystyką i ma być jawna, nie ukryta w kodzie — dlatego każdy
 * wiersz nosi powód. Człowiek ma móc się z nią nie zgodzić w konkretnym punkcie.
 */
export function judge(f: FolderStat): Judged {
  const age = daysAgo(f.newestAt);

  if (f.error) return { ...f, verdict: "pomiń", why: `nie udało się odczytać: ${f.error}` };

  // `null` to NIE zero. Serwer potrafi nie podać liczników bez zgłoszenia błędu
  // (np. folder \Noselect), a wtedy „pusty" byłoby zmyśleniem — to ta sama
  // pomyłka, którą pilnujemy w capability: brak danych nie jest wartością zero.
  if (f.messages === null) {
    return {
      ...f,
      verdict: "rozważ",
      why: "serwer nie podał liczby wiadomości — NIE zakładam, że folder jest pusty; sprawdź go ręcznie",
    };
  }
  if (f.messages === 0) return { ...f, verdict: "pomiń", why: "pusty" };

  // Foldery systemowe: kosz, spam, szkice, wysłane. Wysłane są już używane do
  // rekonstrukcji wątków (MAIL_THREAD_FOLDERS) i nie potrzebują monitorowania —
  // monitor szuka rzeczy PRZYCHODZĄCYCH.
  const special = (f.specialUse ?? "").toLowerCase();
  if (["\\trash", "\\junk", "\\drafts"].includes(special)) {
    return { ...f, verdict: "pomiń", why: `folder systemowy (${f.specialUse})` };
  }
  if (special === "\\sent") {
    return { ...f, verdict: "pomiń", why: "wysłane — używane do wątków, nie do monitorowania" };
  }

  if (age === null) return { ...f, verdict: "rozważ", why: "nie udało się ustalić daty ostatniej wiadomości" };
  if (age > ACTIVE_DAYS) {
    return { ...f, verdict: "pomiń", why: `martwy — ostatnia wiadomość ${Math.round(age)} dni temu` };
  }

  // Zbiornik: dużo wiadomości i prawie nic przeczytanego. Nazwa („Blocked",
  // „Spam", cokolwiek) nie ma tu znaczenia — liczy się to, że właściciel tego
  // nie czyta. Zostawiamy „rozważ", a nie „pomiń", bo tylko on wie, co tam trafia.
  const unreadRatio = f.unseen !== null && f.messages > 0 ? f.unseen / f.messages : 0;
  if (f.messages >= SINK_MIN_SIZE && unreadRatio >= SINK_UNREAD_RATIO) {
    return {
      ...f,
      verdict: "rozważ",
      why:
        `wygląda na zbiornik — ${f.unseen} z ${f.messages} nieprzeczytanych ` +
        `(${Math.round(unreadRatio * 100)}%). Monitoruj TYLKO jeśli naprawdę tam zaglądasz`,
    };
  }

  if (f.messages > ARCHIVE_SIZE) {
    return {
      ...f,
      verdict: "rozważ",
      why: `aktywny, ale duży (${f.messages} wiadomości) — monitor czyta tylko nowe, więc rozmiar nie boli, ale sprawdź, czy to nie archiwum`,
    };
  }

  if (special === "\\inbox" || f.path.toUpperCase() === "INBOX") {
    return { ...f, verdict: "monitoruj", why: "skrzynka odbiorcza" };
  }

  return {
    ...f,
    verdict: "monitoruj",
    why: `aktywny — ostatnia wiadomość ${age < 1 ? "dzisiaj" : `${Math.round(age)} dni temu`}`,
  };
}

