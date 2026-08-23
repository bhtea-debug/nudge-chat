import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InboxMessage } from "./contract.js";
import type { InboxStore, StoredCase } from "./store.js";

/**
 * Sito modelowe: DRUGI stopień klasyfikacji, po regułach.
 *
 * Reguły zawężają (odrzucają oczywiste automaty: pocztę wewnętrzną, wysyłki
 * masowe, zwrotki, autoodpowiedzi). Model dostaje WYŁĄCZNIE sprawy, których
 * reguły nie umiały rozstrzygnąć i które przez fail-open wylądowały w kolejce
 * jako „wiadomość klienta". Trzy twarde zasady:
 *
 *  1. Model niczego nie usuwa. Werdykt „nie klient" zdejmuje sprawę z kolejki
 *     „do obsługi" (requiresResponse=false) i etykietuje powód — sprawa dalej
 *     jest w archiwum kanału, widoczna w widoku „Wszystkie".
 *  2. Awaria modelu zostawia sprawę w kolejce. Sito, które przy błędzie
 *     wycisza skrzynkę, jest gorsze niż brak sita.
 *  3. Nowa wiadomość klienta unieważnia werdykt: sprawa wraca do oceny.
 *     Werdykt jest przypięty do konkretnej ostatniej wiadomości przychodzącej.
 */

/** Powód klasyfikacji nadawany przez sito; czat pokazuje go w archiwum. */
export const MODEL_SCREEN_REASON = "model_screen_not_customer" as const;

/** Minimalny interfejs modelu — dokładnie to, co daje ModelLayer.complete. */
export interface ScreenModel {
  complete(args: { role: "classify"; system: string; prompt: string }): Promise<string>;
}

interface Verdict {
  /** Ostatnia wiadomość przychodząca, której dotyczy werdykt. */
  readonly messageId: string | null;
  readonly verdict: "klient" | "nie_klient";
  /** Krótka etykieta po polsku (faktura, kurier, oferta...), do audytu. */
  readonly label: string;
  readonly at: number;
}

export interface ScreenReport {
  /** Ile spraw kwalifikowało się do oceny w tym przebiegu. */
  candidates: number;
  /** Ile świeżych werdyktów wydał model. */
  screened: number;
  /** Ile spraw zeszło z kolejki (świeżo albo z ponownie nałożonego werdyktu). */
  filtered: number;
  errors: number;
  skippedBudget: number;
}

const PLIK_WERDYKTOW = "model-werdykty.json";
/** Po tylu błędach modelu z rzędu przebieg się poddaje do następnego ticku. */
const MAX_BLEDOW_NA_PRZEBIEG = 3;
/** Tyle znaków ostatniej wiadomości widzi model — dość na decyzję, nie całość. */
const MAX_TRESCI = 900;

const SYSTEM_PROMPT = [
  "Jesteś sitem skrzynki obsługi klienta sklepu z herbatą Brown House & Tea.",
  "Reguły automatyczne odrzuciły już oczywiste automaty; dostajesz wątek,",
  "którego nie umiały rozstrzygnąć. Odpowiedz WYŁĄCZNIE jednym obiektem JSON:",
  '{"werdykt":"klient"|"nie_klient","etykieta":"<krótka etykieta po polsku>"}.',
  "„klient” = osoba pisząca w sprawie zakupu, zamówienia, reklamacji, zwrotu,",
  "pytania o produkt albo współpracy hurtowej JAKO kupujący.",
  "„nie_klient” = automatyczne powiadomienie, faktura lub księgowość, kurier",
  "i logistyka do firmy, dostawca albo oferta handlowa DO nas, urząd,",
  "rekrutacja, newsletter, spam. Etykieta ma nazywać, czym to jest",
  "(np. faktura, kurier, oferta do nas, urząd, newsletter, spam).",
  "W razie jakiejkolwiek wątpliwości wybierz „klient” — fałszywy alarm",
  "kosztuje jedno spojrzenie, przeoczony klient kosztuje klienta.",
].join(" ");

function sciezkaWerdyktow(stateDir: string): string {
  return join(stateDir, PLIK_WERDYKTOW);
}

function wczytajWerdykty(stateDir: string): Map<string, Verdict> {
  try {
    const raw = readFileSync(sciezkaWerdyktow(stateDir), "utf8");
    const data = JSON.parse(raw) as Record<string, Verdict>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function zapiszWerdykty(stateDir: string, verdicts: Map<string, Verdict>): void {
  const path = sciezkaWerdyktow(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // Zapis przez plik tymczasowy: częściowo zapisany JSON przy padzie procesu
  // wyglądałby jak brak werdyktów i sito płaciłoby za wszystko od nowa.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(verdicts)), "utf8");
  renameSync(tmp, path);
}

/** Sprawa, której reguły nie rozstrzygnęły i która wisi w kolejce. */
function kandydat(record: StoredCase): boolean {
  return (
    record.provider === "email" &&
    record.requiresResponse === true &&
    record.classificationReason === "customer_message" &&
    record.needsReview === false
  );
}

function ostatniaPrzychodzaca(messages: readonly InboxMessage[]): InboxMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction === "incoming" && !message.isEcho) return message;
  }
  return null;
}

function prompt(record: StoredCase, messages: readonly InboxMessage[]): string {
  const last = ostatniaPrzychodzaca(messages);
  const czesci = [
    `Skrzynka: ${record.accountKey}@ (obsługa klienta sklepu).`,
    `Nadawca: ${last?.authorLabel ?? record.participantLabel ?? "(nieznany)"}.`,
    `Temat: ${record.subject ?? "(bez tematu)"}.`,
    `Wiadomości w wątku: ${messages.length}.`,
    "Treść ostatniej wiadomości przychodzącej:",
    (last?.body ?? "").slice(0, MAX_TRESCI) || "(pusta)",
  ];
  return czesci.join("\n");
}

function parsujWerdykt(text: string): { verdict: "klient" | "nie_klient"; label: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as {
      werdykt?: unknown;
      etykieta?: unknown;
    };
    if (data.werdykt !== "klient" && data.werdykt !== "nie_klient") return null;
    const label = typeof data.etykieta === "string" ? data.etykieta.slice(0, 80) : "";
    return { verdict: data.werdykt, label };
  } catch {
    return null;
  }
}

/** Zdejmuje sprawę z kolejki „do obsługi", zostawiając ją w archiwum. */
function odlozSprawe(store: InboxStore, record: StoredCase): void {
  store.upsertCase({
    ...record,
    requiresResponse: false,
    classificationReason: MODEL_SCREEN_REASON,
    needsReview: false,
  });
}

export async function screenCases(options: {
  store: InboxStore;
  model: ScreenModel;
  stateDir: string;
  maxPerTick: number;
  now: number;
}): Promise<ScreenReport> {
  const { store, model, stateDir, now } = options;
  const report: ScreenReport = {
    candidates: 0,
    screened: 0,
    filtered: 0,
    errors: 0,
    skippedBudget: 0,
  };
  const verdicts = wczytajWerdykty(stateDir);
  let budget = Math.max(0, options.maxPerTick);
  let zmienione = false;

  for (const record of store.listCases()) {
    /*
     * Werdykt „nie_klient" nakładamy PONOWNIE także wtedy, gdy reprojekcja
     * (np. dopisany własny komentarz w wątku) przywróciła regułowy wynik —
     * bez ponownego pytania modelu. Ale tylko dopóki ostatnia wiadomość
     * przychodząca się nie zmieniła: nowa wiadomość klienta unieważnia
     * werdykt i sprawa wraca do oceny.
     */
    const cached = verdicts.get(record.caseId);
    if (cached && cached.messageId === record.lastIncomingMessageId) {
      if (cached.verdict === "nie_klient" && kandydat(record)) {
        odlozSprawe(store, record);
        report.filtered += 1;
      }
      continue;
    }

    if (!kandydat(record)) continue;
    report.candidates += 1;

    if (budget <= 0) {
      report.skippedBudget += 1;
      continue;
    }
    if (report.errors >= MAX_BLEDOW_NA_PRZEBIEG) {
      // Model ewidentnie nie odpowiada; kolejne wywołania w tym ticku to
      // palenie czasu i limitów. Sprawy zostają w kolejce — fail-open.
      continue;
    }

    budget -= 1;
    let odpowiedz: string;
    try {
      odpowiedz = await model.complete({
        role: "classify",
        system: SYSTEM_PROMPT,
        prompt: prompt(record, store.messagesForCase(record.caseId)),
      });
    } catch {
      report.errors += 1;
      continue;
    }

    const wynik = parsujWerdykt(odpowiedz);
    if (!wynik) {
      // Nieparsowalna odpowiedź to awaria oceny, nie decyzja.
      report.errors += 1;
      continue;
    }

    report.screened += 1;
    verdicts.set(record.caseId, {
      messageId: record.lastIncomingMessageId,
      verdict: wynik.verdict,
      label: wynik.label,
      at: now,
    });
    zmienione = true;
    if (wynik.verdict === "nie_klient") {
      odlozSprawe(store, record);
      report.filtered += 1;
    }
  }

  if (zmienione) zapiszWerdykty(stateDir, verdicts);
  return report;
}
