#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../index.js";
import { newCorrelationId, MemoryAuditSink } from "../capability/audit.js";
import type { CapabilityContext } from "../capability/types.js";
import { MailMessage } from "../mail/types.js";
import { classifyDeterministic, domainOf } from "../state/classify-deterministic.js";
import { splitNoise } from "../state/noise.js";
import { isOwnOrderShape } from "../state/order-refs.js";
import { fromPackageRoot } from "../paths.js";

/**
 * TEST 3 — jakość na prawdziwych wiadomościach.
 *
 *   npm run ocena             # zbierz (raz), etykietuj, policz
 *   npm run ocena -- --wynik  # same liczby, bez etykietowania
 *   npm run ocena -- --od-nowa
 *
 * ── Dlaczego to wygląda tak, a nie inaczej ────────────────────────────────────
 *
 * 1. **Zbiór jest ZAMRAŻANY.** Właściciel i system muszą oceniać dokładnie te
 *    same wiadomości. Gdyby każdy pobierał świeżo ze skrzynki, porównanie
 *    dotyczyłoby dwóch różnych zbiorów i nie znaczyłoby nic.
 *
 * 2. **Właściciel NIE WIDZI oceny systemu, dopóki nie skończy.** Pokazanie jej
 *    wcześniej zamieniłoby test jakości w test zgodności z tym, co system już
 *    powiedział — a mierzymy coś odwrotnego.
 *
 * 3. **Jedno naciśnięcie klawisza na wiadomość.** Sto wiadomości ma zająć kilka
 *    minut, nie wieczór. Zmuszanie do komentarza przy każdej skończyłoby się
 *    porzuceniem testu w połowie, czyli brakiem wyniku.
 *
 * 4. **Wiadomości odsiane przez filtr szumu też są w zbiorze.** System traktuje
 *    je jak nieistotne, tylko robi to milcząco. Gdyby nie było ich w ocenie,
 *    najgroźniejszy błąd — przeoczony alarm — byłby dokładnie tym, czego test
 *    nie potrafi zobaczyć.
 *
 * Narzędzie NICZEGO nie zapisuje w skrzynce ani w dzienniku spraw. Czyta pocztę
 * i TeaBrew, oba tylko do odczytu.
 */

// Katalog stanu jest konfigurowalny — zamrożony zbiór ma leżeć tam, gdzie
// reszta stanu tej instalacji, a nie w sztywnym miejscu obok niego.
const KATALOG = fromPackageRoot(join(process.env["COPILOT_STATE_DIR"] ?? "state", "ocena"));
const PLIK_ZBIOR = join(KATALOG, "zbior.json");
const PLIK_ETYKIETY = join(KATALOG, "etykiety.json");

const argv = process.argv.slice(2);
const ma = (f: string): boolean => argv.includes(f);
const liczba = (f: string, d: number): number => {
  const i = argv.indexOf(f);
  const v = i === -1 ? NaN : Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

/** Klasy z zadania. */
type Klasa = "A" | "B" | "C";
const OPIS_KLASY: Record<Klasa, string> = {
  A: "ALARM — chcę push od razu",
  B: "PODSUMOWANIE — warto wiedzieć, nie przerywaj",
  C: "NIEISTOTNE — nie chcę tego widzieć",
};

interface Pozycja {
  readonly id: string;
  readonly data: string;
  readonly nadawca: string;
  readonly domena: string | null;
  readonly temat: string;
  readonly podglad: string;
  /** Co zrobił z tym system. */
  readonly system: Klasa;
  /** Dlaczego tak — jednym zdaniem, do raportu błędów. */
  readonly dlaczego: string;
  /** Odsiany przez filtr szumu, zanim cokolwiek go obejrzało. */
  readonly odsiany: boolean;
  readonly numery: string[];
  readonly brakWTeaBrew: boolean;
  readonly automat: boolean;
  readonly wlasnaDomena: boolean;
}

interface Etykieta {
  readonly klasa: Klasa;
  /** „Ważne, ale źle zrozumiane" — system zauważył temat, ale wyciągnął zły wniosek. */
  readonly zleZrozumiane: boolean;
}

// ── zbieranie ─────────────────────────────────────────────────────────────────

async function zbierz(ile: number, dni: number): Promise<Pozycja[]> {
  const app = createApp();
  const ctx: CapabilityContext = {
    agent: "ocena-jakosci",
    correlationId: newCorrelationId(),
    scopes: ["mail:read", "erp:read"],
    audit: new MemoryAuditSink(app.config.auditFile),
  };

  const wszystkie: z.infer<typeof MailMessage>[] = [];
  for (const folder of app.config.copilot.monitorFolders) {
    const out = (await app.registry.invoke(
      "mail_list_recent",
      { sinceDays: dni, limit: ile, unreadOnly: false, folder },
      ctx,
    )) as { messages: z.infer<typeof MailMessage>[] };
    wszystkie.push(...out.messages);
  }

  // Duplikaty techniczne — ta sama wiadomość w dwóch folderach. Nic poza tym
  // nie usuwamy: dobieranie „ładnego" zbioru unieważniłoby cały pomiar.
  const poId = new Map<string, z.infer<typeof MailMessage>>();
  for (const m of wszystkie) if (!poId.has(m.id)) poId.set(m.id, m);

  const posortowane = [...poId.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, ile);

  const { keep, dropped } = splitNoise(posortowane);
  const odsiane = new Map(dropped.map((d) => [d.message.id, d.why]));

  // Sprawdzenia w TeaBrew — te same, które robi monitor: wyłącznie numery
  // o KSZTAŁCIE naszego numeru zamówienia, po jednym na numer.
  const doSprawdzenia = new Set<string>();
  for (const m of keep) {
    const d = klasyfikuj(app, m);
    for (const r of d.refsForErp.filter(isOwnOrderShape)) doSprawdzenia.add(r);
  }

  const brakuje = new Map<string, boolean>();
  for (const ref of doSprawdzenia) {
    try {
      const out = (await app.registry.invoke("teabrew_get_order_status", { ref }, ctx)) as {
        matchedBy: string;
      };
      brakuje.set(ref, out.matchedBy === "none");
    } catch {
      // Nieudanego sprawdzenia NIE liczymy jako „brakuje" — inaczej awaria
      // TeaBrew produkowałaby fałszywe alarmy i zafałszowała cały pomiar.
      brakuje.set(ref, false);
    }
  }
  process.stdout.write(`  sprawdzone w TeaBrew: ${doSprawdzenia.size} numer(ów)\n`);

  const pozycje = posortowane.map((m): Pozycja => {
    const powodOdsiania = odsiane.get(m.id);
    const d = klasyfikuj(app, m);
    const numery = d.refsForErp.filter(isOwnOrderShape);
    const brak = numery.some((r) => brakuje.get(r) === true);
    const wlasna = domainOf(m.from?.address) === domainOf(wlasnyAdres(app));

    const { klasa, dlaczego } = werdykt({
      odsiany: powodOdsiania !== undefined,
      powodOdsiania: powodOdsiania ?? null,
      likelyIrrelevant: d.likelyIrrelevant,
      priority: d.priority,
      brakWTeaBrew: brak,
      numery,
      whyListed: d.whyListed,
    });

    return {
      id: m.id,
      data: m.date,
      nadawca: m.from?.name?.trim() || m.from?.address || "?",
      domena: domainOf(m.from?.address),
      temat: m.subject,
      podglad: m.snippet.replace(/\s+/g, " ").trim().slice(0, 300),
      system: klasa,
      dlaczego,
      odsiany: powodOdsiania !== undefined,
      numery,
      brakWTeaBrew: brak,
      automat: /no-?reply|noreply|donotreply|mailer-daemon|notifications?@|newsletter/i.test(
        m.from?.address ?? "",
      ),
      wlasnaDomena: wlasna,
    };
  });

  await app.close();
  return pozycje;
}

/** Adres własny — tylko tryb IMAP go zna; w trybie fikstur nie ma go skąd wziąć. */
const wlasnyAdres = (app: ReturnType<typeof createApp>): string | null =>
  app.config.mail.kind === "imap" ? app.config.mail.user : null;

const klasyfikuj = (app: ReturnType<typeof createApp>, m: z.infer<typeof MailMessage>) =>
  classifyDeterministic(m, {
    ownAddress: wlasnyAdres(app),
    isKnownDomain: app.config.copilot.sentFolder ? (dom) => app.store.isKnownDomain(dom) : null,
  });

/**
 * Odwzorowanie decyzji produktu na trzy klasy z zadania.
 *
 * Świadomie NIE pytam o `notificationCandidate` jako o pole — pytam o to, co
 * z tego wynika dla właściciela: czy dostałby push (A), zobaczył w podsumowaniu
 * (B), czy nie zobaczył wcale (C). To jest to samo, co robi `whyNow` w lanes.ts:
 * brak numeru w TeaBrew albo wysoki priorytet wypycha sprawę do „teraz".
 */
function werdykt(w: {
  odsiany: boolean;
  powodOdsiania: string | null;
  likelyIrrelevant: boolean;
  priority: string;
  brakWTeaBrew: boolean;
  numery: string[];
  whyListed: string;
}): { klasa: Klasa; dlaczego: string } {
  if (w.odsiany) return { klasa: "C", dlaczego: `odsiane przez filtr szumu: ${w.powodOdsiania}` };
  if (w.likelyIrrelevant) return { klasa: "C", dlaczego: w.whyListed };
  if (w.brakWTeaBrew) {
    return { klasa: "A", dlaczego: `numeru ${w.numery.join(", ")} NIE MA w TeaBrew` };
  }
  if (w.priority === "high") return { klasa: "A", dlaczego: `wysoki priorytet: ${w.whyListed}` };
  return { klasa: "B", dlaczego: w.whyListed };
}

// ── etykietowanie ─────────────────────────────────────────────────────────────

function czytajKlawisz(): Promise<string> {
  return new Promise((resolve) => {
    const we = process.stdin;
    we.setRawMode?.(true);
    we.resume();
    we.setEncoding("utf8");
    const raz = (k: string): void => {
      we.setRawMode?.(false);
      we.pause();
      we.removeListener("data", raz);
      resolve(k);
    };
    we.on("data", raz);
  });
}

async function etykietuj(zbior: Pozycja[], etykiety: Record<string, Etykieta>): Promise<void> {
  process.stdout.write(
    `\n\x1b[1mOCENA JAKOŚCI — ${zbior.length} wiadomości\x1b[0m\n\n` +
      `  \x1b[1ma\x1b[0m  ${OPIS_KLASY.A}\n` +
      `  \x1b[1mb\x1b[0m  ${OPIS_KLASY.B}\n` +
      `  \x1b[1mc\x1b[0m  ${OPIS_KLASY.C}\n\n` +
      `  \x1b[1mw\x1b[0m  poprzednia była WAŻNA, ale system ją źle zrozumiał\n` +
      `  \x1b[1mq\x1b[0m  przerwij (postęp jest zapisywany po każdym klawiszu)\n\n` +
      `Oceniasz tak, jak chciałbyś, żeby zachował się Copilot — nie zgadujesz,\n` +
      `co on zrobił. Jego oceny NIE zobaczysz, dopóki nie skończysz.\n\n`,
  );

  let ostatni: string | null = null;

  for (let i = 0; i < zbior.length; i++) {
    const p = zbior[i]!;
    if (etykiety[p.id]) continue;

    const nr = `${i + 1}/${zbior.length}`;
    const dzien = p.data.slice(0, 16).replace("T", " ");
    process.stdout.write(
      `\x1b[2m${"─".repeat(72)}\x1b[0m\n` +
        `\x1b[2m${nr}  ${dzien}\x1b[0m\n` +
        `\x1b[1m${p.nadawca}\x1b[0m  \x1b[2m${p.domena ?? ""}\x1b[0m\n` +
        `${p.temat}\n` +
        `\x1b[2m${p.podglad.slice(0, 200)}\x1b[0m\n` +
        `  [a] alarm  [b] podsumowanie  [c] nieistotne  › `,
    );

    for (;;) {
      const k = (await czytajKlawisz()).toLowerCase();
      if (k === "q" || k === "") {
        process.stdout.write("\n\nPrzerwane. Postęp zapisany — uruchom ponownie, żeby dokończyć.\n");
        zapisz(PLIK_ETYKIETY, etykiety);
        process.exit(0);
      }
      if (k === "w") {
        if (ostatni && etykiety[ostatni]) {
          etykiety[ostatni] = { ...etykiety[ostatni]!, zleZrozumiane: true };
          process.stdout.write("(poprzednia oznaczona: ważna, ale źle zrozumiana) › ");
        }
        continue;
      }
      if (k === "a" || k === "b" || k === "c") {
        etykiety[p.id] = { klasa: k.toUpperCase() as Klasa, zleZrozumiane: false };
        ostatni = p.id;
        zapisz(PLIK_ETYKIETY, etykiety);
        process.stdout.write(`${k.toUpperCase()}\n`);
        break;
      }
    }
  }

  process.stdout.write("\n\x1b[1mGotowe — wszystkie ocenione.\x1b[0m\n");
}

// ── metryki ───────────────────────────────────────────────────────────────────

function policz(zbior: Pozycja[], etykiety: Record<string, Etykieta>): string {
  const ocenione = zbior.filter((p) => etykiety[p.id]);
  if (ocenione.length === 0) return "Nie ma ani jednej oceny — uruchom `npm run ocena`.\n";

  const l = (p: Pozycja): Klasa => etykiety[p.id]!.klasa;

  const tp = ocenione.filter((p) => p.system === "A" && l(p) === "A");
  const fp = ocenione.filter((p) => p.system === "A" && l(p) !== "A");
  const fn = ocenione.filter((p) => p.system !== "A" && l(p) === "A");
  const zgodne = ocenione.filter((p) => p.system === l(p));

  const precyzja = tp.length + fp.length > 0 ? tp.length / (tp.length + fp.length) : NaN;
  const czulosc = tp.length + fn.length > 0 ? tp.length / (tp.length + fn.length) : NaN;
  const proc = (x: number): string => (Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);

  const z_numeru = [...fp, ...fn].filter((p) => p.numery.length > 0 || p.brakWTeaBrew);
  const z_podpisu = [...fp, ...fn].filter((p) => p.wlasnaDomena);
  const z_automatu = [...fp, ...fn].filter((p) => p.automat);
  const zle_zrozumiane = ocenione.filter((p) => etykiety[p.id]!.zleZrozumiane);
  const przeoczone_bo_odsiane = fn.filter((p) => p.odsiany);

  const rozklad = (f: (p: Pozycja) => Klasa): string =>
    (["A", "B", "C"] as const).map((k) => `${k}:${ocenione.filter((p) => f(p) === k).length}`).join("  ");

  const linie = [
    "",
    `\x1b[1mWYNIK — ${ocenione.length} ocenionych wiadomości\x1b[0m`,
    "",
    `  właściciel:  ${rozklad(l)}`,
    `  system:      ${rozklad((p) => p.system)}`,
    "",
    `  \x1b[1mALARM — czułość (recall):  ${proc(czulosc)}\x1b[0m   ← najważniejsza`,
    `  ALARM — precyzja:          ${proc(precyzja)}`,
    `  trafienia (TP):            ${tp.length}`,
    `  \x1b[1mPRZEOCZONE ALARMY (FN):    ${fn.length}\x1b[0m`,
    `  fałszywe alarmy (FP):      ${fp.length}`,
    `  zgodność 3-klasowa:        ${proc(zgodne.length / ocenione.length)}`,
    "",
    `  błędy z rozpoznania numerów:   ${z_numeru.length}`,
    `  błędy na własnej domenie:      ${z_podpisu.length}   (stopka, podpis)`,
    `  błędy na automatach:           ${z_automatu.length}`,
    `  ważne, ale źle zrozumiane:     ${zle_zrozumiane.length}`,
    `  przeoczone, bo odsiane cicho:  ${przeoczone_bo_odsiane.length}`,
    "",
  ];

  if (fn.length > 0) {
    linie.push("\x1b[1mPRZEOCZONE ALARMY — to jest najgroźniejsza klasa błędu:\x1b[0m");
    for (const p of fn.slice(0, 12)) {
      linie.push(`  · ${p.nadawca} — ${p.temat.slice(0, 60)}`);
      linie.push(`    system dał ${p.system}, bo: ${p.dlaczego}`);
    }
    linie.push("");
  }

  if (fp.length > 0) {
    linie.push("\x1b[1mFAŁSZYWE ALARMY:\x1b[0m");
    for (const p of fp.slice(0, 12)) {
      linie.push(`  · ${p.nadawca} — ${p.temat.slice(0, 60)}  (właściciel: ${l(p)})`);
      linie.push(`    system alarmował, bo: ${p.dlaczego}`);
    }
    linie.push("");
  }

  return linie.join("\n") + "\n";
}

// ── wejście ───────────────────────────────────────────────────────────────────

function wczytaj<T>(sciezka: string, domyslne: T): T {
  try {
    return JSON.parse(readFileSync(sciezka, "utf8")) as T;
  } catch {
    return domyslne;
  }
}

function zapisz(sciezka: string, dane: unknown): void {
  mkdirSync(KATALOG, { recursive: true });
  writeFileSync(sciezka, JSON.stringify(dane, null, 2), "utf8");
}

const odNowa = ma("--od-nowa");
let zbior = odNowa ? [] : wczytaj<Pozycja[]>(PLIK_ZBIOR, []);

if (zbior.length === 0) {
  process.stdout.write("Pobieram wiadomości ze skrzynki i uruchamiam na nich klasyfikację…\n");
  zbior = await zbierz(liczba("--ile", 100), liczba("--dni", 30));
  zapisz(PLIK_ZBIOR, zbior);
  process.stdout.write(`  zamrożony zbiór: ${zbior.length} wiadomości\n`);
  if (zbior.length < 100) {
    // Zadanie wymaga podania liczby, gdy zbiór jest mniejszy niż sto.
    process.stdout.write(
      `  UWAGA: w oknie ${liczba("--dni", 30)} dni było mniej niż 100 wiadomości.\n` +
        `  Pomiar zrobimy na ${zbior.length} — ta liczba idzie do raportu.\n`,
    );
  }
}

const etykiety = odNowa ? {} : wczytaj<Record<string, Etykieta>>(PLIK_ETYKIETY, {});

if (!ma("--wynik")) {
  await etykietuj(zbior, etykiety);
  zapisz(PLIK_ETYKIETY, etykiety);
}

process.stdout.write(policz(zbior, etykiety));
