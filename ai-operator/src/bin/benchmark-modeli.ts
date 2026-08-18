#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ROSSMANN_NEW_ORDER_POLICY_ID,
  classifyByBusinessPolicy,
} from "../classification/business-policy.js";
import { findOrderRefs, isOwnOrderShape } from "../state/order-refs.js";

type Klasa = "A" | "B" | "C";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET_PATH = resolve(ROOT, "state/ocena/zbior.json");
const LABELS_PATH = resolve(ROOT, "state/ocena/etykiety.json");
const ENV_PATH = resolve(ROOT, ".env.benchmark.local");
const POLICY_MODE = process.argv.includes("--policy=rossmann-v1");
const REPORT_PATH = resolve(
  ROOT,
  POLICY_MODE
    ? "docs/MODEL-BENCHMARK-POLICY-REGRESSION.md"
    : "docs/MODEL-BENCHMARK.md",
);

// Te wartości przypinają dokładnie ten zamrożony zbiór, który właściciel
// zatwierdził 18.08.2026. Sama liczba rekordów i rozkład klas nie wystarczają,
// bo zmieniony plik mógłby nadal spełniać oba warunki.
const EXPECTED_DATASET_SHA256 =
  "3c4cc5cd65f939cde7b1ec86157ddcde8132af43026713a0723bb3ad599b960a";
const EXPECTED_LABELS_SHA256 =
  "0e2411a61b3115c18fc34f015899fd16dc8b084a6169bf2460b7034aa095aa19";

const PRICING_CHECKED_AT = "2026-08-18";
const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const MODELS_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";
const MODELS_API_SOURCE = "https://platform.claude.com/docs/en/api/models/list";
const STRUCTURED_OUTPUT_SOURCE =
  "https://platform.claude.com/docs/en/build-with-claude/structured-outputs";

const CLASSIFIER_PROMPT_VERSION = "classifier-v1";
const CLASSIFIER_PROMPT = `Jesteś klasyfikatorem nowej wiadomości firmowej dla właściciela firmy.

Przypisz dokładnie jedną klasę:
A — ALARM NATYCHMIAST: wiadomość ma przerwać właścicielowi obecną pracę. To realny problem wymagający szybkiej reakcji, istotne ryzyko dla klienta, produkcji albo sprzedaży, termin wymagający działania teraz, ważna eskalacja lub bezpośrednia pilna prośba o decyzję.
B — PODSUMOWANIE: właściciel powinien o tym wiedzieć, ale wiadomość nie powinna przerywać mu bieżącej pracy.
C — NIEISTOTNE: wiadomość nie powinna trafić ani do alarmu, ani do istotnego podsumowania.

Najważniejsza zasada: klasy A używaj oszczędnie, ale nie przeocz prawdziwego alarmu. Oceniaj wyłącznie przekazane pola wiadomości. Nie korzystaj z zewnętrznej wiedzy i nie dopowiadaj brakujących faktów. Confidence ma oznaczać pewność przypisania tej klasy. Reason ma być jednym krótkim zdaniem po polsku, bez toku rozumowania.`;

const DatasetItemSchema = z
  .object({
    id: z.string().min(1),
    data: z.string(),
    nadawca: z.string(),
    temat: z.string(),
    podglad: z.string(),
  })
  .passthrough();

const DatasetSchema = z.array(DatasetItemSchema);

const LabelSchema = z
  .object({
    klasa: z.enum(["A", "B", "C"]),
    zleZrozumiane: z.boolean().optional(),
  })
  .passthrough();

const LabelsSchema = z.record(z.string(), LabelSchema);

const PredictionSchema = z.object({
  class: z.enum(["A", "B", "C"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(240),
});

type DatasetItem = z.infer<typeof DatasetItemSchema>;
type Prediction = z.infer<typeof PredictionSchema>;

interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheRead: number;
}

interface ModelCandidate {
  readonly id: string;
  readonly name: string;
  readonly tier: "tani" | "średni" | "referencyjny";
  readonly disableAdaptiveThinking?: boolean;
  readonly price: (at: Date) => Price;
}

const stablePrice = (price: Price): ((at: Date) => Price) => () => price;

const CANDIDATES: readonly ModelCandidate[] = [
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    tier: "tani",
    price: stablePrice({ input: 1, output: 5, cacheWrite5m: 1.25, cacheRead: 0.1 }),
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    tier: "średni",
    disableAdaptiveThinking: true,
    price: (at) =>
      at.getTime() < Date.parse("2026-09-01T00:00:00Z")
        ? { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 }
        : { input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    tier: "referencyjny",
    disableAdaptiveThinking: true,
    price: stablePrice({ input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 }),
  },
] as const;

interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

interface PredictionResult {
  readonly item: DatasetItem;
  readonly prediction: Prediction;
  readonly usage: Usage;
  readonly decidedBy: "model" | "business-policy";
  readonly policyId: string | null;
}

interface RunResult {
  readonly model: ModelCandidate;
  readonly runNumber: number;
  readonly predictions: readonly PredictionResult[];
  readonly usage: Usage;
  readonly costUsd: number;
}

interface Metrics {
  readonly tpA: number;
  readonly fnA: number;
  readonly fpA: number;
  readonly recallA: number;
  readonly precisionA: number;
  readonly f1A: number;
  readonly accuracy: number;
  readonly confusion: Record<Klasa, Record<Klasa, number>>;
  readonly falseNegativesA: readonly PredictionResult[];
  readonly falsePositivesA: readonly PredictionResult[];
}

interface StabilityStats {
  readonly changedMessages: number;
  readonly changedAssignments: number;
  readonly goldAMissedAtLeastOnce: number;
  readonly averageConfidenceSpread: number;
  readonly maxConfidenceSpread: number;
  readonly worstRecallA: number;
  readonly worstPrecisionA: number;
  readonly maxFalsePositivesA: number;
}

type StabilityAssessment = "passed" | "failed" | "not-measured";
type VerdictName = "GO" | "CONDITIONAL GO" | "NO-GO";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    class: { type: "string", enum: ["A", "B", "C"] },
    // Claude structured outputs nie obsługuje ograniczeń minimum/maximum
    // ani minLength/maxLength. Te warunki nadal wymusza PredictionSchema po odpowiedzi.
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["class", "confidence", "reason"],
  additionalProperties: false,
} as const;

function stop(message: string): never {
  process.stderr.write(`STOP: ${message}\n`);
  process.exit(2);
}

function readRequiredFile(path: string, label: string): string {
  if (!existsSync(path)) {
    stop(
      `brakuje ${label}: ${path}. Benchmark nie regeneruje datasetu i nie pobiera poczty.`,
    );
  }
  return readFileSync(path, "utf8");
}

function parseApiKey(): string {
  const raw = readRequiredFile(ENV_PATH, "lokalnego pliku .env.benchmark.local");
  const line = raw
    .split(/\r?\n/u)
    .find((entry) => /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=/u.test(entry));

  if (!line) stop("w .env.benchmark.local nie ma ANTHROPIC_API_KEY.");

  let value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (!value || /^(?:change-me|placeholder|your[-_])/iu.test(value)) {
    stop("ANTHROPIC_API_KEY w .env.benchmark.local jest pusty albo przykładowy.");
  }
  return value;
}

function parseFrozenData(): {
  dataset: DatasetItem[];
  labels: Record<string, z.infer<typeof LabelSchema>>;
  datasetHash: string;
  labelsHash: string;
} {
  const datasetRaw = readRequiredFile(DATASET_PATH, "zamrożonego datasetu");
  const labelsRaw = readRequiredFile(LABELS_PATH, "zamrożonych etykiet");
  const datasetHash = sha256(datasetRaw);
  const labelsHash = sha256(labelsRaw);

  if (datasetHash !== EXPECTED_DATASET_SHA256) {
    stop("zbior.json nie jest zatwierdzonym, zamrożonym datasetem (SHA-256 nie pasuje).");
  }
  if (labelsHash !== EXPECTED_LABELS_SHA256) {
    stop("etykiety.json nie są zatwierdzonymi gold labels (SHA-256 nie pasuje).");
  }

  let datasetJson: unknown;
  let labelsJson: unknown;
  try {
    datasetJson = JSON.parse(datasetRaw);
    labelsJson = JSON.parse(labelsRaw);
  } catch {
    stop("zbior.json albo etykiety.json nie jest poprawnym JSON-em.");
  }

  const datasetParsed = DatasetSchema.safeParse(datasetJson);
  const labelsParsed = LabelsSchema.safeParse(labelsJson);
  if (!datasetParsed.success) stop("zbior.json ma nieoczekiwany format.");
  if (!labelsParsed.success) stop("etykiety.json ma nieoczekiwany format.");

  const dataset = datasetParsed.data;
  const labels = labelsParsed.data;
  if (dataset.length !== 50) {
    stop(`zamrożony dataset ma ${dataset.length} rekordów zamiast wymaganych 50.`);
  }

  const ids = dataset.map((item) => item.id);
  if (new Set(ids).size !== ids.length) stop("zbior.json zawiera zduplikowane identyfikatory.");
  const labelIds = Object.keys(labels);
  if (labelIds.length !== ids.length || ids.some((id) => !labels[id])) {
    stop("etykiety.json nie odpowiada dokładnie rekordom z zamrożonego zbioru.");
  }

  const distribution = { A: 0, B: 0, C: 0 } satisfies Record<Klasa, number>;
  for (const id of ids) distribution[labels[id]!.klasa] += 1;
  if (distribution.A !== 4 || distribution.B !== 18 || distribution.C !== 28) {
    stop(
      `rozkład gold labels to A=${distribution.A}, B=${distribution.B}, C=${distribution.C}; oczekiwano A=4, B=18, C=28.`,
    );
  }

  return {
    dataset,
    labels,
    datasetHash,
    labelsHash,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeId(id: string): string {
  return sha256(id).slice(0, 12);
}

function modelInput(item: DatasetItem): string {
  // Celowa allowlista. Pola starego klasyfikatora pozostają w zamrożonym pliku,
  // ale nigdy nie trafiają do żądania modelu.
  return JSON.stringify({
    nadawca: item.nadawca,
    temat: item.temat,
    tresc: item.podglad,
    data: item.data,
  });
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

function costOf(usage: Usage, price: Price): number {
  return (
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheWrite * price.cacheWrite5m +
    usage.cacheRead * price.cacheRead
  ) / 1_000_000;
}

async function ensureModelsAvailable(client: Anthropic): Promise<void> {
  process.stdout.write("Sprawdzam dostępność modeli w Claude API…\n");
  for (const candidate of CANDIDATES) {
    try {
      const info = await client.models.retrieve(candidate.id);
      if (info.capabilities?.structured_outputs.supported === false) {
        stop(`${candidate.id} nie obsługuje structured outputs na tym koncie.`);
      }
      process.stdout.write(`  OK: ${candidate.id}\n`);
    } catch (error) {
      stop(`model ${candidate.id} jest niedostępny (${safeError(error)}).`);
    }
  }
}

function safeError(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `HTTP ${error.status ?? "?"}, ${error.name}`;
  return error instanceof Error ? error.name : "nieznany błąd";
}

function policyPrediction(item: DatasetItem): PredictionResult | null {
  if (!POLICY_MODE) return null;

  // Adapter dotyczy wyłącznie zamrożonego benchmarku. Produkcyjne źródło
  // powinno dostarczyć kanoniczne customerId/eventType, zamiast polegać na
  // nazwie wyświetlanej nadawcy.
  const isRossmannFeed = item.nadawca.trim().toLocaleLowerCase("pl-PL") === "rossmann";
  const orderRef = findOrderRefs(item.temat)
    .map((found) => found.ref)
    .find(isOwnOrderShape) ?? null;
  const decision = classifyByBusinessPolicy({
    source: "mail",
    eventType: isRossmannFeed && orderRef ? "new_order" : "message",
    customerId: isRossmannFeed ? "rossmann" : null,
    externalRef: orderRef,
  });

  if (!decision) return null;
  return {
    item,
    prediction: {
      class: decision.classification,
      confidence: 1,
      reason: decision.reason,
    },
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    decidedBy: "business-policy",
    policyId: decision.policyId,
  };
}

async function classifyOne(
  client: Anthropic,
  model: ModelCandidate,
  item: DatasetItem,
): Promise<PredictionResult> {
  const policy = policyPrediction(item);
  if (policy) return policy;

  const message = await client.messages.create({
    model: model.id,
    max_tokens: 256,
    service_tier: "standard_only",
    ...(model.disableAdaptiveThinking
      ? { thinking: { type: "disabled" as const } }
      : {}),
    system: CLASSIFIER_PROMPT,
    messages: [{ role: "user", content: modelInput(item) }],
    output_config: {
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA,
      },
    },
  });

  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") stop(`model ${model.id} nie zwrócił bloku tekstowego.`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text.text);
  } catch {
    stop(`model ${model.id} zwrócił niepoprawny JSON mimo structured output.`);
  }
  const parsed = PredictionSchema.safeParse(parsedJson);
  if (!parsed.success) stop(`wynik modelu ${model.id} nie pasuje do schematu classifier-v1.`);

  return {
    item,
    prediction: parsed.data,
    usage: {
      input: message.usage.input_tokens ?? 0,
      output: message.usage.output_tokens,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
    },
    decidedBy: "model",
    policyId: null,
  };
}

async function runModel(
  client: Anthropic,
  model: ModelCandidate,
  dataset: readonly DatasetItem[],
  runNumber: number,
  runAt: Date,
): Promise<RunResult> {
  process.stdout.write(`\n${model.name}: przebieg ${runNumber}, 0/${dataset.length}`);
  const predictions: PredictionResult[] = [];
  for (let index = 0; index < dataset.length; index += 1) {
    const result = await classifyOne(client, model, dataset[index]!);
    predictions.push(result);
    process.stdout.write(`\r${model.name}: przebieg ${runNumber}, ${index + 1}/${dataset.length}`);
  }
  process.stdout.write("\n");

  const usage = predictions.reduce(
    (total, result) => addUsage(total, result.usage),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );
  return {
    model,
    runNumber,
    predictions,
    usage,
    costUsd: costOf(usage, model.price(runAt)),
  };
}

function calculateMetrics(
  run: RunResult,
  labels: Record<string, z.infer<typeof LabelSchema>>,
): Metrics {
  const confusion: Record<Klasa, Record<Klasa, number>> = {
    A: { A: 0, B: 0, C: 0 },
    B: { A: 0, B: 0, C: 0 },
    C: { A: 0, B: 0, C: 0 },
  };

  for (const result of run.predictions) {
    const gold = labels[result.item.id]!.klasa;
    confusion[gold][result.prediction.class] += 1;
  }

  const falseNegativesA = run.predictions.filter(
    (result) => labels[result.item.id]!.klasa === "A" && result.prediction.class !== "A",
  );
  const falsePositivesA = run.predictions.filter(
    (result) => labels[result.item.id]!.klasa !== "A" && result.prediction.class === "A",
  );
  const tpA = confusion.A.A;
  const fnA = falseNegativesA.length;
  const fpA = falsePositivesA.length;
  const recallA = tpA + fnA === 0 ? 0 : tpA / (tpA + fnA);
  const precisionA = tpA + fpA === 0 ? 0 : tpA / (tpA + fpA);
  const f1A = recallA + precisionA === 0 ? 0 : (2 * recallA * precisionA) / (recallA + precisionA);
  const correct = confusion.A.A + confusion.B.B + confusion.C.C;

  return {
    tpA,
    fnA,
    fpA,
    recallA,
    precisionA,
    f1A,
    accuracy: correct / run.predictions.length,
    confusion,
    falseNegativesA,
    falsePositivesA,
  };
}

function stabilitySummary(
  runs: readonly RunResult[],
  labels: Record<string, z.infer<typeof LabelSchema>>,
): StabilityStats {
  const byId = new Map<string, Prediction[]>();
  for (const run of runs) {
    for (const result of run.predictions) {
      const values = byId.get(result.item.id) ?? [];
      values.push(result.prediction);
      byId.set(result.item.id, values);
    }
  }

  let changedMessages = 0;
  let changedAssignments = 0;
  let goldAMissedAtLeastOnce = 0;
  const spreads: number[] = [];

  for (const [id, predictions] of byId) {
    const classes = predictions.map((prediction) => prediction.class);
    if (new Set(classes).size > 1) changedMessages += 1;
    changedAssignments += classes.slice(1).filter((value) => value !== classes[0]).length;
    if (labels[id]!.klasa === "A" && classes.some((value) => value !== "A")) {
      goldAMissedAtLeastOnce += 1;
    }
    const confidences = predictions.map((prediction) => prediction.confidence);
    spreads.push(Math.max(...confidences) - Math.min(...confidences));
  }

  const runMetrics = runs.map((run) => calculateMetrics(run, labels));

  return {
    changedMessages,
    changedAssignments,
    goldAMissedAtLeastOnce,
    averageConfidenceSpread: spreads.reduce((sum, value) => sum + value, 0) / spreads.length,
    maxConfidenceSpread: Math.max(...spreads),
    worstRecallA: Math.min(...runMetrics.map((metrics) => metrics.recallA)),
    worstPrecisionA: Math.min(...runMetrics.map((metrics) => metrics.precisionA)),
    maxFalsePositivesA: Math.max(...runMetrics.map((metrics) => metrics.fpA)),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number, digits = 4): string {
  return `$${value.toFixed(digits)}`;
}

function confusionTable(metrics: Metrics): string {
  return [
    "| Gold \\ Predykcja | A | B | C |",
    "| --- | ---: | ---: | ---: |",
    `| A | ${metrics.confusion.A.A} | ${metrics.confusion.A.B} | ${metrics.confusion.A.C} |`,
    `| B | ${metrics.confusion.B.A} | ${metrics.confusion.B.B} | ${metrics.confusion.B.C} |`,
    `| C | ${metrics.confusion.C.A} | ${metrics.confusion.C.B} | ${metrics.confusion.C.C} |`,
  ].join("\n");
}

function errorTable(
  title: string,
  errors: readonly PredictionResult[],
  labels: Record<string, z.infer<typeof LabelSchema>>,
): string {
  const lines = [
    `#### ${title}`,
    "",
    "| Anonimowy ID | Gold | Predykcja | Confidence |",
    "| --- | --- | --- | ---: |",
  ];
  if (errors.length === 0) lines.push("| — | — | Brak | — |");
  for (const error of errors) {
    lines.push(
      `| ${safeId(error.item.id)} | ${labels[error.item.id]!.klasa} | ${error.prediction.class} | ${error.prediction.confidence.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

function stabilityAssessmentFor(
  modelId: string,
  cheapId: string,
  stability: StabilityStats,
): StabilityAssessment {
  if (modelId !== cheapId) return "not-measured";
  return stability.goldAMissedAtLeastOnce === 0 && stability.maxFalsePositivesA <= 4
    ? "passed"
    : "failed";
}

function verdictRank(verdict: VerdictName): number {
  if (verdict === "GO") return 2;
  if (verdict === "CONDITIONAL GO") return 1;
  return 0;
}

function chooseWinner(
  primaryRuns: readonly RunResult[],
  metrics: ReadonlyMap<string, Metrics>,
  cheapId: string,
  stability: StabilityStats,
): RunResult {
  return [...primaryRuns].sort((a, b) => {
    const am = metrics.get(a.model.id)!;
    const bm = metrics.get(b.model.id)!;
    const aAssessment = stabilityAssessmentFor(a.model.id, cheapId, stability);
    const bAssessment = stabilityAssessmentFor(b.model.id, cheapId, stability);
    const aVerdict = verdictFor(am, aAssessment).verdict;
    const bVerdict = verdictFor(bm, bAssessment).verdict;
    const aRecall = a.model.id === cheapId ? stability.worstRecallA : am.recallA;
    const bRecall = b.model.id === cheapId ? stability.worstRecallA : bm.recallA;
    const aPrecision = a.model.id === cheapId ? stability.worstPrecisionA : am.precisionA;
    const bPrecision = b.model.id === cheapId ? stability.worstPrecisionA : bm.precisionA;
    return (
      verdictRank(bVerdict) - verdictRank(aVerdict) ||
      bRecall - aRecall ||
      bPrecision - aPrecision ||
      bm.f1A - am.f1A ||
      a.costUsd - b.costUsd
    );
  })[0]!;
}

function verdictFor(
  metrics: Metrics,
  stability: StabilityAssessment,
): { verdict: VerdictName; reason: string } {
  if (metrics.tpA === 4 && metrics.fpA <= 4) {
    if (stability === "passed") {
      if (POLICY_MODE) {
        return {
          verdict: "CONDITIONAL GO",
          reason:
            "Metryki spełniają próg GO, ale polityka powstała po analizie błędów na tym samym zbiorze. Ten przebieg jest regresją, nie niezależnym benchmarkiem; formalne GO wymaga świeżego holdoutu.",
        };
      }
      return {
        verdict: "GO",
        reason:
          "Kandydat wykrył wszystkie cztery alarmy, miał najwyżej cztery false positives w każdym z trzech przebiegów i ani razu nie pominął gold A. To zgoda wyłącznie na kolejny, kontrolowany etap walidacji — nie na produkcyjne alerty.",
      };
    }
    return {
      verdict: "CONDITIONAL GO",
      reason: stability === "failed"
        ? "Pierwszy przebieg wykrył wszystkie alarmy przy akceptowalnej liczbie false positives, ale test stabilności ujawnił pominięcie gold A albo nadmiar false positives. Potrzebna jest dalsza walidacja bez uruchamiania alertów produkcyjnych."
        : "Pojedynczy przebieg wykrył wszystkie alarmy przy akceptowalnej liczbie false positives, ale stabilność tego modelu nie została zmierzona. Potrzebne są powtórzenia przed automatycznymi alertami.",
    };
  }
  if (metrics.tpA >= 3 && metrics.fpA <= 8) {
    return {
      verdict: "CONDITIONAL GO",
      reason:
        "Wynik jest obiecujący, ale obejmuje co najmniej jedno przeoczenie albo 5–8 false positives. Potrzeba większego, zamrożonego zbioru i kolejnych prób przed automatycznymi alertami.",
    };
  }
  return {
    verdict: "NO-GO",
    reason:
      "Kandydat wykrył mniej niż trzy z czterech alarmów albo wygenerował ponad osiem false positives. Nie ma podstaw do dalszej walidacji produkcyjnej klasyfikatora.",
  };
}

function buildReport(args: {
  runAt: Date;
  datasetHash: string;
  labelsHash: string;
  labels: Record<string, z.infer<typeof LabelSchema>>;
  primaryRuns: readonly RunResult[];
  cheapRuns: readonly RunResult[];
}): string {
  const metricsByModel = new Map(
    args.primaryRuns.map((run) => [run.model.id, calculateMetrics(run, args.labels)]),
  );
  const stability = stabilitySummary(args.cheapRuns, args.labels);
  const cheapId = args.cheapRuns[0]!.model.id;
  const winner = chooseWinner(args.primaryRuns, metricsByModel, cheapId, stability);
  const winnerMetrics = metricsByModel.get(winner.model.id)!;
  const winnerStability = stabilityAssessmentFor(winner.model.id, cheapId, stability);
  const verdict = verdictFor(winnerMetrics, winnerStability);

  const allRuns = [
    ...args.primaryRuns,
    ...args.cheapRuns.filter((run) => run.runNumber > 1),
  ];
  const totalCost = allRuns.reduce((sum, run) => sum + run.costUsd, 0);
  const policyDecisionCount = args.primaryRuns[0]!.predictions.filter(
    (prediction) => prediction.decidedBy === "business-policy",
  ).length;

  const lines: string[] = [
    POLICY_MODE
      ? "# BHT — BUSINESS POLICY REGRESSION"
      : "# BHT — MODEL BENCHMARK",
    "",
    `Wygenerowano: **${args.runAt.toISOString()}**  `,
    `Prompt: **${CLASSIFIER_PROMPT_VERSION}**  `,
    POLICY_MODE
      ? `Tryb: **regresja po analizie błędów**, nie niezależny benchmark. Polityka: **${ROSSMANN_NEW_ORDER_POLICY_ID}**.`
      : "Tryb: **niezależny benchmark** bez polityk dodanych po analizie wyniku.",
    "Zakres: wyłącznie rola **classify**, zamrożone 50 wiadomości, Claude API (Anthropic).",
    "",
    "## FINAL VERDICT",
    "",
    `# ${verdict.verdict}`,
    "",
    verdict.reason,
    "",
    `**Zwycięzca classify: ${winner.model.name} (${winner.model.id}).**`,
    "",
    "| Model | Recall A | Precision A | FN | FP | Stabilność | 100 msg | 100 msg/dzień/mies. | Werdykt |",
    "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
  ];

  for (const run of args.primaryRuns) {
    const metrics = metricsByModel.get(run.model.id)!;
    const perMessage = run.costUsd / run.predictions.length;
    const stabilityCell =
      run.model.id === cheapId
        ? `${stability.changedMessages}/50 zmieniło klasę; A pominięte w ≥1 przebiegu: ${stability.goldAMissedAtLeastOnce}; max FP: ${stability.maxFalsePositivesA}`
        : "1 przebieg (nie mierzono)";
    const modelVerdict = verdictFor(
      metrics,
      stabilityAssessmentFor(run.model.id, cheapId, stability),
    ).verdict;
    lines.push(
      `| ${run.model.name} | ${pct(metrics.recallA)} | ${pct(metrics.precisionA)} | ${metrics.fnA} | ${metrics.fpA} | ${stabilityCell} | ${usd(perMessage * 100)} | ${usd(perMessage * 3_000)} | ${modelVerdict} |`,
    );
  }

  lines.push(
    "",
    "## Baseline",
    "",
    "Obecny system deterministyczny: **TP A=0, FN A=4, FP A=3, recall A=0%, precision A=0%, accuracy 3-klasowa=68%**.",
    ...(POLICY_MODE
      ? [
          "",
          "Niezależny benchmark v1: **NO-GO**. Sonnet 5: TP A=2, FN A=2, FP A=2, recall A=50%, precision A=50%.",
          "",
          "## Jawna polityka biznesowa",
          "",
          `- każde znormalizowane nowe zamówienie Rossmann → **A**,`,
          `- decyzja właściciela: **${ROSSMANN_NEW_ORDER_POLICY_ID}**,`,
          `- polityka rozstrzygnęła **${policyDecisionCount}/50** wiadomości przed modelem w każdym przebiegu,`,
          "- dopasowanie wymaga kanonicznego customerId, eventType i numeru zamówienia; samo słowo „Rossmann” nie wystarcza,",
          "- produkcyjny monitor nie został zmieniony ani przełączony.",
        ]
      : []),
    "",
    "## Dataset",
    "",
    "- zamrożone rekordy: **50**; bez pobierania nowych maili,",
    "- gold labels właściciela: **A=4, B=18, C=28**,",
    `- SHA-256 zbior.json: \`${args.datasetHash}\`,`,
    `- SHA-256 etykiety.json: \`${args.labelsHash}\`,`,
    "- skrypt odmawia startu, jeśli którykolwiek hash różni się od zatwierdzonego, zamrożonego pliku,",
    POLICY_MODE
      ? `- model otrzymał wyłącznie ${50 - policyDecisionCount} wiadomości nierozstrzygniętych przez politykę: nadawcę, temat, podgląd i datę,`
      : "- model otrzymał wyłącznie: nadawcę, temat, podgląd dostępny w dataset i datę,",
    "- gold labels i pola starego systemu nie były dołączane do żądań API,",
    "- raport nie zawiera surowych tematów, nadawców, podglądów ani uzasadnień modelu; błędy mają tylko anonimowe ID.",
    "",
    "## Modele i ceny",
    "",
    `Cennik sprawdzony **${PRICING_CHECKED_AT}** w oficjalnej dokumentacji Anthropic. Dostępność każdego ID została potwierdzona przez Models API bez wysyłania treści wiadomości.`,
    "",
    "| Model | Rola w benchmarku | ID Claude API | Input / MTok | Output / MTok | Cache read / MTok |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );

  for (const model of CANDIDATES) {
    const price = model.price(args.runAt);
    lines.push(
      `| ${model.name} | ${model.tier} | \`${model.id}\` | ${usd(price.input, 2)} | ${usd(price.output, 2)} | ${usd(price.cacheRead, 2)} |`,
    );
  }

  lines.push(
    "",
    `Źródła: [modele](${MODELS_SOURCE}), [cennik](${PRICING_SOURCE}), [Models API](${MODELS_API_SOURCE}), [structured outputs](${STRUCTURED_OUTPUT_SOURCE}).`,
    "",
    `Uwaga: dla Claude Sonnet 5 oficjalna cena promocyjna $2/$10 za MTok obowiązuje do 31.08.2026; od 01.09.2026 skrypt liczy $3/$15.`,
    "",
    "## Prompt classifier-v1",
    "",
    "```text",
    CLASSIFIER_PROMPT,
    "```",
    "",
    "Każdy model dostał identyczny prompt i ten sam JSON Schema. Parametry próbkowania pozostawiono domyślne, ponieważ Sonnet 5 i Opus 5 odrzucają wartości inne niż domyślne; ich adaptacyjne myślenie wyłączono dla krótkiej klasyfikacji.",
    "",
    "## Wyniki",
  );

  for (const run of args.primaryRuns) {
    const metrics = metricsByModel.get(run.model.id)!;
    lines.push(
      "",
      `### ${run.model.name}`,
      "",
      `TP A: **${metrics.tpA}** · FN A: **${metrics.fnA}** · FP A: **${metrics.fpA}** · recall A: **${pct(metrics.recallA)}** · precision A: **${pct(metrics.precisionA)}** · F1 A: **${pct(metrics.f1A)}** · accuracy: **${pct(metrics.accuracy)}**`,
      "",
      confusionTable(metrics),
      "",
      errorTable("False negatives A", metrics.falseNegativesA, args.labels),
      "",
      errorTable("False positives A", metrics.falsePositivesA, args.labels),
    );
  }

  lines.push(
    "",
    "## Stabilność taniego kandydata",
    "",
    `Model: **${args.cheapRuns[0]!.model.name}**. Trzy pełne przebiegi po 50 wiadomości.`,
    "",
    `- wiadomości, które zmieniły klasę między przebiegami: **${stability.changedMessages}/50**,`,
    `- zmienione przypisania względem pierwszego przebiegu: **${stability.changedAssignments}/100**,`,
    `- gold A pominięte co najmniej raz: **${stability.goldAMissedAtLeastOnce}/4**,`,
    `- najgorszy recall A w trzech przebiegach: **${pct(stability.worstRecallA)}**,`,
    `- najgorsza precision A w trzech przebiegach: **${pct(stability.worstPrecisionA)}**,`,
    `- największa liczba false positives w przebiegu: **${stability.maxFalsePositivesA}**,`,
    `- średni rozrzut confidence: **${stability.averageConfidenceSpread.toFixed(3)}**,`,
    `- maksymalny rozrzut confidence: **${stability.maxConfidenceSpread.toFixed(3)}**.`,
    "",
    "## Koszt classify — realne tokeny API",
    "",
    "| Model / przebieg | Input | Cache write | Cache read | Output | Koszt przebiegu | Średnio / msg | 100 msg | 100 msg/dzień × 30 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const run of allRuns) {
    const perMessage = run.costUsd / run.predictions.length;
    lines.push(
      `| ${run.model.name} #${run.runNumber} | ${run.usage.input} | ${run.usage.cacheWrite} | ${run.usage.cacheRead} | ${run.usage.output} | ${usd(run.costUsd, 6)} | ${usd(perMessage, 6)} | ${usd(perMessage * 100)} | ${usd(perMessage * 3_000)} |`,
    );
  }

  lines.push(
    "",
    `**Cały benchmark, wraz z dwoma dodatkowymi przebiegami stabilności: ${usd(totalCost, 6)}.**`,
    "",
    "Koszt docelowy oznacza: jedna nowa wiadomość → jedna klasyfikacja. Nie obejmuje ponownego skanowania skrzynki ani TeaBrew.",
    "",
    "## Rekomendacja",
    "",
    `**${verdict.verdict}: ${winner.model.name}** jest najlepszym kandydatem według kolejności: werdykt, najgorszy zmierzony recall A, precision A, F1 A, a następnie koszt.`,
    "",
    verdict.reason,
    "",
    "Progi: GO wymaga TP A=4, FP A≤4 oraz trzech stabilnych przebiegów bez pominięcia A i bez przekroczenia FP. CONDITIONAL GO wymaga TP A≥3 i FP A≤8; model bez testu stabilności nie może otrzymać GO.",
    ...(POLICY_MODE
      ? [
          "",
          "Ponieważ politykę ustalono po obejrzeniu false negatives, ten raport może dać najwyżej CONDITIONAL GO. Następna bramka to świeży, prospektywny holdout.",
        ]
      : []),
    "",
    "Benchmark nie przełączył produkcyjnego classifiera, nie wysłał pushy i nie zmienił BHT Copilot, TeaBrew, Railway ani Czat Firmowy.",
    "",
  );

  return lines.join("\n");
}

function writeReport(report: string): void {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const temporary = `${REPORT_PATH}.tmp`;
  writeFileSync(temporary, report, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, REPORT_PATH);
}

async function main(): Promise<void> {
  const requestedPolicy = process.argv.find((arg) => arg.startsWith("--policy="));
  if (requestedPolicy && requestedPolicy !== "--policy=rossmann-v1") {
    stop(`nieznany tryb polityki: ${requestedPolicy}.`);
  }
  const runAt = new Date();
  const frozen = parseFrozenData();
  const apiKey = parseApiKey();
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });

  await ensureModelsAvailable(client);

  const primaryRuns: RunResult[] = [];
  for (const candidate of CANDIDATES) {
    primaryRuns.push(await runModel(client, candidate, frozen.dataset, 1, runAt));
  }

  const cheap = CANDIDATES.find((candidate) => candidate.tier === "tani");
  if (!cheap) stop("brakuje taniego kandydata do testu stabilności.");
  const cheapPrimary = primaryRuns.find((run) => run.model.id === cheap.id)!;
  const cheapRuns = [
    cheapPrimary,
    await runModel(client, cheap, frozen.dataset, 2, runAt),
    await runModel(client, cheap, frozen.dataset, 3, runAt),
  ];

  const report = buildReport({
    runAt,
    datasetHash: frozen.datasetHash,
    labelsHash: frozen.labelsHash,
    labels: frozen.labels,
    primaryRuns,
    cheapRuns,
  });
  writeReport(report);
  process.stdout.write(`\nGotowe. Raport zapisano w ${REPORT_PATH}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`STOP: benchmark przerwany (${safeError(error)}). Raport nie został zapisany.\n`);
  process.exitCode = 1;
});
