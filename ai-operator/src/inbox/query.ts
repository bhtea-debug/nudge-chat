import { createHash } from "node:crypto";
import type { ContentMode, InboxCase, InboxMessage } from "./contract.js";
import { channelFreshness, mayReportEmptyQueue, type ChannelFreshness } from "./health.js";
import type { InboxStore, StoredCase } from "./store.js";
import { evaluateSla, type Priority, type SlaState } from "./sla.js";
import { resolveRecipient } from "./outbound/recipient.js";
import { metaSendWindow } from "./providers/meta/webhook.js";

/**
 * Odczyt kolejki dla firmowego czatu.
 *
 * Domyślnie BEZ treści. Temat i podgląd wiadomości są danymi klienta, więc
 * jadą tylko wtedy, gdy odbiorca jawnie o nie poprosi i poda tryb. Zwykłe
 * odświeżanie listy nie ma prawa przenosić korespondencji przez sieć.
 */

export interface CaseDto {
  readonly caseId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly sourceLabel: string;
  readonly participantLabel: string | null;
  readonly orderRef: string | null;
  readonly subject: string | null;
  readonly preview: string | null;
  readonly firstSeenAt: number;
  readonly lastMessageAt: number | null;
  readonly lastIncomingAt: number | null;
  readonly lastIncomingMessageId: string | null;
  readonly waitingMs: number | null;
  readonly messageCount: number;
  readonly requiresResponse: boolean;
  readonly pendingAction: boolean;
  readonly hasAttachments: boolean;
  readonly sourceClosed: boolean;
  readonly classifierVersion: number;
  readonly classificationReason: string;
  /** Sprawa niejednoznaczna — do potwierdzenia przez człowieka. */
  readonly needsReview: boolean;
  readonly priority: Priority | null;
  readonly slaState: SlaState | null;
  readonly responseDueAt: number | null;
  readonly serviceMaxAt: number | null;
  /**
   * Odbiorca i konto nadawcze wyliczone SERWEROWO.
   *
   * Interfejs ma pokazać człowiekowi, dokąd i z czego pójdzie odpowiedź,
   * zanim ją zatwierdzi — a wartości muszą pochodzić z tego samego źródła,
   * którego użyje wysyłka. Podgląd liczony osobno w przeglądarce mógłby
   * pokazać co innego, niż faktycznie poleci.
   */
  readonly replyTo: string | null;
  readonly replyFrom: string | null;
  readonly replyWindowClosesAt: number | null;
}

/**
 * Co odbiorca ma zrobić z tym wynikiem.
 *
 * `restart_from_top` = przewijanie przestało być spójne; sklejone strony NIE są
 * całą kolejką i jedyne wyjście to odczyt od góry (bez kursora).
 */
export type QueueRecommendation = "none" | "restart_from_top";

export interface QueueResult {
  readonly cases: CaseDto[];
  /** Autorytatywny rozmiar zbioru PO filtrach, w chwili tego odczytu. */
  readonly count: number;
  /**
   * false = to jest cały widok. true = nie jest, bo albo są dalsze strony,
   * albo przewijanie przestało być spójne (patrz `snapshotChanged`).
   *
   * Para `truncated === false && nextCursor === null` to jedyny sygnał
   * „to cała kolejka" i nie wolno jej wystawić, gdy coś mogło umknąć.
   */
  readonly truncated: boolean;
  /**
   * Nieprzezroczysty kursor następnej strony TEGO przewijania. `null` znaczy,
   * że tym kursorem nie ma czego dokończyć: przy `truncated === false` to
   * koniec kompletnej listy, a przy `truncated === true` — polecenie odczytu
   * od góry, bo dalszy ciąg nie miałby już sensu.
   */
  readonly nextCursor: string | null;
  /**
   * Wersja listy spraw (po filtrach) w chwili odczytu: identyczna wersja =
   * identyczna lista co do kolejności i składu. Odbiorca może ją porównywać
   * między stronami; sygnałem ROZSTRZYGAJĄCYM jest jednak `snapshotChanged`,
   * bo sama zmiana wersji bywa nieszkodliwa (patrz komentarz przy kursorze).
   */
  readonly setVersion: string;
  /**
   * true = podczas tego przewijania nad już przeczytaną część weszła sprawa,
   * której to przewijanie nie wyda. Sklejonego wyniku NIE WOLNO ogłosić jako
   * kompletnej kolejki — brakuje w nim co najmniej jednej sprawy.
   */
  readonly snapshotChanged: boolean;
  readonly recommendation: QueueRecommendation;
  readonly freshness: ChannelFreshness;
  /**
   * false = nie wolno napisać „brak spraw" ani „to wszystkie sprawy". Pusta
   * lista przy zepsutym źródle to brak wiedzy, nie brak pracy — a widok
   * sklejony z niespójnego przewijania to brak jednej sprawy.
   */
  readonly completeView: boolean;
  readonly contentMode: ContentMode;
}

export interface QueueOptions {
  readonly now: number;
  /** Adresy skrzynek: potrzebne do podglądu konta nadawczego. */
  readonly mailboxes?: ReadonlyMap<string, string>;
  readonly state?: "actionable" | "all";
  readonly providers?: readonly string[];
  readonly accountKeys?: readonly string[];
  readonly limit?: number;
  readonly contentMode?: ContentMode;
  readonly cursor?: string | null;
}

const DEFAULT_LIMIT = 200;
const PREVIEW_CHARS = 140;

export function queryQueue(store: InboxStore, options: QueueOptions): QueueResult {
  const contentMode = options.contentMode ?? "none";
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 500);
  const state = options.state ?? "actionable";

  let cases = store.listCases();
  if (options.providers?.length) {
    const allowed = new Set(options.providers);
    cases = cases.filter((entry) => allowed.has(entry.provider));
  }
  if (options.accountKeys?.length) {
    const allowed = new Set(options.accountKeys);
    cases = cases.filter((entry) => allowed.has(entry.accountKey));
  }
  if (state === "actionable") {
    cases = cases.filter((entry) => entry.requiresResponse || entry.pendingAction);
  }

  /*
   * Sortowanie musi być całkowite, inaczej kursor nie jest stabilny: dwie
   * sprawy z tym samym czasem mogłyby zamieniać się miejscami między stronami
   * i jedna z nich nie trafiłaby na żadną.
   */
  cases.sort((a, b) => {
    const byTime = sortKey(b) - sortKey(a);
    return byTime !== 0 ? byTime : a.caseId.localeCompare(b.caseId);
  });

  const total = cases.length;
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  /*
   * Keyset: bierzemy rekordy ostro „mniejsze" od kursora w porządku kolejki.
   * Żadnego szukania indeksu — pozycja jest określona samym kluczem, więc
   * zniknięcie rekordu z kursora niczego nie cofa.
   */
  const remaining = cursor ? cases.filter((entry) => isBelowCursor(entry, cursor)) : cases;
  const page = remaining.slice(0, limit);
  const morePages = page.length < remaining.length;

  /*
   * Czoło listy w chwili STARTU przewijania. Pierwsza strona je ustala, każda
   * następna niesie je w kursorze. Bez tego nie da się odróżnić rekordu, który
   * był nad kursorem od początku (wydany), od takiego, który wskoczył tam po
   * drodze (przepadnie).
   */
  const runHead = cursor?.head ?? (cases.length > 0 ? sortKey(cases[0]!) : null);
  const emitted = (cursor?.emitted ?? 0) + page.length;
  const digest = extendDigest(cursor?.digest ?? "0", page);
  // Pierwsza strona nie ma jak niczego zgubić: zaczyna się od czoła listy.
  const snapshotChanged = cursor !== null && missesCase(cases, remaining, cursor);
  const freshness = channelFreshness(store, options.now);

  return {
    cases: page.map((entry) => toDto(store, entry, options.now, contentMode, options.mailboxes)),
    count: total,
    /*
     * `truncated` mówi WYŁĄCZNIE o tym, czy są dalsze strony.
     *
     * Wcześniej zlepiało to z sygnałem zmiany zbioru, co wyglądało na
     * uproszczenie („jeden warunek zamiast dwóch"), a w praktyce zapętlało
     * naiwnego klienta: na żywej kolejce zmiana zbioru trwa, więc `truncated`
     * zostawało prawdziwe na zawsze i pętla po stronach nie miała jak się
     * skończyć. Kompletność ma własne pole i własne znaczenie.
     */
    truncated: morePages,
    /*
     * Postęp jest zagwarantowany: ostatni rekord strony jest ostro mniejszy od
     * kursora, którym go pobrano, a następna strona bierze tylko rekordy ostro
     * mniejsze od niego. Pusta strona nie ma następnika, więc pętla po stronach
     * zawsze się kończy.
     *
     * Przy `snapshotChanged` na końcu przebiegu kursor jest pusty ŚWIADOMIE:
     * dalszego ciągu nie ma, a jedyna droga do brakującej sprawy prowadzi przez
     * odczyt od góry. Odesłanie kursora „od nowa" zapętliłoby naiwnego klienta
     * na żywej kolejce.
     */
    nextCursor:
      morePages && page.length > 0
        ? encodeCursor(page[page.length - 1]!, {
            head: runHead,
            emitted,
            digest,
            // Ślad jest LEPKI: gdyby gasł na następnej stronie, ostatnia strona
            // przebiegu znów ogłaszałaby komplet.
            dirty: snapshotChanged,
          })
        : null,
    setVersion: setVersionOf(cases, state, options.providers, options.accountKeys),
    snapshotChanged,
    recommendation: snapshotChanged ? "restart_from_top" : "none",
    freshness,
    completeView: mayReportEmptyQueue(freshness) && !snapshotChanged,
    contentMode,
  };
}

/**
 * Czy to przewijanie MOGŁO ominąć sprawę.
 *
 * Nie pytamy „czy zbiór się zmienił", tylko „czy nad przeczytaną częścią jest
 * coś, czego nie wydaliśmy". Różnica jest praktyczna: człowiek odpowiadający na
 * sprawy w trakcie przewijania zmienia zbiór przy każdej stronie (sprawa wypada
 * z filtra „do zrobienia"), a ubytek WYDANEJ już sprawy niczego nie ukrywa.
 * Sygnał zapalany od każdej zmiany świeciłby zawsze i zostałby zignorowany —
 * czyli byłby wart tyle, co jego brak.
 */
function missesCase(
  all: readonly StoredCase[],
  remaining: readonly StoredCase[],
  cursor: QueueCursor,
): boolean {
  if (cursor.dirty) return true;
  /*
   * Kursor ze starszego wydania: nie niesie ani czoła przebiegu, ani licznika
   * wydanych rekordów. Nie mamy CZYM potwierdzić kompletności, więc jej nie
   * obiecujemy — jeden zbędny odczyt od góry jest tańszy niż jedna sprawa
   * zgubiona po cichu.
   */
  if (cursor.head === null || cursor.emitted === null || cursor.digest === null) return true;
  const head = cursor.head;
  /*
   * Rekord z kluczem wyższym niż czoło z chwili startu wszedł nad przeczytaną
   * część już po starcie: albo jest nowy, albo dostał nową wiadomość i skoczył
   * na czoło. Tak czy inaczej to przewijanie go nie wyda.
   */
  if (all.some((entry) => sortKey(entry) > head)) return true;

  /*
   * ZBIÓR nad kursorem musi być dokładnie tym, co przebieg już wydał.
   *
   * Poprzednia wersja porównywała LICZBY i dawała się zamaskować: wystarczyło,
   * żeby w tej samej chwili jedna sprawa zjechała pod kursor (ktoś na nią
   * odpowiedział, więc wypadła z filtra „do zrobienia"), a druga weszła nad
   * kursor, ale poniżej czoła przebiegu. Liczba rekordów nad kursorem zostawała
   * ta sama, więc porównanie milczało, a nowa sprawa nie była wydana ani razu.
   * Odpowiedź kończyła się wtedy słowami „to cała kolejka" przy brakującej
   * sprawie, czyli dokładnie tym, czemu ten mechanizm ma zapobiegać.
   *
   * Suma kontrolna porównuje zbiory, więc ubytek i dodanie nie mogą się już
   * znieść. Cena jest świadoma: sprawa obsłużona w trakcie przewijania też
   * zmienia zbiór i zapala sygnał. To jest uczciwe — kolejka faktycznie się
   * zmieniła — a kontrakt woli jeden zbędny odczyt od góry od jednej sprawy
   * zgubionej po cichu.
   */
  const above = all.filter((entry) => !isBelowCursor(entry, cursor));
  return digestOf(above) !== cursor.digest;
}

/**
 * Wersja listy spraw: skrót z filtrów, rozmiaru i całego porządku (klucz plus
 * identyfikator). Nie zmienia się od edycji, która nie rusza listy — temat czy
 * podgląd sprawy nie mają wpływu na to, co i w jakiej kolejności przewijamy.
 *
 * Filtry wchodzą do skrótu celowo: kursor z innego zestawu filtrów opisuje inny
 * zbiór, więc porównanie wersji ma to pokazać zamiast udawać ten sam przebieg.
 */
function setVersionOf(
  cases: readonly StoredCase[],
  state: string,
  providers?: readonly string[],
  accountKeys?: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(
    `${state}\u0000${[...(providers ?? [])].sort().join(",")}` +
      `\u0000${[...(accountKeys ?? [])].sort().join(",")}\u0000${cases.length}`,
  );
  for (const entry of cases) hash.update(`\u0000${sortKey(entry)}:${entry.caseId}`);
  return hash.digest("hex").slice(0, 16);
}


/**
 * Klucz porządku kolejki. Jedno miejsce, żeby sortowanie i kursor nie mogły
 * rozjechać się w interpretacji „kiedy ta sprawa ostatnio drgnęła".
 */
function sortKey(entry: StoredCase): number {
  return entry.lastMessageAt ?? entry.firstSeenAt;
}

/**
 * Kursor keyset: klucz sortowania ostatniej sprawy wydanej strony (czas
 * i caseId) PLUS stan całego przebiegu. Nie offset i nie „pozycja sprawy
 * o tym identyfikatorze".
 *
 * Poprzednia wersja niosła same dwie wartości pozycji, ale czas ignorowała
 * i szukała bieżącego indeksu po caseId. To był nazwany offset: gdy sprawa
 * z kursora zniknęła albo wypadła z filtra „do zrobienia", odczyt wracał na
 * początek i powtarzał niemal całą poprzednią stronę — przy stronie 200 do 199
 * slotów zmarnowanych, a przy state="actionable" widok krążył po pierwszej
 * stronie przy wiecznie prawdziwym `truncated`.
 *
 * Stan przebiegu w kursorze to trzy wartości:
 * - `head`  — klucz czoła listy w chwili startu przewijania,
 * - `emitted` — ile rekordów przebieg dotąd wydał,
 * - `dirty` — czy już wcześniej wykryto ubytek (ślad LEPKI).
 * Bez nich odpowiedź nie miała jak odróżnić „przeczytałem wszystko" od
 * „przeczytałem wszystko oprócz sprawy, która uciekła mi nad kursor".
 *
 * KONTRAKT wobec zmian w trakcie stronicowania (kolejka żyje pod czytającym):
 * - sprawa, która po wydaniu strony przesunęła się W GÓRĘ nad kursor (dostała
 *   nową wiadomość), nie wejdzie już do tego przewijania. Żeby ją złapać,
 *   trzeba by cofnąć kursor, czyli zrezygnować z postępu — więc zamiast tego
 *   odpowiedź JAWNIE mówi `snapshotChanged: true` i zaleca odczyt od góry,
 *   gdzie sprawa jest już na czele. Milczenie w tym miejscu było usterką:
 *   odbiorca sklejał strony i ogłaszał kompletną kolejkę bez jednej sprawy;
 * - sprawa, która przesunęła się W DÓŁ pod kursor, może wyjść drugi raz.
 *   Duplikat jest tani (odbiorca odsiewa po `caseId`), luka nie jest;
 * - sprawa DODANA nad kursorem nie należy do tego przewijania i jest liczona
 *   tak samo jak przesunięta: przebieg nie ma prawa udawać, że jej nie ma;
 * - sprawa z kursora może zniknąć albo wypaść z filtra bez żadnych skutków:
 *   kursor jest kluczem w porządku, nie wskaźnikiem na rekord. Ubytek sprawy
 *   już WYDANEJ niczego nie ukrywa, więc NIE jest ubytkiem widoku;
 * - GWARANCJA: żadna sprawa, która przez cały czas przewijania siedzi pod
 *   kursorem, nie zostanie pominięta, a każda inna zostanie ZGŁOSZONA. Na tym
 *   stoi obietnica: `truncated === false && nextCursor === null` znaczy
 *   „to cała kolejka".
 */
const CURSOR_TAG = "q3";

interface RunState {
  readonly head: number | null;
  readonly emitted: number;
  /**
   * Suma kontrolna WYDANYCH spraw: XOR skrótów ich identyfikatorów.
   *
   * Licznik `emitted` sam w sobie daje się zamaskować. Wystarczy, że w tej
   * samej chwili jedna sprawa zjedzie pod kursor (np. ktoś na nią odpowiedział),
   * a druga wejdzie nad kursor: liczba rekordów nad kursorem się nie zmienia,
   * więc porównanie liczb milczy, a nowa sprawa nigdy nie zostanie wydana.
   * Suma kontrolna porównuje ZBIORY, nie ich rozmiary, więc tej dziury nie ma.
   *
   * XOR, bo jest przemienny: kolejność wydawania nie ma znaczenia, a dokładanie
   * kolejnych stron kosztuje jedną operację.
   */
  readonly digest: string;
  readonly dirty: boolean;
}

function encodeCursor(entry: StoredCase, run: RunState): string {
  const head = run.head ?? sortKey(entry);
  const raw =
    `${CURSOR_TAG}|${head}|${run.emitted}|${run.digest}|${run.dirty ? 1 : 0}` +
    `|${sortKey(entry)}|${entry.caseId}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** Skrót identyfikatora sprawy w postaci nadającej się do XOR-owania. */
function caseDigest(caseId: string): bigint {
  return BigInt(`0x${createHash("sha256").update(caseId).digest("hex").slice(0, 16)}`);
}

/** Suma kontrolna zbioru spraw. Niezależna od kolejności. */
function digestOf(cases: readonly StoredCase[]): string {
  let acc = 0n;
  for (const entry of cases) acc ^= caseDigest(entry.caseId);
  return acc.toString(16);
}

/** Dołożenie strony do sumy kontrolnej przebiegu. */
function extendDigest(previous: string, page: readonly StoredCase[]): string {
  let acc = BigInt(`0x${previous || "0"}`);
  for (const entry of page) acc ^= caseDigest(entry.caseId);
  return acc.toString(16);
}

interface QueueCursor {
  readonly sortKey: number;
  readonly caseId: string;
  /** null = kursor ze starszego wydania, bez wiedzy o przebiegu. */
  readonly head: number | null;
  readonly emitted: number | null;
  readonly digest: string | null;
  readonly dirty: boolean;
}

function decodeCursor(cursor: string): QueueCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  return decoded.startsWith(`${CURSOR_TAG}|`) ? decodeRunCursor(decoded) : decodeLegacyCursor(decoded);
}

function decodeRunCursor(decoded: string): QueueCursor | null {
  // caseId bierzemy jako CAŁĄ resztę: identyfikator może zawierać „|", a
  // rozcięcie go po drodze przesunęłoby pozycję na nieistniejącą.
  const parts = decoded.split("|");
  if (parts.length < 7) return null;
  const head = finiteNumber(parts[1]!);
  const emitted = finiteNumber(parts[2]!);
  const digest = parts[3]!;
  const key = finiteNumber(parts[5]!);
  const caseId = parts.slice(6).join("|");
  if (head === null || emitted === null || key === null || emitted < 0) return null;
  if (caseId.length === 0 || !/^[0-9a-f]+$/.test(digest)) return null;
  return { sortKey: key, caseId, head, emitted, digest, dirty: parts[4] === "1" };
}

/**
 * Kursor w starym kształcie `${klucz}|${caseId}`. Pozycję honorujemy, ale stanu
 * przebiegu w nim nie ma — i dlatego taki przebieg nie dostanie już świadectwa
 * kompletności (patrz `missesCase`).
 */
function decodeLegacyCursor(decoded: string): QueueCursor | null {
  const separator = decoded.lastIndexOf("|");
  if (separator < 0) return null;
  const key = finiteNumber(decoded.slice(0, separator));
  const caseId = decoded.slice(separator + 1);
  /*
   * Kursor uszkodzony albo z kształtu, którego nie umiemy zinterpretować.
   * Czytamy od początku: powtórka jest niewygodna, ale przewidywalna, a pusty
   * wynik z NaN w porównaniach wyglądałby jak koniec listy i skłamałby
   * o kompletności widoku.
   */
  if (key === null || caseId.length === 0) return null;
  return { sortKey: key, caseId, head: null, emitted: null, digest: null, dirty: false };
}

/** Liczba albo `null`. Osobno, bo `Number("")` to zero, a nie błąd. */
function finiteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Czy sprawa leży ostro PONIŻEJ kursora w porządku kolejki: malejąco po czasie,
 * a przy remisie rosnąco po caseId. Porównanie identyfikatorów musi być tym
 * samym, którego używa sortowanie, inaczej rekordy o identycznym czasie
 * wypadałyby po obu stronach granicy.
 */
function isBelowCursor(entry: StoredCase, cursor: QueueCursor): boolean {
  const key = sortKey(entry);
  if (key !== cursor.sortKey) return key < cursor.sortKey;
  return entry.caseId.localeCompare(cursor.caseId) > 0;
}

/**
 * Pojedyncza sprawa po identyfikatorze.
 *
 * Istnieje, bo poprzednia droga budowała pięćsetelementową stronę kolejki
 * wyłącznie po to, żeby wybrać z niej jeden rekord — a sprawa spoza tej setki
 * (starsza, zamknięta, spoza filtra) była wtedy nie do otwarcia mimo że
 * istnieje w magazynie. Odczyt po kluczu nie ma tego progu i nie zależy od
 * tego, jak duża jest kolejka.
 */
export function queryCase(
  store: InboxStore,
  caseId: string,
  now: number,
  contentMode: ContentMode = "none",
  mailboxes?: ReadonlyMap<string, string>,
): { case: CaseDto; freshness: ChannelFreshness } | null {
  const entry = store.getCase(caseId);
  if (!entry) return null;
  return {
    case: toDto(store, entry, now, contentMode, mailboxes),
    freshness: channelFreshness(store, now),
  };
}

function toDto(
  store: InboxStore,
  entry: StoredCase,
  now: number,
  mode: ContentMode,
  mailboxes?: ReadonlyMap<string, string>,
): CaseDto {
  const showContent = mode !== "none";
  const preview = showContent ? buildPreview(store, entry, mode) : null;
  const sla = evaluateSla({
    waitingSince: entry.lastIncomingAt,
    requiresResponse: entry.requiresResponse,
    pendingAction: entry.pendingAction,
    needsReview: entry.needsReview,
    now,
  });
  const recipient = resolveRecipient(store, entry);
  const window =
    entry.provider === "instagram" || entry.provider === "facebook"
      ? metaSendWindow(entry.lastIncomingAt, now)
      : null;
  return {
    caseId: entry.caseId,
    provider: entry.provider,
    accountKey: entry.accountKey,
    sourceLabel: sourceLabel(entry),
    participantLabel: showContent ? entry.participantLabel : null,
    orderRef: entry.orderRef,
    subject: showContent ? entry.subject : null,
    preview,
    firstSeenAt: entry.firstSeenAt,
    lastMessageAt: entry.lastMessageAt,
    lastIncomingAt: entry.lastIncomingAt,
    lastIncomingMessageId: entry.lastIncomingMessageId,
    // Czas oczekiwania liczymy od ostatniej wiadomości KLIENTA. Od naszej
    // ostatniej odpowiedzi liczyłby czas, w którym piłka jest po jego stronie.
    waitingMs:
      entry.requiresResponse && entry.lastIncomingAt !== null
        ? Math.max(0, now - entry.lastIncomingAt)
        : null,
    messageCount: entry.messageCount,
    requiresResponse: entry.requiresResponse,
    pendingAction: entry.pendingAction,
    hasAttachments: entry.hasAttachments,
    sourceClosed: entry.sourceClosed,
    classifierVersion: entry.classifierVersion,
    classificationReason: entry.classificationReason,
    needsReview: entry.needsReview,
    priority: sla.priority,
    slaState: sla.state,
    responseDueAt: sla.responseDueAt,
    serviceMaxAt: sla.serviceMaxAt,
    // Odbiorca jest daną klienta: bez uprawnienia do treści pokazujemy null,
    // a nie adres „w celach informacyjnych".
    replyTo: showContent && recipient.ok ? recipient.recipient : null,
    replyFrom: mailboxes?.get(entry.accountKey) ?? null,
    replyWindowClosesAt: window?.expiresAt ?? null,
  };
}

function buildPreview(store: InboxStore, entry: StoredCase, mode: ContentMode): string | null {
  const messages = store.messagesForCase(entry.caseId);
  const last = messages[messages.length - 1];
  if (!last) return null;
  const text = mode === "model" ? redactForModel(last.body) : last.body;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= PREVIEW_CHARS ? oneLine : `${oneLine.slice(0, PREVIEW_CHARS)}…`;
}

export function sourceLabel(entry: Pick<InboxCase, "provider" | "accountKey">): string {
  switch (entry.provider) {
    case "allegro":
      return entry.accountKey === "dyskusje" ? "Allegro Dyskusje" : "Allegro";
    case "email":
      return `E-mail ${entry.accountKey}`;
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    default:
      return entry.provider;
  }
}

/**
 * Redakcja przed analizą AI: e-mail, telefon i kod pocztowy.
 *
 * Model dostaje sens sprawy, nie dane kontaktowe klienta. Redakcja jest tu,
 * a nie tylko po stronie czatu, bo pierwsza linia obrony ma stać przy danych,
 * a nie przy tym, kto o nie prosi.
 */
export function redactForModel(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, "[telefon]")
    .replace(/\b\d{2}-\d{3}\b/g, "[kod pocztowy]");
}

export interface MessageDto {
  readonly externalMessageId: string;
  readonly direction: InboxMessage["direction"];
  readonly authorLabel: string | null;
  readonly subject: string | null;
  readonly text: string | null;
  readonly sourceCreatedAt: number | null;
  readonly isEcho: boolean;
  readonly attachments: Array<{ id: string; fileName: string | null; mimeType: string | null }>;
}

/**
 * Wątek jako JEDEN spójny snapshot.
 *
 * Wiadomości, marker ostatniej wiadomości klienta i odbiorca odpowiedzi
 * pochodzą z jednego odczytu magazynu i wyjeżdżają w jednej odpowiedzi.
 * Wcześniej marker i odbiorca szły z ODRĘBNEGO wpisu listy, o innej świeżości:
 * lista i workflow potrafiły mieć już nowy marker, a panel wątku pokazywał
 * starszą historię. Operator zatwierdzał wtedy odpowiedź nie widząc
 * najnowszego pytania, a bramka markera przepuszczała wysyłkę, bo marker był
 * poprawny — tylko rozmowa na ekranie nie.
 */
export function queryMessages(
  store: InboxStore,
  caseId: string,
  mode: Exclude<ContentMode, "none">,
  mailboxes?: ReadonlyMap<string, string>,
): {
  readonly caseId: string;
  readonly messages: MessageDto[];
  readonly attachmentsExcluded: true;
  readonly lastIncomingMessageId: string | null;
  readonly replyTo: string | null;
  readonly replyFrom: string | null;
  readonly snapshotAt: number;
} {
  const messages = store.messagesForCase(caseId).map((message): MessageDto => ({
    externalMessageId: message.externalMessageId,
    direction: message.direction,
    authorLabel: mode === "model" ? null : message.authorLabel,
    subject: message.subject,
    text: mode === "model" ? redactForModel(message.body) : message.body,
    sourceCreatedAt: message.sourceCreatedAt,
    isEcho: message.isEcho,
    // Same metadane. Plik ani URL nigdy nie opuszczają adaptera.
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    })),
  }));
  const record = store.getCase(caseId);
  const recipient = record ? resolveRecipient(store, record) : null;
  return {
    caseId,
    messages,
    attachmentsExcluded: true,
    lastIncomingMessageId: record?.lastIncomingMessageId ?? null,
    replyTo: recipient?.ok ? recipient.recipient : null,
    // Konto nadawcze pochodzi z konfiguracji adaptera, tak samo jak na liscie.
    replyFrom: record ? mailboxes?.get(record.accountKey) ?? null : null,
    snapshotAt: Date.now(),
  };
}
