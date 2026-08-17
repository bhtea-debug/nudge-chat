import { buildTimeline, lastIncoming, sourceSummary, type TimelineEntry } from "../state/timeline.js";
import { kindsOf, SOURCE_LABEL } from "../state/source-ref.js";
import type { FolderCheckpoint, Issue } from "../state/types.js";
import { age, esc, minutesSince, PRIO_LABEL, when } from "./html.js";
import { assignLanes, headStatus, missingInErp, type Lane } from "./lanes.js";
import { CSS } from "./style.js";

/**
 * Widoki BHT Copilota.
 *
 * Model mentalny, który ten plik ma wymuszać: **inbox spraw → otwieram sprawę →
 * rozmawiam tylko o tej sprawie.** Nie ma tu ekranu „czat z firmą" i nie ma
 * panelu „historia rozmów" — wprost zabronione (§18), bo najważniejszym
 * elementem produktu jest lista spraw, a czat jest narzędziem do pracy nad jedną
 * z nich.
 *
 * Czego w tych widokach NIE MA i nie może się pojawić (§24): nazw capability,
 * identyfikatorów korelacji, tokenów, JSON-a, nazw endpointów, stack trace'ów.
 * Właściciel widzi język biznesowy. Diagnostyka ma swoje miejsce — CLI i log.
 */

export interface SyncState {
  readonly lastOkScanAt: string | null;
  readonly checkpoints: readonly FolderCheckpoint[];
  readonly integrityWarning: string | null;
}

/** Po ilu minutach bez udanego skanu mówimy o tym właścicielowi wprost. */
const STALE_MINUTES = 45;

// ── powłoka ───────────────────────────────────────────────────────────────────

function layout(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16171a" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-title" content="BHT Copilot">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${head}
${body}
</body>
</html>`;
}

function topBar(backHref: string | null): string {
  const back = backHref
    ? `<a class="back" href="${esc(backHref)}" aria-label="Wróć do listy spraw">‹ Sprawy</a>`
    : "";
  return `<header class="top"><div class="inner">${back}<h1>BHT Copilot</h1></div></header>`;
}

// ── logowanie ─────────────────────────────────────────────────────────────────

export function renderLogin(error: string | null): string {
  return layout(
    "BHT Copilot",
    "",
    `<div class="login">
  <h1>BHT Copilot</h1>
  <p>Wpisz hasło, żeby zobaczyć swoje sprawy.</p>
  ${error ? `<div class="zle">${esc(error)}</div>` : ""}
  <form method="post" action="/login">
    <input type="password" name="haslo" autocomplete="current-password" required
           autofocus placeholder="Hasło" aria-label="Hasło">
    <button class="glowny" type="submit">Wejdź</button>
  </form>
</div>`,
  );
}

// ── ekran główny ──────────────────────────────────────────────────────────────

/**
 * Które systemy realnie zasilają tę listę.
 *
 * Liczone z DANYCH, nie z konfiguracji. Pierwsza wersja brała to z obecności
 * klucza API i kłamała w obie strony: pisała „zasilane Connecteam" przy
 * skonfigurowanym kluczu bez ani jednej wiadomości, i milczała o Connecteam,
 * gdy wiadomości przychodziły webhookiem, bez klucza.
 */
function zasilaneZ(issues: readonly Issue[]): string[] {
  const zrodla = new Set<string>();
  for (const i of issues) {
    for (const r of i.sourceRefs) zrodla.add(SOURCE_LABEL[r.kind]);
    if (i.lastErpSummary) zrodla.add("TeaBrew");
  }
  return [...zrodla];
}

export function renderInbox(issues: readonly Issue[], sync: SyncState): string {
  const s = headStatus(issues);
  const lanes = assignLanes(issues);
  const szum = lanes.find((l) => l.id === "szum");
  const glowne = lanes.filter((l) => l.id !== "szum");

  const naglowek =
    s.open === 0
      ? "Nic nie czeka"
      : s.needAttention > 0
        ? `${s.needAttention} ${odmiana(s.needAttention, "sprawa wymaga", "sprawy wymagają", "spraw wymaga")} Twojej uwagi`
        : `${s.open} ${odmiana(s.open, "otwarta sprawa", "otwarte sprawy", "otwartych spraw")}`;

  const podtytul =
    s.open === 0
      ? "Wszystko, co przyszło, jest już obsłużone."
      : `${s.open} ${odmiana(s.open, "otwarta", "otwarte", "otwartych")} · ${s.changed} ${odmiana(s.changed, "zmieniła się", "zmieniły się", "zmieniło się")} od ostatniej wizyty`;

  const sekcje = glowne
    .map((lane) => renderLane(lane))
    .filter((html) => html !== "")
    .join("\n");

  const szumHtml =
    szum && szum.issues.length > 0
      ? `<details class="szum"><summary>${esc(szum.title)} · ${szum.issues.length}</summary>
<div class="puste">${esc(szum.hint)}</div>
${szum.issues.map((i) => card(i)).join("\n")}</details>`
      : "";

  return layout(
    "BHT Copilot",
    topBar(null),
    `<div class="wrap">
  <div class="status">
    <p class="big">${esc(naglowek)}</p>
    <p class="line">${esc(podtytul)}</p>
    ${syncLine(sync)}
  </div>
  ${banery(sync)}
  ${sekcje || `<section class="lane"><div class="puste">Monitor nie znalazł jeszcze żadnej sprawy.</div></section>`}
  ${szumHtml}
  ${stopka(zasilaneZ(issues))}
</div>`,
  );
}

function renderLane(lane: Lane): string {
  // Puste sekcje nie są rysowane. Rubryka, która nigdy nic nie zawiera, uczy
  // przewijać ekran bez czytania — a wtedy przestaje działać także wtedy, gdy
  // coś w niej wreszcie jest.
  if (lane.issues.length === 0) return "";
  return `<section class="lane">
  <h2>${lane.icon} ${esc(lane.title)} <span class="licz">· ${lane.issues.length}</span></h2>
  ${lane.issues.map((i) => card(i)).join("\n")}
</section>`;
}

/**
 * Karta sprawy (§5). Sześć rzeczy i ani jednej więcej: tytuł, źródło, priorytet,
 * streszczenie, kiedy się zmieniło, dlaczego to jest ważne.
 */
function card(issue: Issue): string {
  const zrodla = sourceSummary(issue) || "—";
  const brak = missingInErp(issue);
  return `<a class="karta p-${esc(issue.priority)}" href="/sprawa/${esc(issue.id)}">
  <p class="tytul">${esc(issue.title)}</p>
  <p class="stresz">${esc(oneLine(issue.summary))}</p>
  <p class="powod">${esc(issue.whyListed || "—")}</p>
  <div class="stopka">
    <span class="pill ${esc(issue.priority)}">${esc(PRIO_LABEL[issue.priority] ?? issue.priority)}</span>
    <span class="zrodlo">${esc(zrodla)}</span>
    <span>·</span>
    <span>${esc(age(issue.updatedAt))}</span>
    ${brak ? `<span>·</span><span style="color:var(--pilne)">nie ma w TeaBrew</span>` : ""}
  </div>
</a>`;
}

// ── ekran sprawy ──────────────────────────────────────────────────────────────

export function renderCase(issue: Issue, sync: SyncState, claudeHref: string | null): string {
  const os = buildTimeline(issue);
  // Tylko komunikacja, nie nasz własny odczyt z TeaBrew — patrz EntryKind.
  const ostatnia = lastIncoming(os);

  return layout(
    issue.title,
    topBar("/"),
    `<div class="wrap">
  <div class="status">
    <p class="big" style="font-size:21px">${esc(issue.title)}</p>
    <p class="line">
      <span class="pill ${esc(issue.priority)}">${esc(PRIO_LABEL[issue.priority] ?? issue.priority)}</span>
      &nbsp;${esc(sourceSummary(issue) || "—")} · ${esc(age(issue.updatedAt))}
    </p>
    ${syncLine(sync)}
  </div>

  <div class="blok">
    <h3>Co się dzieje</h3>
    <p>${esc(issue.summary)}</p>
    ${issue.whyListed ? `<p style="color:var(--tekst-cichy);font-size:14px">${esc(issue.whyListed)}</p>` : ""}
  </div>

  ${ostatnia ? `<div class="blok"><h3>Co przyszło ostatnio</h3>
    <p><strong>${esc(ostatnia.source)}</strong> · ${esc(age(ostatnia.at))}</p>
    <p>${esc(ostatnia.what)}</p></div>` : ""}

  ${daneBlok(issue)}

  ${komunikacjaBlok(issue, os)}

  <div class="blok">
    <h3>Rozmowa o tej sprawie</h3>
    ${rozmowaBlok(issue, claudeHref)}
  </div>

  <div class="blok">
    <h3>Twoje działania</h3>
    <div class="akcje">
      ${issue.status === "waiting_for_owner"
        ? akcja(issue.id, "obserwuj", "Wróć do obserwowanych")
        : akcja(issue.id, "decyzja", "To wymaga mojej decyzji")}
      ${akcja(issue.id, "zamknij", "Załatwione", true)}
    </div>
    <p style="color:var(--tekst-cichy);font-size:13px;margin-top:12px">
      Zamknięcie dotyczy tylko tej listy. Nic nie zostaje wysłane ani zmienione
      w poczcie, w Connecteam ani w TeaBrew.
    </p>
  </div>

  ${stopka(zasilaneZ([issue]))}
</div>`,
  );
}

function daneBlok(issue: Issue): string {
  const rows: [string, string][] = [];
  if (issue.relatedOrderRefs.length > 0) rows.push(["Zamówienia", issue.relatedOrderRefs.join(", ")]);
  if (issue.relatedProductRefs.length > 0) rows.push(["Produkty", issue.relatedProductRefs.join(", ")]);
  if (issue.lastErpSummary) rows.push(["TeaBrew", issue.lastErpSummary]);
  if (issue.waitingFor) rows.push(["Czekamy na", issue.waitingFor]);
  if (rows.length === 0) return "";

  return `<div class="blok">
  <h3>Dane</h3>
  <dl class="dane">
    ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("\n")}
  </dl>
  ${issue.lastEvidenceAt
      ? `<p style="color:var(--tekst-cichy);font-size:13px;margin-top:10px">Sprawdzone w TeaBrew ${esc(age(issue.lastEvidenceAt))}. Jeśli to ma znaczenie, sprawdź na świeżo.</p>`
      : ""}
</div>`;
}

/**
 * Komunikacja i chronologia źródeł (§15).
 *
 * Pokazujemy OSTATNIE wpisy, a pełną historię schowaną — wymóg z §6, żeby nie
 * wysypywać całych wątków od pierwszego wejrzenia.
 */
function komunikacjaBlok(issue: Issue, os: readonly TimelineEntry[]): string {
  if (os.length === 0) return "";
  const LIMIT = 4;
  const starsze = os.length > LIMIT ? os.slice(0, os.length - LIMIT) : [];
  const ostatnie = os.slice(-LIMIT);
  const zrodla = kindsOf(issue.sourceRefs).map((k) => SOURCE_LABEL[k]);

  return `<div class="blok">
  <h3>Komunikacja${zrodla.length > 1 ? ` · ${esc(zrodla.join(" + "))}` : ""}</h3>
  ${starsze.length > 0
      ? `<details><summary style="cursor:pointer;color:var(--tekst-cichy);font-size:13.5px;min-height:44px;display:flex;align-items:center">Pokaż wcześniejsze (${starsze.length})</summary>
      <ul class="os" style="margin-top:10px">${starsze.map(osLi).join("")}</ul></details>`
      : ""}
  <ul class="os">${ostatnie.map(osLi).join("")}</ul>
</div>`;
}

function osLi(e: TimelineEntry): string {
  return `<li class="${e.own ? "own" : ""}">
  <div class="gdy">${esc(when(e.at))} · ${esc(e.source)}</div>
  <div class="co"><span class="kto">${esc(e.who)}</span> — ${esc(e.what)}</div>
</li>`;
}

/**
 * Rozmowa o sprawie.
 *
 * Tu jest jedyne miejsce, w którym produkt świadomie odbiega od litery zadania,
 * i powód jest twardy: **własna strona nie ma dostępu do subskrypcji Claude.**
 * Czat wbudowany w to UI musiałby wołać API modelu, czyli zużywać kredyty —
 * a właściciel zdecydował, że domyślnie ich nie używamy (§17), i to samo §17
 * zabrania wdrażania takiego czatu po cichu.
 *
 * Dlatego rozmowa odbywa się w Claude, ale kontekst przygotowuje ta strona:
 * jedno naciśnięcie kopiuje polecenie z identyfikatorem sprawy. Claude odczyta
 * ją przez Remote MCP i będzie rozmawiał WYŁĄCZNIE o niej — a każda sprawa to
 * osobna rozmowa, więc rozdział kontekstów jest ostrzejszy niż w czacie
 * wbudowanym w jedną stronę.
 */
function rozmowaBlok(issue: Issue, claudeHref: string | null): string {
  // Polecenie jest w zwykłym języku, BEZ nazw narzędzi. Dwa powody: żargon nie
  // ma prawa być widoczny dla właściciela (§24), a instrukcje projektu Claude
  // i tak mapują „otwórz sprawę" na właściwe narzędzie. Wpisanie nazw tutaj
  // stworzyłoby drugie źródło prawdy o tym, jak wołać capability — takie, które
  // rozjedzie się przy pierwszej zmianie rejestru.
  const polecenie = [
    `Otwórz sprawę ${issue.id} i powiedz, co się w niej stało.`,
    issue.relatedOrderRefs.length > 0
      ? `Sprawdź na świeżo stan zamówienia ${issue.relatedOrderRefs.join(", ")}.`
      : "",
    "Rozmawiaj tylko o tej sprawie.",
  ]
    .filter(Boolean)
    .join(" ");

  const otworz = claudeHref
    ? `<a class="btn glowny" href="${esc(claudeHref)}" target="_blank" rel="noopener">Otwórz w Claude</a>`
    : "";

  return `<p style="font-size:14.5px">Rozmowę prowadzisz w Claude — tam masz swoją subskrypcję i nie płacisz za nią osobno.
  Skopiuj polecenie, wklej w nowej rozmowie: Claude sam dociągnie tę sprawę i będzie mówił tylko o niej.</p>
  <div class="akcje">
    <button type="button" class="glowny" data-kopiuj="${esc(polecenie)}">Skopiuj polecenie</button>
    ${otworz}
  </div>
  <p style="color:var(--tekst-cichy);font-size:13px;margin-top:12px">
    Claude może przygotować treść odpowiedzi do klienta. Wysyłasz ją Ty — ten system nie ma czym wysłać maila.
  </p>
  <script>
  document.querySelectorAll("[data-kopiuj]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-kopiuj") || "";
      var ok = function () { b.textContent = "Skopiowane ✓"; setTimeout(function () { b.textContent = "Skopiuj polecenie"; }, 2000); };
      if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(ok, fallback); } else { fallback(); }
      function fallback() {
        // Bez HTTPS albo przy odmowie schowka: pokazujemy tekst do zaznaczenia,
        // zamiast udawać, że skopiowaliśmy.
        var ta = document.createElement("textarea");
        ta.value = t; ta.style.width = "100%"; ta.style.minHeight = "88px"; ta.style.marginTop = "10px";
        b.parentNode.appendChild(ta); ta.select();
      }
    });
  });
  </script>`;
}

function akcja(id: string, co: string, etykieta: string, glowny = false): string {
  return `<form class="inline" method="post" action="/sprawa/${esc(id)}/${esc(co)}">
  <button type="submit"${glowny ? ' class="glowny"' : ""}>${esc(etykieta)}</button>
</form>`;
}

// ── stan synchronizacji ───────────────────────────────────────────────────────

/**
 * Mała linijka o synchronizacji (§20). Bez technicznych przebiegów.
 *
 * Najważniejszy przypadek to ten, w którym monitor NIE działa: wtedy „nic nowego"
 * na tym ekranie znaczyłoby „nie wiem", a właściciel przeczytałby to jako
 * „spokojny dzień". Dlatego cisza po awarii jest zawsze nazwana.
 */
function syncLine(sync: SyncState): string {
  if (sync.lastOkScanAt === null) {
    return `<div class="sync zle"><span class="kropka"></span>Jeszcze nie sprawdzałem poczty — ta lista może być niepełna</div>`;
  }
  const m = minutesSince(sync.lastOkScanAt);
  const zle = m > STALE_MINUTES;
  return `<div class="sync${zle ? " zle" : ""}"><span class="kropka"></span>${
    zle
      ? `Poczta nie była synchronizowana od ${Math.round(m)} min`
      : `Ostatnia synchronizacja: ${esc(age(sync.lastOkScanAt))}`
  }</div>`;
}

function banery(sync: SyncState): string {
  const out: string[] = [];
  const zepsute = sync.checkpoints.filter((c) => c.lastError);
  if (zepsute.length > 0) {
    out.push(
      `<div class="baner"><strong>Nie udało mi się sprawdzić części poczty.</strong>
      To znaczy, że mogło przyjść coś, czego tu nie widzisz. Spróbuję ponownie przy najbliższej synchronizacji.</div>`,
    );
  }
  if (sync.integrityWarning) {
    out.push(
      `<div class="baner stop"><strong>Część mojej pamięci spraw jest nieczytelna.</strong>
      Historia niektórych spraw mogła zniknąć. Bieżąca lista działa, ale warto to zgłosić.</div>`,
    );
  }
  return out.join("\n");
}

function stopka(zrodla: readonly string[]): string {
  const lista = zrodla.length > 0 ? zrodla.join(", ") : "brak źródeł — nic jeszcze nie wpadło";
  return `<footer class="stopka-strony">
  Źródła tej listy: ${esc(lista)}.<br>
  Czytam je tylko do odczytu — nic nie wysyłam i nic w nich nie zmieniam.<br>
  <a href="/wyloguj" style="color:var(--akcent)">Wyloguj</a>
</footer>`;
}

// ── pomocnicze ────────────────────────────────────────────────────────────────

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Polska odmiana przez liczbę. Bez tego status brzmi jak tłumaczenie maszynowe. */
function odmiana(n: number, jeden: string, kilka: string, wiele: string): string {
  if (n === 1) return jeden;
  const ostatnia = n % 10;
  const dwie = n % 100;
  if (ostatnia >= 2 && ostatnia <= 4 && (dwie < 12 || dwie > 14)) return kilka;
  return wiele;
}

export const MANIFEST = JSON.stringify({
  name: "BHT Copilot",
  short_name: "Copilot",
  start_url: "/",
  display: "standalone",
  background_color: "#f7f7f5",
  theme_color: "#f7f7f5",
  lang: "pl",
});
