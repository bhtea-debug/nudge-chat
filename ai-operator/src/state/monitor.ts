import { z } from "zod";
import type { CapabilityContext, Scope } from "../capability/types.js";
import type { CapabilityRegistry } from "../capability/registry.js";
import { MemoryAuditSink, newCorrelationId } from "../capability/audit.js";
import type { ModelLayer } from "../model/roles.js";
import { MailMessage } from "../mail/types.js";
import { MONITOR_SYSTEM_PROMPT } from "../agent/prompt.js";
import { matchIssue } from "./correlate.js";
import { extractOrderRefs, isOwnOrderShape } from "./order-refs.js";
import { OrderResponse } from "../teabrew/contract.js";
import { splitNoise } from "./noise.js";
import { classifyDeterministic, deservesIssue, domainOf } from "./classify-deterministic.js";
import type { CopilotStore } from "./store.js";
import { ISSUE_CATEGORIES, ISSUE_PRIORITIES, type IssueStatus, type SourceRef } from "./types.js";
import { explainModelError } from "../model/errors.js";

/**
 * Background Operator — obserwuje pocztę bez rozmowy z człowiekiem.
 *
 * Trzy zasady, które ten plik ma egzekwować:
 *
 *  1. **Przetwarzamy tylko nowe rzeczy.** Checkpoint per folder plus globalny
 *     zbiór widzianych Message-ID. Ponowna analiza całej skrzynki przy każdym
 *     przebiegu byłaby kosztem bez żadnej nowej informacji.
 *  2. **Filtr przed modelem jest deterministyczny.** Newsletter nie ma po co
 *     kosztować tokenów, ale filtr wolno oprzeć wyłącznie na nagłówkach RFC —
 *     patrz noise.ts.
 *  3. **Operator nie wykonuje działań.** Może wykryć sprawę, sklasyfikować ją,
 *     dopiąć do istniejącej, sprawdzić TeaBrew i zmienić SWÓJ stan. Nie może
 *     wysłać maila ani niczego zmienić w systemach źródłowych — i nie ma do
 *     tego narzędzi, bo rejestr ich nie zawiera.
 */

const AGENT = "bht-copilot/monitor";

/** Odpowiedź modelu na jedną wiadomość. Kategorie i priorytety z types.ts. */
const Classified = z.object({
  id: z.string(),
  /** `false` = to nie zasługuje na sprawę (informacja bez działania). */
  sprawa: z.boolean().default(true),
  tytul: z.string().default(""),
  streszczenie: z.string().default(""),
  kategoria: z.enum(ISSUE_CATEGORIES).default("informational"),
  priorytet: z.enum(ISSUE_PRIORITIES).default("normal"),
  naCoCzekamy: z.string().default(""),
  numery: z.array(z.string()).default([]),
  produkty: z.array(z.string()).default([]),
  /** Czy to sytuacja warta powiadomienia na telefon. Kanał jeszcze nie istnieje. */
  wartePowiadomienia: z.boolean().default(false),
  powodPowiadomienia: z.string().default(""),
});
const ClassifiedList = z.array(Classified);

export interface MonitorCost {
  readonly scans: number;
  readonly messagesConsidered: number;
  readonly messagesFilteredOut: number;
  readonly messagesToModel: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly erpLookups: number;
  readonly issuesCreated: number;
  readonly issuesUpdated: number;
}

export interface MonitorRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly correlationId: string;
  readonly folders: readonly {
    folder: string;
    considered: number;
    filtered: number;
    toModel: number;
    created: number;
    updated: number;
    error: string | null;
  }[];
  readonly cost: MonitorCost;
  readonly droppedReasons: Readonly<Record<string, number>>;
  readonly notificationCandidates: readonly { id: string; title: string; reason: string }[];
}

export interface MonitorOptions {
  readonly registry: CapabilityRegistry;
  readonly models: ModelLayer;
  readonly scopes: readonly Scope[];
  readonly store: CopilotStore;
  readonly auditFile?: string | undefined;
  readonly folders: readonly string[];
  /** Ile dni wstecz przy pierwszym przebiegu dla folderu bez checkpointu. */
  readonly firstRunDays: number;
  readonly maxPerFolder: number;
  readonly maxErpLookups: number;
  /**
   * `deterministic` — bez modelu i bez kosztu. Fakty zbieramy sami, ocenę robi
   * Claude w momencie pytania, na subskrypcji właściciela. To jest domyślna
   * i zalecana ścieżka: zgodna z zasadą „nasza infrastruktura nie woła drugiego
   * modelu", a najważniejsza funkcja (numery z poczty nieobecne w TeaBrew) i tak
   * modelu nie potrzebuje.
   *
   * `model` — ocena po naszej stronie. Wymaga kredytów API.
   */
  readonly classifier: "deterministic" | "model";
  /** Adres własnej skrzynki — do rozpoznania „pisane DO nas" vs „w kopii". */
  readonly ownAddress?: string | null;
  /** Folder wysłanych. `null` = sygnał „znany kontrahent" niedostępny. */
  readonly sentFolder?: string | null;
}

/** Ujednolicony wynik klasyfikacji, niezależnie od tego, kto ją wykonał. */
interface Verdict {
  readonly worthIssue: boolean;
  readonly title: string;
  readonly summary: string;
  readonly category: (typeof ISSUE_CATEGORIES)[number];
  readonly priority: (typeof ISSUE_PRIORITIES)[number];
  readonly waitingFor: string | null;
  readonly orderRefs: string[];
  /** Numery, które wolno sprawdzać w TeaBrew i którymi wolno alarmować. */
  readonly refsForErp: string[];
  readonly productRefs: string[];
  readonly notify: boolean;
  readonly notifyWhy: string | null;
  readonly whyListed: string;
  readonly likelyIrrelevant: boolean;
}

/** Jak często odświeżamy listę domen z folderu wysłanych. */
const KNOWN_DOMAINS_TTL_HOURS = 24;

export class MailMonitor {
  constructor(private readonly opts: MonitorOptions) {}

  async runOnce(signal?: AbortSignal): Promise<MonitorRun> {
    const startedAt = new Date().toISOString();
    const correlationId = newCorrelationId();
    const audit = new MemoryAuditSink(this.opts.auditFile);
    const ctx: CapabilityContext = {
      agent: AGENT,
      correlationId,
      scopes: this.opts.scopes,
      audit,
      ...(signal ? { signal } : {}),
    };

    const folders: MonitorRun["folders"][number][] = [];
    const dropped: Record<string, number> = {};
    const notifications: { id: string; title: string; reason: string }[] = [];
    let cost: MonitorCost = {
      scans: 0,
      messagesConsidered: 0,
      messagesFilteredOut: 0,
      messagesToModel: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      erpLookups: 0,
      issuesCreated: 0,
      issuesUpdated: 0,
    };
    let erpBudget = this.opts.maxErpLookups;

    // Lista „z kim korespondujemy" — raz na dobę, bo zmienia się wolno,
    // a każdy skan to dodatkowe zapytanie do serwera poczty.
    await this.refreshKnownDomains(ctx);

    for (const folder of this.opts.folders) {
      const cp = this.opts.store.checkpoint(folder);
      const scanAt = new Date().toISOString();
      let considered = 0;
      let filtered = 0;
      let toModel = 0;
      let created = 0;
      let updated = 0;
      let error: string | null = null;

      try {
        // Okno liczone od checkpointu. Doba zapasu, bo wiadomość może dotrzeć
        // z datą wcześniejszą niż moment naszego skanu (opóźnienia po drodze),
        // a duplikaty i tak odsiewa globalny zbiór Message-ID.
        const sinceDays = cp.processedThrough
          ? Math.min(30, Math.max(1, Math.ceil(daysSince(cp.processedThrough)) + 1))
          : this.opts.firstRunDays;

        const listed = (await this.opts.registry.invoke(
          "mail_list_recent",
          { sinceDays, limit: this.opts.maxPerFolder, unreadOnly: false, folder },
          ctx,
        )) as { messages: z.infer<typeof MailMessage>[]; truncated: boolean; limitNote: string | null };

        cost = { ...cost, scans: cost.scans + 1 };

        // 1. Odsiew tego, co już kiedykolwiek widzieliśmy — w DOWOLNYM folderze.
        //    To obsługuje naraz: powtórny skan, przeniesienie wiadomości między
        //    folderami i duplikat tej samej wiadomości w dwóch miejscach.
        const fresh = listed.messages.filter((m) => !this.opts.store.hasSeen(m.id));
        considered = fresh.length;

        // 2. Filtr deterministyczny przed modelem.
        const { keep, dropped: noise } = splitNoise(fresh);
        filtered = noise.length;
        for (const d of noise) {
          dropped[d.why] = (dropped[d.why] ?? 0) + 1;
          this.opts.store.markMessageSeen(d.message.id, folder, null, scanAt);
        }

        toModel = keep.length;

        if (keep.length > 0) {
          // Klasyfikacja: deterministyczna (domyślnie, bez kosztu) albo modelem.
          // `verdicts` ma ten sam kształt w obu ścieżkach, więc reszta pętli nie
          // wie, kto ocenił — i nie ma jak się rozjechać między trybami.
          const verdicts = new Map<string, Verdict>();

          if (this.opts.classifier === "model") {
            const rows = await this.classify(keep, signal);
            cost = {
              ...cost,
              modelCalls: cost.modelCalls + 1,
              inputTokens: cost.inputTokens + rows.inputTokens,
              outputTokens: cost.outputTokens + rows.outputTokens,
            };
            for (const r of rows.items) {
              verdicts.set(r.id, {
                worthIssue: r.sprawa,
                title: r.tytul,
                summary: r.streszczenie,
                category: r.kategoria,
                priority: r.priorytet,
                waitingFor: r.naCoCzekamy || null,
                orderRefs: r.numery.map((x) => x.trim()).filter(Boolean),
                // Model wybrał numery semantycznie, więc wszystkie są mocne.
                refsForErp: r.numery.map((x) => x.trim()).filter(Boolean),
                productRefs: r.produkty,
                notify: r.wartePowiadomienia,
                notifyWhy: r.powodPowiadomienia || null,
                whyListed: `ocena modelu: ${r.kategoria}/${r.priorytet}`,
                likelyIrrelevant: false,
              });
            }
          } else {
            for (const msg of keep) {
              const d = classifyDeterministic(msg, {
                ownAddress: this.opts.ownAddress ?? null,
                isKnownDomain: this.opts.sentFolder
                  ? (dom) => this.opts.store.isKnownDomain(dom)
                  : null,
              });
              verdicts.set(msg.id, {
                worthIssue: deservesIssue(d),
                title: d.title,
                summary: d.summary,
                category: d.category,
                priority: d.priority,
                waitingFor: d.waitingFor,
                orderRefs: d.orderRefs,
                refsForErp: d.refsForErp,
                // Nazw produktów nie da się rzetelnie wyciągnąć bez rozumienia
                // treści, a zgadywanie po słowach dawałoby fałszywe powiązania.
                productRefs: [],
                // Powiadomienie ustawia FAKT sprawdzony w TeaBrew (patrz
                // enrichFromErp), nie wrażenie z tematu.
                notify: false,
                notifyWhy: null,
                whyListed: d.whyListed,
                likelyIrrelevant: d.likelyIrrelevant,
              });
            }
          }

          for (const msg of keep) {
            const row = verdicts.get(msg.id);
            if (!row) {
              // Model pominął wiadomość. NIE oznaczamy jej jako widzianej —
              // niech wróci w następnym przebiegu, zamiast zniknąć na zawsze.
              continue;
            }
            if (!row.worthIssue) {
              this.opts.store.markMessageSeen(msg.id, folder, null, scanAt);
              const why =
                this.opts.classifier === "model"
                  ? "model uznał, że nie wymaga sprawy"
                  : "ani nie do nas, ani bez numeru zamówienia";
              dropped[why] = (dropped[why] ?? 0) + 1;
              continue;
            }

            const ref = toSourceRef(msg, folder);
            const orderRefs = mergeRefs(row.orderRefs, msg.subject, msg.snippet);
            const match = matchIssue(this.opts.store.all(), {
              ref,
              parentIds: parentIdsOf(msg),
              orderRefs,
            });

            if (match.issue && match.confidence === "high") {
              this.opts.store.addSource(match.issue.id, ref, `nowa wiadomość: ${match.why}`, scanAt);
              this.opts.store.patchIssue(
                match.issue.id,
                {
                  summary: row.summary || match.issue.summary,
                  category: row.category,
                  priority: row.priority,
                  status: nextStatus(match.issue.status, row.category),
                  relatedOrderRefs: [...new Set([...match.issue.relatedOrderRefs, ...orderRefs])],
                  relatedProductRefs: [
                    ...new Set([...match.issue.relatedProductRefs, ...row.productRefs]),
                  ],
                  waitingFor: row.waitingFor ?? match.issue.waitingFor,
                  whyListed: row.whyListed,
                  // Nowa wiadomość w sprawie unieważnia „prawdopodobnie
                  // nieistotne": ktoś do niej wrócił, więc jest korespondencją.
                  likelyIrrelevant: false,
                  notificationCandidate: row.notify || match.issue.notificationCandidate,
                  notificationReason: row.notifyWhy ?? match.issue.notificationReason,
                },
                `status: aktualizacja z nowej wiadomości (${row.category})`,
                scanAt,
              );
              this.opts.store.markMessageSeen(msg.id, folder, match.issue.id, scanAt);
              updated += 1;
              continue;
            }

            // Brak pewnego dopasowania: zakładamy nową sprawę. Podobieństwa
            // dopisujemy do streszczenia, żeby człowiek je widział — zamiast
            // scalać na podstawie jednego sygnału.
            const nearNote =
              match.nearMisses.length > 0
                ? ` (uwaga: może dotyczyć tej samej rzeczy co ${match.nearMisses.map((n) => n.id).join(", ")} — ${match.why})`
                : "";

            const issue = this.opts.store.createIssue({
              title: row.title || msg.subject,
              summary: (row.summary || msg.snippet) + nearNote,
              category: row.category,
              priority: row.priority,
              status: row.category === "monitor" ? "monitoring" : "new",
              classifier: this.opts.classifier,
              whyListed: row.whyListed,
              likelyIrrelevant: row.likelyIrrelevant,
              ref,
              relatedOrderRefs: orderRefs,
              relatedProductRefs: row.productRefs,
              waitingFor: row.waitingFor,
              notificationCandidate: row.notify,
              notificationReason: row.notifyWhy,
              at: scanAt,
            });
            this.opts.store.markMessageSeen(msg.id, folder, issue.id, scanAt);
            created += 1;
          }
        }

        // 3. Dociągnięcie danych z TeaBrew dla spraw, w których numer ma znaczenie.
        //    Robimy to PO klasyfikacji, żeby wiedzieć, które sprawy są tego warte.
        erpBudget = await this.enrichFromErp(ctx, erpBudget, scanAt, (n) => {
          cost = { ...cost, erpLookups: cost.erpLookups + n };
        });

        const newest = listed.messages.map((m) => m.date).sort().at(-1) ?? cp.processedThrough;
        this.opts.store.saveCheckpoint(
          {
            folder,
            processedThrough: newest,
            lastScanAt: scanAt,
            lastOkScanAt: scanAt,
            lastError: listed.truncated ? (listed.limitNote ?? "wynik przycięty do limitu") : null,
            messagesSeen: cp.messagesSeen + toModel,
          },
          scanAt,
        );
      } catch (err) {
        // Surowy `400 {"type":"error",...}` wysyła człowieka szukać usterki
        // w kodzie, gdy problemem jest saldo na koncie. Tłumaczymy na komunikat,
        // z którego wynika, co zrobić.
        const e = explainModelError(err);
        error = e.kind === "inny" ? e.plain : `${e.plain} ${e.advice}`;
        // Nieudany skan NIE przesuwa checkpointu. Inaczej awaria połączenia
        // cicho przeskakiwałaby wiadomości, których nikt już nie zobaczy.
        this.opts.store.saveCheckpoint(
          { ...cp, lastScanAt: scanAt, lastError: error },
          scanAt,
        );
      }

      cost = {
        ...cost,
        messagesConsidered: cost.messagesConsidered + considered,
        messagesFilteredOut: cost.messagesFilteredOut + filtered,
        messagesToModel: cost.messagesToModel + toModel,
        issuesCreated: cost.issuesCreated + created,
        issuesUpdated: cost.issuesUpdated + updated,
      };
      folders.push({ folder, considered, filtered, toModel, created, updated, error });
    }

    this.opts.store.compactIfNeeded();

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      correlationId,
      folders,
      cost,
      droppedReasons: dropped,
      notificationCandidates: notifications,
    };
  }

  /**
   * Odświeża listę domen, do których faktycznie pisaliśmy — z folderu wysłanych.
   *
   * To najmocniejszy sygnał „kontrahent, a nie wysyłka masowa" dostępny bez
   * modelu, bo wynika z NASZEGO działania. Newsletter nie może go podrobić.
   *
   * Raz na dobę, bo relacje handlowe zmieniają się wolno, a każdy skan to
   * dodatkowe zapytanie do serwera poczty. Nazwa folderu MUSI przyjść
   * z konfiguracji — zgadywanie jej jest w tym projekcie zakazane.
   */
  private async refreshKnownDomains(ctx: CapabilityContext): Promise<void> {
    const folder = this.opts.sentFolder;
    if (!folder) return;

    const last = this.opts.store.knownDomainsRefreshedAt();
    if (last && hoursSince(last) < KNOWN_DOMAINS_TTL_HOURS) return;

    try {
      const sent = (await this.opts.registry.invoke(
        "mail_list_recent",
        { sinceDays: 30, limit: 50, unreadOnly: false, folder },
        ctx,
      )) as { messages: z.infer<typeof MailMessage>[] };

      const domains = new Set<string>();
      for (const m of sent.messages) {
        for (const a of [...m.to, ...m.cc]) {
          const d = domainOf(a.address);
          if (d) domains.add(d);
        }
      }
      this.opts.store.rememberKnownDomains([...domains]);
    } catch {
      // Nieudany skan wysłanych nie może przewrócić przebiegu. Skutek jest
      // widoczny: sprawy powiedzą, że nie umieją ocenić nadawcy, zamiast
      // po cichu uznać każdego za nieznanego.
    }
  }

  /**
   * Sprawdza w TeaBrew numery ze spraw, które tego wymagają, i zapisuje krótkie
   * podsumowanie. To jedyne miejsce, w którym operator w tle sięga do ERP.
   */
  private async enrichFromErp(
    ctx: CapabilityContext,
    budget: number,
    at: string,
    spent: (n: number) => void,
  ): Promise<number> {
    if (budget <= 0) return 0;
    const worth = this.opts.store
      .openIssues()
      .filter((i) => i.relatedOrderRefs.length > 0)
      // Bez modelu kategoria jest słabym sygnałem, więc zawężanie po niej
      // pomijałoby dokładnie te sprawy, po które ten system istnieje. Budżet
      // wywołań i tak ogranicza pracę.
      .filter((i) => this.opts.classifier === "deterministic" || ["urgent", "decision", "reply"].includes(i.category))
      // Nie odpytujemy tego samego zamówienia co przebieg — dopiero gdy sprawa
      // zmieniła się po ostatnim sprawdzeniu.
      .filter((i) => i.lastEvidenceAt === null || i.updatedAt > i.lastEvidenceAt);

    for (const issue of worth) {
      if (budget <= 0) break;
      // Sprawdzamy tylko numery o KSZTAŁCIE naszego numeru zamówienia.
      // Numeracja kontrahenta i numery przesyłek gwarantowałyby odpowiedź
      // „nie znam", czyli fałszywy alarm przy każdym przebiegu.
      const ref = issue.relatedOrderRefs.find(isOwnOrderShape);
      if (!ref) continue;
      budget -= 1;
      spent(1);
      try {
        // Typ z KONTRAKTU, nie doraźne rzutowanie. Pierwsza wersja rzutowała na
        // `{ order?: { fulfillmentStatus } }` — pola, którego w odpowiedzi NIE MA
        // (jest tablica `orders`). Skutek: w sprawie widniało „2307348: ? / ?"
        // przy poprawnie znalezionym zamówieniu. Rzutowanie na wymyślony kształt
        // zabiera kompilatorowi możliwość złapania takiej pomyłki.
        const out = (await this.opts.registry.invoke(
          "teabrew_get_order_status",
          { ref },
          ctx,
        )) as z.infer<typeof OrderResponse>["data"];

        const missing = out.matchedBy === "none";
        const first = out.orders[0];
        // Sformułowanie jest CELOWO bez interpretacji. „Prawdopodobnie nie
        // zostało wprowadzone" byłoby domysłem — numer może też być literówką
        // klienta albo numerem z innego systemu. Podajemy fakt: nie ma go tam.
        const summary = missing
          ? `numeru ${ref} NIE MA w TeaBrew`
          : first
            ? `${ref}: realizacja ${first.fulfillmentStatus}` +
              `${first.paymentStatus ? `, płatność ${first.paymentStatus}` : ""}` +
              `${first.customerName ? ` (${first.customerName})` : ""}` +
              `${first.production.length > 0 ? `, zleceń produkcyjnych: ${first.production.length}` : ""}`
            : `${ref}: dopasowane po ${out.matchedBy}, ale odpowiedź nie zawiera zamówienia`;

        // Konflikt między obietnicą w mailu a stanem systemu jest dokładnie tym,
        // po co ten system istnieje — i jest kandydatem do powiadomienia.
        // To jest jedyne miejsce, w którym monitor podnosi priorytet — i robi to
        // na podstawie FAKTU, nie wrażenia z tematu: ktoś pisze o zamówieniu,
        // którego w systemie nie ma. Bez modelu, bez interpretacji treści.
        this.opts.store.patchIssue(
          issue.id,
          {
            lastErpSummary: summary,
            lastEvidenceAt: at,
            ...(missing
              ? {
                  priority: "high" as const,
                  notificationCandidate: true,
                  notificationReason: `w wiadomości jest numer ${ref}, którego nie ma w TeaBrew`,
                }
              : {}),
          },
          `sprawdzone w TeaBrew: ${summary}`,
          at,
        );
      } catch (err) {
        // Nieudane sprawdzenie ZAPISUJEMY jako nieudane. Cisza wyglądałaby
        // później jak „sprawdzone i w porządku".
        this.opts.store.patchIssue(
          issue.id,
          { lastErpSummary: `nie udało się sprawdzić ${ref}: ${err instanceof Error ? err.message : String(err)}` },
          "status: próba sprawdzenia w TeaBrew nie udała się",
          at,
        );
      }
    }
    return budget;
  }

  private async classify(
    messages: readonly z.infer<typeof MailMessage>[],
    signal?: AbortSignal,
  ): Promise<{ items: z.infer<typeof ClassifiedList>; inputTokens: number; outputTokens: number }> {
    // Do modelu idzie PODGLĄD, nie pełna treść. Wystarcza do klasyfikacji,
    // a pełne treści nie mają po co przechodzić przez model ani przez log.
    const payload = messages.map((m) => ({
      id: m.id,
      od: m.from ? `${m.from.name ?? ""} <${m.from.address}>`.trim() : "(nieznany)",
      data: m.date,
      temat: m.subject,
      odpowiedziano: m.answered,
      wWatku: m.references.length > 0,
      podglad: m.snippet,
    }));

    const res = await this.opts.models.completeDetailed({
      role: "fast",
      system: MONITOR_SYSTEM_PROMPT,
      prompt: `Przeanalizuj ${messages.length} nowych wiadomości:\n\n${JSON.stringify(payload, null, 1)}`,
      ...(signal ? { signal } : {}),
    });

    const parsed = ClassifiedList.safeParse(extractJsonArray(res.text));
    return {
      // Nieparsowalna odpowiedź nie może udawać, że sklasyfikowała cokolwiek.
      // Puste = wiadomości NIE zostaną oznaczone jako widziane i wrócą.
      items: parsed.success ? parsed.data : [],
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }
}

/** Status po nowej wiadomości. Nigdy nie cofa sprawy do „new". */
function nextStatus(current: IssueStatus, category: string): IssueStatus {
  if (current === "resolved") return "needs_attention"; // klient wrócił do sprawy
  if (category === "urgent") return "needs_attention";
  if (category === "decision") return "waiting_for_owner";
  if (category === "reply") return "waiting_for_owner";
  if (category === "monitor") return current === "new" ? "monitoring" : current;
  return current;
}

function toSourceRef(msg: z.infer<typeof MailMessage>, folder: string): SourceRef {
  return {
    kind: "mail",
    messageId: msg.id,
    threadId: msg.threadId === msg.id ? null : msg.threadId,
    folder,
    date: msg.date,
    subject: msg.subject,
    from: msg.from?.address ?? null,
  };
}

function parentIdsOf(msg: z.infer<typeof MailMessage>): string[] {
  const all = [...msg.references, ...(msg.inReplyTo ? [msg.inReplyTo] : [])];
  return [...new Set(all.filter((r) => r !== msg.id))];
}

/**
 * Numery zamówień: te wskazane przez model plus te znalezione deterministycznie
 * w temacie. Model bywa oszczędny, a numer w temacie jest twardym faktem.
 */
function mergeRefs(fromModel: readonly string[], subject: string, snippet: string): string[] {
  return [
    ...new Set([
      ...fromModel.map((r) => r.trim()).filter(Boolean),
      ...extractOrderRefs(subject),
      ...extractOrderRefs(snippet).slice(0, 3),
    ]),
  ];
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

/** Model potrafi owinąć JSON w blok markdown albo dodać zdanie wstępu. */
function extractJsonArray(raw: string): unknown {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
