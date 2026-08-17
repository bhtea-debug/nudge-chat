import { TRIAGE_CATEGORIES } from "./prompt.js";
import type { TriageItem, TriageResult } from "./triage.js";

/**
 * Panel raportu dziennego. Widok, nie logika — nie wykonuje żadnego wywołania
 * i nie interpretuje danych; pokazuje to, co triage już ustalił.
 *
 * Kolejność sekcji odpowiada temu, po co właściciel to otwiera:
 *  1. czego NIE MA w systemie, choć przyszło mailem — jedyna rzecz, na którą
 *     żaden inny program w firmie nie odpowiada,
 *  2. co wymaga odpowiedzi,
 *  3. reszta poczty,
 *  4. co dokładnie zostało sprawdzone.
 *
 * Sekcja 4 nie jest ozdobą: raport, którego nie da się zweryfikować, po tygodniu
 * przestaje być czytany.
 */

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sender = (item: TriageItem): string => {
  const f = item.message.from;
  if (!f) return "nieznany nadawca";
  return f.name?.trim() || f.address;
};

const when = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

/** Numery, które przyszły mailem, a TeaBrew ich nie zna. Sedno raportu. */
function missingInErp(result: TriageResult): { item: TriageItem; refs: string[] }[] {
  return result.items
    .map((item) => ({ item, refs: item.erp.filter((e) => !e.found).map((e) => e.ref) }))
    .filter((x) => x.refs.length > 0);
}

/** Numery wymienione w mailu, których NIE sprawdziliśmy — budżet albo kategoria. */
function unchecked(result: TriageResult): number {
  return result.items.reduce(
    (n, i) => n + i.refs.filter((r) => !i.erp.some((e) => e.ref === r)).length,
    0,
  );
}

/**
 * Jedno zdanie do powiadomienia. Mówi o liczbach, nie o tym, że raport istnieje —
 * „Raport gotowy" nie jest informacją, po której ktokolwiek cokolwiek zrobi.
 */
export function summarize(result: TriageResult): string {
  if (result.total === 0) return "Nowej poczty nie było.";

  const parts: string[] = [];
  const missing = missingInErp(result).reduce((n, m) => n + m.refs.length, 0);
  const urgent = result.items.filter((i) => i.category === "Pilne").length;
  const reply = result.items.filter((i) => i.needsReply).length;

  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "numeru nie ma" : "numerów nie ma"} w TeaBrew`);
  if (urgent > 0) parts.push(`${urgent} pilne`);
  if (reply > 0) parts.push(`${reply} do odpowiedzi`);
  if (parts.length === 0) parts.push("nic nie wymaga reakcji");

  const head = `Poczta: ${result.total}`;
  const tail = result.mailNote ? " · przegląd niepełny" : "";
  return `${head} · ${parts.join(" · ")}${tail}`;
}

export function renderReportHtml(result: TriageResult, now: Date): string {
  const missing = missingInErp(result);
  const notChecked = unchecked(result);
  const failed = result.evidence.filter((e) => !e.ok);

  const date = new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const window =
    result.sinceDays === 1 ? "wczoraj i dzisiaj" : `ostatnie ${result.sinceDays} dni`;

  const banners: string[] = [];
  if (result.mailNote) {
    banners.push(
      `<div class="banner stop"><strong>Przegląd niepełny.</strong> ${esc(result.mailNote)}</div>`,
    );
  }
  if (failed.length > 0) {
    banners.push(
      `<div class="banner stop"><strong>${failed.length} sprawdzeń się nie udało.</strong> ` +
        `Te dane NIE zostały sprawdzone: ${failed.map((f) => esc(f.capability)).join(", ")}. ` +
        `Nie traktuj ich braku w raporcie jako informacji, że nic tam nie ma.</div>`,
    );
  }
  if (notChecked > 0) {
    banners.push(
      `<div class="banner warn"><strong>${notChecked} ${notChecked === 1 ? "numer" : "numerów"} bez sprawdzenia w TeaBrew.</strong> ` +
        `Skończył się budżet zapytań na jeden przebieg. Podnieś go: <code>npm run raport -- --erp 30</code></div>`,
    );
  }

  const missingHtml =
    missing.length === 0
      ? `<p class="empty">Wszystkie numery z poczty, które sprawdziłem, są w TeaBrew.</p>`
      : missing
          .map(
            ({ item, refs }) => `
        <div class="miss">
          <div class="miss-refs">${refs.map((r) => `<span class="ref">${esc(r)}</span>`).join("")}</div>
          <div class="miss-src">
            <span class="subj">${esc(item.message.subject)}</span>
            <span class="meta">${esc(sender(item))} · ${when(item.message.date)}</span>
          </div>
        </div>`,
          )
          .join("");

  const needsReply = result.items.filter((i) => i.needsReply);
  const replyHtml =
    needsReply.length === 0
      ? `<p class="empty">Nic nie czeka na odpowiedź.</p>`
      : needsReply.map((i) => card(i)).join("");

  const rest = TRIAGE_CATEGORIES.map((cat) => {
    const inCat = result.items.filter((i) => i.category === cat && !i.needsReply);
    if (inCat.length === 0) return "";
    return `
      <details>
        <summary>${esc(cat)} <span class="count">${inCat.length}</span></summary>
        <div class="details-body">${inCat.map((i) => card(i)).join("")}</div>
      </details>`;
  }).join("");

  const unclassified =
    result.unclassified.length === 0
      ? ""
      : `<details>
           <summary>Nieklasyfikowane <span class="count">${result.unclassified.length}</span></summary>
           <div class="details-body">
             <p class="empty">Klasyfikacja tych nie objęła. Nie przypisuję im kategorii na siłę.</p>
             ${result.unclassified
               .map(
                 (m) =>
                   `<div class="item"><span class="subj">${esc(m.subject)}</span><span class="meta">${esc(m.from?.address ?? "nieznany")}</span></div>`,
               )
               .join("")}
           </div>
         </details>`;

  const evidence = result.evidence
    .map(
      (e) =>
        `<tr><td>${esc(e.capability)}</td><td class="${e.ok ? "ok" : "bad"}">${e.ok ? "sprawdzone" : "NIE UDAŁO SIĘ"}</td><td class="num">${e.latencyMs} ms</td><td>${esc(e.detail)}</td></tr>`,
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
.miss{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--stop);padding:.875rem 1rem;display:flex;flex-direction:column;gap:.5rem}
.miss-refs{display:flex;flex-wrap:wrap;gap:.35rem}
.ref{font-family:var(--mono);font-size:.9375rem;font-weight:700;color:var(--stop);background:var(--stop-soft);padding:.15rem .45rem;border-radius:2px}
.miss-src{display:flex;flex-direction:column;gap:.1rem}
.item{background:var(--surface);border:1px solid var(--rule);padding:.75rem .9rem;display:flex;flex-direction:column;gap:.25rem}
.subj{font-family:var(--sans);font-size:.9375rem;font-weight:700;line-height:1.35}
.meta{font-family:var(--sans);font-size:.8125rem;color:var(--faint)}
.reason{font-size:.9375rem;color:var(--soft);margin:.15rem 0 0}
.erp{font-family:var(--mono);font-size:.8125rem;color:var(--soft);margin:.25rem 0 0}
.erp .no{color:var(--stop);font-weight:700}
.empty{font-size:.9375rem;color:var(--faint);font-style:italic;margin:0;padding:.5rem 0}
details{background:var(--surface);border:1px solid var(--rule)}
summary{font-family:var(--sans);font-size:.875rem;font-weight:700;padding:.7rem .9rem;cursor:pointer}
summary::marker{color:var(--accent)}
.count{font-family:var(--mono);font-weight:400;color:var(--faint)}
.details-body{padding:.25rem .9rem 1rem;display:flex;flex-direction:column;gap:.5rem;border-top:1px solid var(--rule)}
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
  <p class="verdict">${esc(summarize(result))}</p>
</header>

${banners.length > 0 ? `<div class="banners">${banners.join("")}</div>` : ""}

<section>
  <h2>Nie ma tego w TeaBrew</h2>
  ${missingHtml}
</section>

<section>
  <h2>Czeka na odpowiedź</h2>
  ${replyHtml}
</section>

${rest || unclassified ? `<section><h2>Reszta poczty — ${esc(window)}</h2>${rest}${unclassified}</section>` : ""}

<section>
  <h2>Co dokładnie sprawdziłem</h2>
  <div class="ev-wrap"><table><tbody>${evidence || `<tr><td colspan="4">Brak wywołań.</td></tr>`}</tbody></table></div>
</section>

<footer>
  <p>Raport powstał z ${result.total} ${result.total === 1 ? "wiadomości" : "wiadomości"} (${esc(window)}). Numer przebiegu: <code>${esc(result.correlationId.slice(0, 8))}</code></p>
  <p>Zawiera tematy i nadawców z poczty firmowej. Nie wysyłaj tego pliku dalej.</p>
</footer>

</div>
</body>
</html>
`;
}

function card(item: TriageItem): string {
  const erp = item.erp
    .map((e) =>
      e.found
        ? `<div class="erp">${esc(e.ref)}: ${esc(e.summary)}</div>`
        : `<div class="erp"><span class="no">${esc(e.ref)}: ${esc(e.summary)}</span></div>`,
    )
    .join("");
  return `<div class="item">
    <span class="subj">${esc(item.message.subject)}</span>
    <span class="meta">${esc(sender(item))} · ${when(item.message.date)} · ${esc(item.category)}</span>
    ${item.reason ? `<p class="reason">${esc(item.reason)}</p>` : ""}
    ${erp}
  </div>`;
}
