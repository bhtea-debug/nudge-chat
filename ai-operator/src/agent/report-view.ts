import type { FolderCheckpoint, Issue } from "../state/types.js";
import { OPEN_STATUSES } from "../state/types.js";
import { viewRef } from "../state/source-ref.js";

/** Autor ostatniej wiadomości w sprawie — niezależnie od tego, z jakiego źródła. */
const lastAuthor = (i: Issue): string | null => {
  const last = i.sourceRefs.at(-1);
  return last ? viewRef(last).author : null;
};

/**
 * Panel raportu dziennego — widok pamięci Copilota, nie osobna analiza.
 *
 * Zmiana wobec pierwszej wersji: raport rysuje się z LISTY SPRAW, a nie
 * z własnego przebiegu klasyfikacji przez model. Powód jest zasadniczy, nie
 * techniczny — właściciel pracuje wyłącznie na subskrypcji Claude, bez kredytów
 * API, więc raport nie ma prawa wołać modelu po naszej stronie.
 *
 * To wyszło na lepsze: raport i odpowiedzi Claude pokazują teraz DOKŁADNIE ten
 * sam stan. Wcześniej były dwiema niezależnymi analizami tej samej poczty, które
 * mogły się rozjechać i różnić w liczbach.
 *
 * Kolejność sekcji odpowiada temu, po co właściciel to otwiera:
 *  1. numery z poczty, których NIE MA w TeaBrew — jedyne pytanie, na które
 *     żaden inny program w firmie nie odpowiada,
 *  2. co czeka na jego ruch,
 *  3. co obserwujemy,
 *  4. czego monitor NIE sprawdził — bo cisza nigdy nie znaczy „w porządku".
 */

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const when = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

const hoursSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 3_600_000;

const age = (iso: string): string => {
  const h = hoursSince(iso);
  if (h < 1) return "teraz";
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} dni`;
};

export interface ReportInput {
  readonly issues: readonly Issue[];
  readonly checkpoints: readonly FolderCheckpoint[];
  readonly integrityWarning: string | null;
}

/** Sprawy z numerem, o którym TeaBrew mówi, że go nie zna. Sedno raportu. */
const missingInErp = (issues: readonly Issue[]): Issue[] =>
  issues.filter((i) => (i.lastErpSummary ?? "").includes("NIE MA"));

const open = (issues: readonly Issue[]): Issue[] =>
  issues.filter((i) => OPEN_STATUSES.includes(i.status));

const PRIO_ORDER = ["high", "normal", "low"];
const byPriority = (a: Issue, b: Issue): number =>
  PRIO_ORDER.indexOf(a.priority) - PRIO_ORDER.indexOf(b.priority) ||
  b.updatedAt.localeCompare(a.updatedAt);

const PRIO_LABEL: Record<string, string> = { high: "wysoki", normal: "zwykły", low: "niski" };

/**
 * Jedno zdanie do powiadomienia. Mówi o liczbach, nie o tym, że raport istnieje —
 * „raport gotowy" nie jest informacją, po której ktokolwiek cokolwiek zrobi.
 */
export function summarize(input: ReportInput): string {
  const opened = open(input.issues);
  const missing = missingInErp(opened);
  const waiting = opened.filter((i) => i.status === "waiting_for_owner");
  const fresh = opened.filter((i) => i.lastPresentedAt === null);

  const lastScan = input.checkpoints
    .map((c) => c.lastOkScanAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);

  if (!lastScan) {
    return "Monitor poczty jeszcze nie skanował — nie wiem, co przyszło.";
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} ${missing.length === 1 ? "numeru nie ma" : "numerów nie ma"} w TeaBrew`);
  }
  if (fresh.length > 0) parts.push(`${fresh.length} nowych`);
  if (waiting.length > 0) parts.push(`${waiting.length} czeka na Ciebie`);
  if (parts.length === 0) parts.push("nic nowego");

  const stale = hoursSince(lastScan) > 1.5 ? ` · ostatni skan ${age(lastScan)} temu` : "";
  return `Spraw otwartych: ${opened.length} · ${parts.join(" · ")}${stale}`;
}

export function renderReportHtml(input: ReportInput, now: Date): string {
  const opened = open(input.issues);
  const missing = missingInErp(opened).sort(byPriority);
  // Trzy kubełki, rozłączne. Rozdzielenie „prawdopodobnie nieistotne" jest tu
  // najważniejsze: bez niego lista faktów zmusza właściciela do otwierania
  // każdej pozycji, czyli do wykonania tej pracy, którą miał zdjąć z siebie.
  const rest = opened.filter((i) => !missing.includes(i));
  const real = rest.filter((i) => !i.likelyIrrelevant).sort(byPriority);
  const irrelevant = rest.filter((i) => i.likelyIrrelevant).sort(byPriority);

  const lastScan = input.checkpoints
    .map((c) => c.lastOkScanAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);
  const failedFolders = input.checkpoints.filter((c) => c.lastError !== null);

  const date = new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const banners: string[] = [];
  if (!lastScan) {
    banners.push(
      `<div class="banner stop"><strong>Monitor poczty nie wykonał ani jednego udanego skanu.</strong> ` +
        `Pusta lista NIE znaczy, że nic nie przyszło. Uruchom <code>npm run monitor</code>.</div>`,
    );
  } else if (hoursSince(lastScan) > 3) {
    banners.push(
      `<div class="banner stop"><strong>Ostatni udany skan poczty ${esc(age(lastScan))} temu.</strong> ` +
        `Ten raport pokazuje stan z tamtego momentu, nie z teraz.</div>`,
    );
  }
  for (const c of failedFolders) {
    banners.push(
      `<div class="banner warn"><strong>${esc(c.folder)}:</strong> ${esc(c.lastError ?? "")}</div>`,
    );
  }
  if (input.integrityWarning) {
    banners.push(`<div class="banner warn"><strong>Pamięć spraw:</strong> ${esc(input.integrityWarning)}</div>`);
  }

  const card = (i: Issue): string => `
    <div class="item prio-${esc(i.priority)}">
      <div class="head">
        <span class="subj">${esc(i.title)}</span>
        <span class="pill p-${esc(i.priority)}">${esc(PRIO_LABEL[i.priority] ?? i.priority)}</span>
      </div>
      ${i.whyListed ? `<p class="why">${esc(i.whyListed)}</p>` : ""}
      ${i.summary ? `<p class="reason">${esc(i.summary)}</p>` : ""}
      <span class="meta">${esc(lastAuthor(i) ?? "?")} · ${esc(i.sourceRefs.at(-1)?.date ? when(i.sourceRefs.at(-1)!.date) : age(i.createdAt))}${i.sourceRefs.length > 1 ? ` · ${i.sourceRefs.length} wiadomości` : ""}${i.lastPresentedAt === null ? " · NOWE" : ""}</span>
      ${i.waitingFor ? `<div class="erp">czekamy: ${esc(i.waitingFor)}</div>` : ""}
      ${i.lastErpSummary && !missing.includes(i) ? `<div class="erp">TeaBrew: ${esc(i.lastErpSummary)}</div>` : ""}
    </div>`;

  // Sekcja „nie ma w TeaBrew" używa TEGO SAMEGO kafla co reszta, plus numery
  // na wierzchu. Wcześniej miała własny render bez priorytetu i bez powodu —
  // czyli najważniejsza sekcja raportu była jedyną, która nie mówiła, dlaczego
  // dana pozycja jest na liście.
  const missingHtml =
    missing.length === 0
      ? `<p class="empty">Każdy numer z poczty, który sprawdziłem, jest w TeaBrew.</p>`
      : missing
          .map(
            (i) => `
        <div class="miss">
          <div class="miss-refs">${i.relatedOrderRefs
            .filter((r) => (i.lastErpSummary ?? "").includes(r))
            .map((r) => `<span class="ref">${esc(r)}</span>`)
            .join("")}</div>
          ${card(i)}
        </div>`,
          )
          .join("");

  const scanned = input.checkpoints
    .map(
      (c) =>
        `<tr><td>${esc(c.folder)}</td><td class="${c.lastError ? "bad" : "ok"}">${c.lastError ? "nieudany" : "ok"}</td><td class="num">${c.messagesSeen}</td><td>${esc(c.lastOkScanAt ? when(c.lastOkScanAt) : "nigdy")}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raport BHT — ${esc(date)}</title>
<style>
:root{
  --ground:#FBFBF9;--surface:#FFFFFF;--sunk:#F1F3F0;
  --ink:#16211C;--soft:#4E5A54;--faint:#7C8880;
  --rule:#DDE2DC;--rule-2:#C6CDC5;
  --accent:#1F5E4B;--accent-soft:#E4EFE9;
  --warn:#8A5713;--warn-soft:#F7EEDE;
  --stop:#8A2E29;--stop-soft:#F8E8E6;
  --sans:"Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#111613;--surface:#191F1B;--sunk:#0D110F;
  --ink:#E7ECE7;--soft:#A7B2AB;--faint:#7B857E;
  --rule:#2A322D;--rule-2:#3B453E;
  --accent:#6BBE9F;--accent-soft:#16261F;
  --warn:#D9A25A;--warn-soft:#241C10;
  --stop:#E08A83;--stop-soft:#26140F;
}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--serif);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
.page{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 4rem;display:flex;flex-direction:column;gap:2.5rem}
header{display:flex;flex-direction:column;gap:.5rem}
.eyebrow{font-family:var(--sans);font-size:.6875rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
h1{font-family:var(--sans);font-size:1.75rem;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:0;text-wrap:balance}
.verdict{font-family:var(--sans);font-size:1rem;font-weight:700;color:var(--accent);margin:.35rem 0 0}
section{display:flex;flex-direction:column;gap:.875rem}
h2{font-family:var(--sans);font-size:.75rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0;padding-bottom:.5rem;border-bottom:2px solid var(--accent)}
.banner{font-family:var(--sans);font-size:.875rem;line-height:1.45;padding:.75rem .9rem;border-left:3px solid}
.banner.stop{background:var(--stop-soft);border-color:var(--stop);color:var(--stop)}
.banner.warn{background:var(--warn-soft);border-color:var(--warn);color:var(--warn)}
.banner code{font-family:var(--mono);font-size:.8125rem}
.banners{display:flex;flex-direction:column;gap:.5rem}
.miss{display:flex;flex-direction:column;gap:.35rem}
.miss .item{border-left-color:var(--stop)}
.miss-refs{display:flex;flex-wrap:wrap;gap:.35rem}
.ref{font-family:var(--mono);font-size:.9375rem;font-weight:700;color:var(--stop);background:var(--stop-soft);padding:.15rem .45rem;border-radius:2px}

.item{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--rule-2);padding:.75rem .9rem;display:flex;flex-direction:column;gap:.3rem}
.item.prio-high{border-left-color:var(--stop)}
.item.prio-normal{border-left-color:var(--accent)}
.item.prio-low{border-left-color:var(--rule-2)}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem}
.pill{font-family:var(--sans);font-size:.625rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:.15rem .4rem;border-radius:2px;white-space:nowrap}
.p-high{color:var(--stop);background:var(--stop-soft)}
.p-normal{color:var(--accent);background:var(--accent-soft)}
.p-low{color:var(--faint);background:var(--sunk)}
.why{font-family:var(--sans);font-size:.8125rem;color:var(--accent);margin:0}
.item.prio-low .why{color:var(--faint)}
.count{font-family:var(--mono);font-weight:400;color:var(--faint)}
details{background:var(--surface);border:1px solid var(--rule)}
summary{font-family:var(--sans);font-size:.875rem;font-weight:700;padding:.7rem .9rem;cursor:pointer}
summary::marker{color:var(--accent)}
.details-body{padding:.25rem .9rem 1rem;display:flex;flex-direction:column;gap:.5rem;border-top:1px solid var(--rule)}
.subj{font-family:var(--sans);font-size:.9375rem;font-weight:700;line-height:1.35}
.meta{font-family:var(--sans);font-size:.8125rem;color:var(--faint)}
.reason{font-size:.9375rem;color:var(--soft);margin:.15rem 0 0}
.erp{font-family:var(--mono);font-size:.8125rem;color:var(--soft);margin:.25rem 0 0}
.empty{font-size:.9375rem;color:var(--faint);font-style:italic;margin:0;padding:.5rem 0}
.ev-wrap{overflow-x:auto;border:1px solid var(--rule);background:var(--surface)}
table{width:100%;border-collapse:collapse;font-family:var(--sans);font-size:.8125rem}
td{padding:.5rem .75rem;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:none}
.num{font-variant-numeric:tabular-nums;text-align:right;color:var(--faint);white-space:nowrap}
.ok{color:var(--accent)}
.bad{color:var(--stop);font-weight:700}
footer{border-top:1px solid var(--rule);padding-top:1rem;font-family:var(--sans);font-size:.75rem;color:var(--faint);display:flex;flex-direction:column;gap:.3rem}
footer code{font-family:var(--mono)}
</style>
</head>
<body>
<div class="page">

<header>
  <span class="eyebrow">Brown House &amp; Tea · raport dzienny</span>
  <h1>${esc(date)}, ${time}</h1>
  <p class="verdict">${esc(summarize(input))}</p>
</header>

${banners.length > 0 ? `<div class="banners">${banners.join("")}</div>` : ""}

<section>
  <h2>Nie ma tego w TeaBrew</h2>
  ${missingHtml}
</section>

<section>
  <h2>Korespondencja <span class="count">${real.length}</span></h2>
  ${real.length === 0 ? `<p class="empty">Nic nie czeka na Ciebie.</p>` : real.map(card).join("")}
</section>

${
  irrelevant.length > 0
    ? `<section>
        <details>
          <summary>Prawdopodobnie nieistotne <span class="count">${irrelevant.length}</span></summary>
          <div class="details-body">
            <p class="empty">Nieznany nadawca, brak numeru zamówienia i brak wątku. Nie usuwam ich — jeśli któraś okaże się ważna, powiedz, i poprawię regułę.</p>
            ${irrelevant.map(card).join("")}
          </div>
        </details>
      </section>`
    : ""
}

<section>
  <h2>Co monitor sprawdził</h2>
  <div class="ev-wrap"><table><tbody>${scanned || `<tr><td colspan="4">Żaden folder nie był jeszcze skanowany.</td></tr>`}</tbody></table></div>
</section>

<footer>
  <p>Priorytet i podział wynikają z FAKTÓW, nie z oceny modelu: czy pisaliśmy kiedyś do tego nadawcy, czy to odpowiedź w wątku, czy jest numer zamówienia i co o nim mówi TeaBrew. Przy każdej pozycji widzisz, która reguła ją tu wstawiła.</p>
  <p>Opis to podgląd treści dosłownie z serwera — nic nie jest przeformułowane, więc nic nie mogło zostać zmyślone. Streszczenia własnymi słowami wymagałyby modelu.</p>
  <p>Zawiera tematy i nadawców z poczty firmowej. Nie wysyłaj tego pliku dalej.</p>
</footer>

</div>
</body>
</html>
`;
}
