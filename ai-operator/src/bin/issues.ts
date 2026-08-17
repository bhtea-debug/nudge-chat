/**
 * Sprawy — podgląd i jedyna droga do zamknięcia sprawy.
 *
 *   npm run sprawy                        # otwarte sprawy
 *   npm run sprawy -- --wszystkie
 *   npm run sprawy -- --pokaz spr_1a2b3c
 *   npm run sprawy -- --zamknij spr_1a2b3c "dogadane telefonicznie"
 *
 * Dlaczego zamykanie jest tutaj, a nie w Claude: model nie ma prawa uznać sprawy
 * za definitywnie załatwioną. Najdalej, na co mu wolno, to `probably_resolved`.
 * Potwierdzenie jest decyzją człowieka i wymaga jego komendy — wymuszone
 * w store.ts, nie w promptcie.
 */
import { createApp } from "../index.js";
import { CopilotStore } from "../state/store.js";
import { OPEN_STATUSES, type Issue } from "../state/types.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const age = (iso: string): string => {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return "teraz";
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} dni`;
};

const MARK: Record<string, string> = {
  urgent: "‼",
  decision: "?",
  reply: "→",
  monitor: "·",
  informational: " ",
};

function line(i: Issue): string {
  const shown = i.lastPresentedAt ? "" : "  NOWE";
  return (
    `${MARK[i.category] ?? " "} ${i.id}  ${i.title}\n` +
    `    ${i.status} · ${i.category}/${i.priority} · zmiana ${age(i.updatedAt)}${shown}\n` +
    (i.waitingFor ? `    czekamy: ${i.waitingFor}\n` : "") +
    (i.lastErpSummary ? `    TeaBrew: ${i.lastErpSummary}\n` : "") +
    (i.notificationCandidate ? `    ⚑ ${i.notificationReason ?? "warte powiadomienia"}\n` : "")
  );
}

function detail(i: Issue): string {
  return (
    `\n${i.title}\n${"─".repeat(Math.min(72, i.title.length))}\n` +
    `${i.id} · ${i.status} · ${i.category}/${i.priority}\n\n` +
    `${i.summary}\n\n` +
    (i.waitingFor ? `Czekamy: ${i.waitingFor}\n` : "") +
    (i.relatedOrderRefs.length > 0 ? `Zamówienia: ${i.relatedOrderRefs.join(", ")}\n` : "") +
    (i.relatedProductRefs.length > 0 ? `Produkty: ${i.relatedProductRefs.join(", ")}\n` : "") +
    (i.lastErpSummary ? `TeaBrew (${i.lastEvidenceAt ?? "?"}): ${i.lastErpSummary}\n` : "") +
    `\nWiadomości (${i.sourceRefs.length}) — to WSKAŹNIKI, treść jest w poczcie:\n` +
    i.sourceRefs
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => `  ${r.date.slice(0, 16).replace("T", " ")}  ${r.from ?? "?"}  ${r.subject}`)
      .join("\n") +
    `\n\nHistoria:\n` +
    i.history.map((h) => `  ${h.at.slice(0, 16).replace("T", " ")}  ${h.what}  [${h.by}]`).join("\n") +
    "\n"
  );
}

function main(): number {
  const app = createApp();

  const closeId = flag("--zamknij");
  if (closeId) {
    // Osobny store z aktorem "wlasciciel" — to jedyny aktor, któremu store
    // pozwoli ustawić status `resolved`.
    const owner = new CopilotStore({ dir: app.config.copilot.stateDir, actor: "wlasciciel" });
    const note = argv[argv.indexOf("--zamknij") + 2] ?? "";
    const target = owner.get(closeId);
    if (!target) {
      console.error(`Nie ma sprawy ${closeId}. Lista: npm run sprawy`);
      return 1;
    }
    owner.ownerResolve(closeId, note);
    console.log(`\n✓ Zamknięta: ${target.title}\n  ${closeId}${note ? ` — ${note}` : ""}\n`);
    return 0;
  }

  const store = app.store;
  const warn = store.integrityWarning();
  if (warn) console.warn(`⚠ ${warn}\n`);

  const showId = flag("--pokaz");
  if (showId) {
    const one = store.get(showId);
    if (!one) {
      console.error(`Nie ma sprawy ${showId}.`);
      return 1;
    }
    console.log(detail(one));
    return 0;
  }

  const all = argv.includes("--wszystkie") || argv.includes("--all");
  const list = all
    ? store.all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : store.openIssues();

  const scan = store.lastOkScanAt();
  console.log(
    `\n${list.length} ${all ? "spraw (wszystkie)" : "otwartych spraw"}` +
      (scan ? ` · ostatni skan poczty ${age(scan)} temu` : " · monitor jeszcze nie skanował"),
  );

  if (!scan) {
    console.log(
      "\nUWAGA: monitor nie wykonał jeszcze ani jednego udanego skanu, więc pusta\n" +
        "lista NIE znaczy, że nic nie przyszło. Uruchom: npm run monitor\n",
    );
  }

  if (list.length === 0) {
    console.log(all ? "\nPamięć Copilota jest pusta.\n" : "\nNic otwartego.\n");
    return 0;
  }

  console.log("");
  for (const i of list) console.log(line(i));

  const byStatus = OPEN_STATUSES.map(
    (s) => [s, store.all().filter((i) => i.status === s).length] as const,
  ).filter(([, n]) => n > 0);
  console.log(
    byStatus.map(([s, n]) => `${s}: ${n}`).join(" · ") +
      `\n\nSzczegóły:  npm run sprawy -- --pokaz <id>` +
      `\nZamknięcie: npm run sprawy -- --zamknij <id> "powód"\n`,
  );
  return 0;
}

process.exit(main());
