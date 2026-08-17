/**
 * Styl BHT Copilota.
 *
 * Wymóg z §24: spokojnie, czytelnie, bardzo prosto, szybko. Stąd decyzje, które
 * warto rozumieć, zanim ktoś je „ulepszy":
 *
 *  - **zero zależności zewnętrznych.** Brak fontów z CDN, brak frameworka CSS,
 *    brak JS-owego routingu. Strona ma się otworzyć na telefonie w słabym
 *    zasięgu, w hali, przy jednym pasku sieci. Każdy zewnętrzny plik to jedna
 *    dodatkowa rzecz, która się nie doczyta.
 *  - **font systemowy.** Na iPhonie wygląda jak iOS, na Macu jak macOS. Właściciel
 *    ma poczuć narzędzie, nie stronę internetową.
 *  - **jasny i ciemny motyw z `prefers-color-scheme`.** Bez przełącznika: jedna
 *    rzecz mniej do zrozumienia, a telefon i tak wie, co jest ustawione.
 *  - **kolor NIGDY nie jest jedynym nośnikiem informacji.** Priorytet ma
 *    plakietkę ze słowem, nie tylko czerwoną kropkę. Sekcja ma nagłówek, nie
 *    tylko emoji.
 *  - **duże pola dotyku.** Minimum 44 px wysokości na wszystkim, co się klika —
 *    to jest narzędzie używane w biegu, jedną ręką.
 */
export const CSS = `
:root {
  color-scheme: light dark;
  --tlo: #f7f7f5;
  --karta: #ffffff;
  --tekst: #17181a;
  --tekst-cichy: #5f636b;
  --linia: #e3e3df;
  --akcent: #1f4fd8;
  --pilne: #c0392b;
  --uwaga: #d97706;
  --spokoj: #2f7d55;
  --cien: 0 1px 2px rgba(16,17,20,.06), 0 4px 12px rgba(16,17,20,.04);
  --r: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --tlo: #16171a;
    --karta: #1e2024;
    --tekst: #eceef1;
    --tekst-cichy: #a0a6b0;
    --linia: #2e3238;
    --akcent: #7aa2ff;
    --pilne: #ff7b6b;
    --uwaga: #f0b45e;
    --spokoj: #74c99a;
    --cien: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--tlo);
  color: var(--tekst);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  /* Bezpieczne obszary iPhone'a — inaczej dolny pasek zasłania ostatnią kartę. */
  padding: 0 0 env(safe-area-inset-bottom);
}
a { color: inherit; text-decoration: none; }
.wrap { max-width: 680px; margin: 0 auto; padding: 0 16px 48px; }

/* ── nagłówek ─────────────────────────────────────────────────────────────── */
header.top {
  position: sticky; top: 0; z-index: 5;
  background: color-mix(in srgb, var(--tlo) 88%, transparent);
  backdrop-filter: saturate(150%) blur(8px);
  border-bottom: 1px solid var(--linia);
  padding: env(safe-area-inset-top) 0 0;
}
header.top .inner { max-width: 680px; margin: 0 auto; padding: 14px 16px; display: flex; align-items: baseline; gap: 12px; }
header.top h1 { font-size: 19px; font-weight: 650; margin: 0; letter-spacing: -.01em; }
header.top .back { font-size: 15px; color: var(--akcent); min-height: 44px; display: flex; align-items: center; margin: -14px 0 -14px -4px; padding: 0 8px; }

/* ── status ───────────────────────────────────────────────────────────────── */
.status { padding: 18px 0 6px; }
.status .big { font-size: 26px; font-weight: 660; letter-spacing: -.02em; margin: 0 0 4px; }
.status .line { color: var(--tekst-cichy); font-size: 15px; margin: 0; }
.sync { display: flex; align-items: center; gap: 6px; color: var(--tekst-cichy); font-size: 13px; margin-top: 10px; }
.sync .kropka { width: 7px; height: 7px; border-radius: 50%; background: var(--spokoj); flex: none; }
.sync.zle { color: var(--uwaga); }
.sync.zle .kropka { background: var(--uwaga); }

/* ── sekcje ───────────────────────────────────────────────────────────────── */
section.lane { margin-top: 26px; }
section.lane > h2 {
  font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: .07em;
  color: var(--tekst-cichy); margin: 0 0 10px; display: flex; align-items: center; gap: 8px;
}
section.lane > h2 .licz { font-weight: 500; opacity: .75; text-transform: none; letter-spacing: 0; }
section.lane .puste { color: var(--tekst-cichy); font-size: 14px; padding: 2px 0 4px; }

/* ── karta sprawy ─────────────────────────────────────────────────────────── */
.karta {
  display: block; background: var(--karta); border: 1px solid var(--linia);
  border-radius: var(--r); box-shadow: var(--cien);
  padding: 14px 16px; margin-bottom: 10px;
  border-left: 3px solid var(--linia);
}
.karta:active { transform: scale(.995); }
.karta.p-high { border-left-color: var(--pilne); }
.karta.p-normal { border-left-color: var(--uwaga); }
.karta.p-low { border-left-color: var(--linia); }
.karta .tytul { font-weight: 620; font-size: 16px; margin: 0 0 6px; letter-spacing: -.01em; }
.karta .stresz { color: var(--tekst); opacity: .82; font-size: 14.5px; margin: 0 0 8px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.karta .powod { color: var(--tekst-cichy); font-size: 13px; margin: 0 0 8px; }
.karta .stopka { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; color: var(--tekst-cichy); }

.pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  font-size: 12px; font-weight: 600; border: 1px solid var(--linia); }
.pill.high { color: var(--pilne); border-color: color-mix(in srgb, var(--pilne) 40%, transparent); }
.pill.normal { color: var(--uwaga); border-color: color-mix(in srgb, var(--uwaga) 40%, transparent); }
.pill.low { color: var(--tekst-cichy); }
.zrodlo { font-weight: 500; }

/* ── ekran sprawy ─────────────────────────────────────────────────────────── */
.blok { background: var(--karta); border: 1px solid var(--linia); border-radius: var(--r);
  box-shadow: var(--cien); padding: 16px; margin-bottom: 12px; }
.blok h3 { font-size: 12.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .07em;
  color: var(--tekst-cichy); margin: 0 0 10px; }
.blok p { margin: 0 0 8px; }
.blok p:last-child { margin-bottom: 0; }
.dane { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 14.5px; }
.dane dt { color: var(--tekst-cichy); }
.dane dd { margin: 0; }

.os { list-style: none; margin: 0; padding: 0; }
.os li { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--linia); }
.os li:last-child { padding-bottom: 0; border-left-color: transparent; }
.os li::before { content: ""; position: absolute; left: -5px; top: 5px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--akcent); }
.os li.own::before { background: var(--tekst-cichy); }
.os .gdy { font-size: 12.5px; color: var(--tekst-cichy); }
.os .co { font-size: 14.5px; margin-top: 2px; }
.os .kto { font-weight: 600; }

/* ── przyciski ────────────────────────────────────────────────────────────── */
.akcje { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
button, .btn {
  font: inherit; font-size: 15px; font-weight: 560;
  min-height: 44px; padding: 0 16px; border-radius: 11px;
  border: 1px solid var(--linia); background: var(--karta); color: var(--tekst);
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer;
}
.btn.glowny, button.glowny { background: var(--akcent); border-color: var(--akcent); color: #fff; }
button:active, .btn:active { opacity: .8; }
form.inline { display: inline; }

/* ── komunikaty ───────────────────────────────────────────────────────────── */
.baner { border-radius: var(--r); padding: 12px 14px; margin: 12px 0; font-size: 14.5px;
  border: 1px solid color-mix(in srgb, var(--uwaga) 45%, transparent);
  background: color-mix(in srgb, var(--uwaga) 12%, transparent); }
.baner.stop { border-color: color-mix(in srgb, var(--pilne) 45%, transparent);
  background: color-mix(in srgb, var(--pilne) 12%, transparent); }
.baner strong { font-weight: 650; }

details.szum { margin-top: 26px; }
details.szum > summary { cursor: pointer; color: var(--tekst-cichy); font-size: 13px;
  text-transform: uppercase; letter-spacing: .07em; font-weight: 650; min-height: 44px;
  display: flex; align-items: center; }
details.szum > summary::-webkit-details-marker { display: none; }
details.szum > summary::before { content: "▸ "; margin-right: 6px; }
details.szum[open] > summary::before { content: "▾ "; }

/* ── logowanie ────────────────────────────────────────────────────────────── */
.login { max-width: 340px; margin: 14vh auto 0; padding: 0 16px; text-align: center; }
.login h1 { font-size: 22px; margin: 0 0 6px; }
.login p { color: var(--tekst-cichy); font-size: 14.5px; margin: 0 0 22px; }
.login input {
  font: inherit; width: 100%; min-height: 48px; padding: 0 14px; margin-bottom: 12px;
  border: 1px solid var(--linia); border-radius: 11px; background: var(--karta); color: var(--tekst);
}
.login button { width: 100%; }
.login .zle { color: var(--pilne); font-size: 14px; margin-bottom: 12px; }

footer.stopka-strony { color: var(--tekst-cichy); font-size: 12.5px; text-align: center;
  margin-top: 34px; line-height: 1.7; }
`;
