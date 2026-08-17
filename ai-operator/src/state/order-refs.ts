/**
 * Rozpoznawanie numerów zamówień w surowym tekście — bez modelu.
 *
 * Powstało po realnej wpadce. Pierwsza wersja brała „każdą liczbę od czterech
 * cyfr", bo taki wzorzec działał w triage — ale tam dostawał numery, które model
 * już wcześniej WYBRAŁ semantycznie z treści. Zastosowany do surowego tematu
 * i podglądu dawał:
 *
 *   „Warunki na Q4 — prośba o rabat 12%"        → 1800   (tonaż z treści)
 *   „Ostatnie dni rejestracji na targi opakowań" → 2026   (rok)
 *
 * Każda taka liczba trafiała potem do TeaBrew, wracała jako „nie znam" i sprawa
 * dostawała wysoki priorytet z alarmem. Raport mówiący „3 numerów nie ma
 * w systemie", gdzie dwa to rok i tonaż, traci zaufanie w pierwszym dniu —
 * i wtedy przestaje działać także w dniu, w którym numer jest prawdziwy.
 *
 * Dlatego numer musi mieć POWÓD, żeby zostać uznanym za numer. Jeden z trzech:
 *
 *  1. **prefiks literowy** — `RB-2026-118`, `ZP/06/2026/00016`, `ZK/123`;
 *     żaden rok ani tonaż tak nie wygląda,
 *  2. **słowo kluczowe obok** — „zamówienie 2307029", „zam. nr 99999",
 *     „faktura 12345"; kontekst mówi wprost, czym jest ta liczba,
 *  3. **co najmniej sześć cyfr pod rząd** — prawdziwe numery zamówień w tej
 *     firmie mają siedem (`2307029`, `2271126`), a rok ma cztery.
 *
 * Świadomie odrzucamy samotne liczby 4–5-cyfrowe bez kontekstu. To znaczy, że
 * przeoczymy krótki numer wspomniany bez słowa „zamówienie" — i to jest wybrana
 * strona pomyłki: brakujący numer właściciel zauważy czytając maila, natomiast
 * fałszywy alarm psuje cały mechanizm.
 */

/**
 * Słowa, po których liczba jest numerem sprawy, a nie liczbą.
 *
 * Rozdzielone na dwie listy, bo bez tego wzorzec dopasowywał się WEWNĄTRZ wyrazów.
 * Pierwsza wersja miała na liście „po" (od purchase order) — i „po" trafiało
 * w „**Po**twierdzenie wysyłki", po czym z tej samej wiadomości wyciągało rok
 * 2026 jako numer zamówienia. Krótkie słowa muszą być całymi wyrazami.
 *
 * „po" wypadło całkowicie: w polskiej korespondencji to przyimek, więc jako
 * sygnał jest bezużyteczny, a jako wzorzec — szkodliwy.
 */
const STEMS = [
  "zamówieni",
  "zamowieni",
  "zlecen",
  "faktur",
  "numer",
  "order",
  "partia",
  "partii",
  "przesyłk",
  "przesylk",
  "list przewozowy",
];

/** Krótkie i wieloznaczne — dopasowujemy WYŁĄCZNIE jako całe wyrazy. */
const WHOLE_WORDS = ["nr", "wz", "zk", "zp"];

/**
 * Słowa, po których liczba JEST identyfikatorem, ale NIE numerem zamówienia.
 *
 * Znalezione na prawdziwej poczcie: temat „NIP: 8842745578 / 5210000143581…"
 * dawał NIP jako numer zamówienia, bo ma dziesięć cyfr. Trafiał do TeaBrew,
 * wracał jako brak i sprawa dostawała wysoki priorytet z alarmem.
 *
 * Kontekst rozstrzyga to pewniej niż długość: numer zamówienia może mieć
 * dziesięć cyfr, ale nigdy nie stoi po słowie „NIP".
 */
const NOT_ORDER = [
  "nip",
  "regon",
  "krs",
  "pesel",
  "iban",
  "vat",
  "konto",
  "rachunek",
  "tel",
  "telefon",
  "kod",
  "pin",
];

/** Czy tuż przed tym numerem stoi słowo mówiące, że to NIE numer zamówienia. */
function precededByNonOrder(text: string, index: number): boolean {
  // Patrzymy na ~16 znaków wstecz: „NIP: ", „NIP ", „nr rachunku ".
  const before = text.slice(Math.max(0, index - 16), index).toLowerCase();
  return NOT_ORDER.some((w) => new RegExp(`\\b${w}\\b[^\\p{L}\\d]{0,6}$`, "u").test(before));
}

/** Liczba z prefiksem literowym: RB-2026-118, ZP/06/2026/00016, ZK/123. */
const PREFIXED = /\b[A-Z]{2,4}[/-]\d{1,6}(?:[/-]\d{1,6}){0,3}\b/g;

/**
 * Cyfry muszą być SAMODZIELNYM tokenem, nie fragmentem czegoś większego.
 *
 * Bez tego reguła słowa kluczowego sięgała w środek numeru kontrahenta:
 * „partia dostawcy RB-2026-118" dawało numer `2026`, bo słowo „partia"
 * uruchamiało regułę, a przechwytywanie nie było przywiązane do granicy tokenu.
 * Sam `\b` nie wystarcza — między „-" i „2" granica wyrazu istnieje.
 */
const TOKEN_START = "(?<![\\w/-])";
const TOKEN_END = "(?![\\w/-])";

/**
 * Siedem cyfr lub więcej. Próg wzięty z PRAWDZIWEJ numeracji tej firmy:
 * zamówienia Rossmanna to `2307029`, `2271126`, `2307348` — zawsze siedem.
 *
 * Sześć cyfr było za mało: kod logowania do sklepu (`348819 to Twój kod
 * logowania`) trafiał do TeaBrew i wracał jako brak. Numery 4–6-cyfrowe nadal
 * są rozpoznawane, ale tylko gdy obok stoi słowo kluczowe.
 */
const LONG_DIGITS = new RegExp(`${TOKEN_START}\\d{7,}${TOKEN_END}`, "g");

/**
 * Liczba 4–5-cyfrowa poprzedzona słowem kluczowym w promieniu ~24 znaków.
 * Grupa 1 to sam numer.
 */
const AFTER_KEYWORD = new RegExp(
  `(?:\\b(?:${STEMS.join("|")})|\\b(?:${WHOLE_WORDS.join("|")})\\b|\\bzam\\.)` +
    `[^\\d\\n]{0,24}?${TOKEN_START}(\\d{4,})${TOKEN_END}`,
  "gi",
);

/** Zakres, w którym samotna czterocyfrowa liczba jest prawie zawsze rokiem. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/** Czy ten numer, wzięty samotnie, wygląda na rok. */
export function looksLikeYear(ref: string): boolean {
  if (!/^\d{4}$/.test(ref)) return false;
  const n = Number(ref);
  return n >= YEAR_MIN && n <= YEAR_MAX;
}

export interface FoundRef {
  readonly ref: string;
  /** Dlaczego uznaliśmy to za numer — trafia do historii sprawy, nie do promptu. */
  readonly why: "prefiks" | "słowo kluczowe" | "długi numer";
}

export function findOrderRefs(text: string): FoundRef[] {
  const out = new Map<string, FoundRef>();

  for (const m of text.matchAll(PREFIXED)) {
    const ref = m[0].trim();
    if (!out.has(ref)) out.set(ref, { ref, why: "prefiks" });
  }

  for (const m of text.matchAll(LONG_DIGITS)) {
    const ref = m[0].trim();
    // NIP, REGON, numer konta — identyfikatory, ale nie zamówienia.
    if (m.index !== undefined && precededByNonOrder(text, m.index)) continue;
    if (!out.has(ref)) out.set(ref, { ref, why: "długi numer" });
  }

  for (const m of text.matchAll(AFTER_KEYWORD)) {
    const ref = (m[1] ?? "").trim();
    if (!ref) continue;
    // Rok po słowie „nr" bywa przypadkiem („nr 2026"), ale po „zamówienie"
    // już nie. Dopuszczamy, bo kontekst jest mocniejszym sygnałem niż zakres —
    // z jednym wyjątkiem: samotny rok po samym „nr" to zbyt słaba przesłanka.
    if (looksLikeYear(ref) && /\bnr[^\d\n]{0,4}$/i.test(m[0].slice(0, m[0].length - ref.length))) {
      continue;
    }
    if (m.index !== undefined && precededByNonOrder(text, m.index + m[0].indexOf(ref))) continue;
    if (!out.has(ref)) out.set(ref, { ref, why: "słowo kluczowe" });
  }

  return [...out.values()];
}

/** Same numery, bez uzasadnień — do miejsc, które ich nie potrzebują. */
export function extractOrderRefs(text: string): string[] {
  return findOrderRefs(text).map((f) => f.ref);
}

/** Najdłuższy numer zamówienia, jaki ma sens sprawdzać w TeaBrew. */
const MAX_OWN_DIGITS = 12;

/**
 * Czy ten numer ma KSZTAŁT numeru zamówienia w naszym systemie — czyli czy
 * warto go sprawdzać w TeaBrew i alarmować jego nieobecnością.
 *
 * Odrzucamy dwie rzeczy, każdą z powodu potwierdzonego na prawdziwych danych:
 *
 *  1. **prefiks literowy** (`RB-2026-118`, `INV/2026/44`) — to zwykle numeracja
 *     dostawcy albo klienta. Jej brak w TeaBrew jest OCZEKIWANY.
 *  2. **numer dłuższy niż 12 cyfr** — to numer przesyłki, rachunku albo telefonu.
 *     Realny przykład ze skrzynki: `521000014358100142097412` z powiadomienia
 *     InPostu. Sprawdzanie tego w TeaBrew gwarantuje odpowiedź „nie znam",
 *     czyli fałszywy alarm za każdym razem.
 *
 * Numer odrzucony tutaj NADAL zostaje w sprawie — jest wskaźnikiem, po którym
 * można szukać. Nie jest tylko podstawą do alarmu.
 *
 * Funkcja czysta i zależna wyłącznie od kształtu, więc nie trzeba przechowywać
 * w sprawie informacji o tym, jak numer został znaleziony.
 */
export function isOwnOrderShape(ref: string): boolean {
  return new RegExp(`^\\d{4,${MAX_OWN_DIGITS}}$`).test(ref);
}
