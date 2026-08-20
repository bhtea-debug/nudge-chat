import { readFileSync } from "node:fs";
import { z } from "zod";
import { CapabilityError } from "../capability/types.js";
import {
  CONTRACT_VERSION,
  CustomerCaseMessagesResponse,
  CustomerCaseResponse,
  CustomerCasesResponse,
  CustomerCaseSearchResponse,
  HealthResponse,
  OrderResponse,
  ProductSearchResponse,
  ProductionResponse,
  ROUTES,
  SalesSummaryResponse,
  StockResponse,
} from "./contract.js";

/**
 * Czytnik danych operacyjnych. Interfejs, nie klasa — dzięki temu agent
 * i capability nie wiedzą, czy po drugiej stronie jest HTTP, czy plik z fiksturą.
 *
 * Nie ma tu ani jednej metody zapisu. Agent nie może zmienić statusu, ceny,
 * stanu magazynu ani utworzyć zamówienia, bo nie ma czym.
 */
export interface TeabrewReader {
  readonly id: string;
  getOrder(args: { query: string; limit: number; signal?: AbortSignal }): Promise<z.infer<typeof OrderResponse>["data"]>;
  getSalesSummary(args: {
    from: string;
    to: string;
    sources: readonly ("medusa" | "allegro")[];
    topLimit: number;
    signal?: AbortSignal;
  }): Promise<z.infer<typeof SalesSummaryResponse>["data"]>;
  getStock(args: {
    codes: readonly string[];
    profile: "finished_goods" | "all_locations";
    signal?: AbortSignal;
  }): Promise<z.infer<typeof StockResponse>["data"]>;
  searchProducts(args: { query: string; limit: number; signal?: AbortSignal }): Promise<z.infer<typeof ProductSearchResponse>["data"]>;
  getProduction(args: {
    limit: number;
    status?: string;
    signal?: AbortSignal;
  }): Promise<z.infer<typeof ProductionResponse>["data"]>;
  listCustomerCases(args: {
    state: "new" | "open" | "all";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }): Promise<z.infer<typeof CustomerCasesResponse>["data"]>;
  getCustomerCase(args: {
    id: string;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }): Promise<z.infer<typeof CustomerCaseResponse>["data"]>;
  getCustomerCaseMessages(args: {
    id: string;
    limit: number;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }): Promise<z.infer<typeof CustomerCaseMessagesResponse>["data"]>;
  searchCustomerCases(args: {
    query: string;
    by: "order" | "buyer";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }): Promise<z.infer<typeof CustomerCaseSearchResponse>["data"]>;
  health(args?: { signal?: AbortSignal }): Promise<z.infer<typeof HealthResponse>["data"]>;
}

export interface HttpReaderConfig {
  /** Baza HTTP actions Convex, bez końcowego ukośnika. */
  readonly baseUrl: string;
  /** Token wyłącznie dla tego agenta. Nigdy w URL — tylko nagłówek Authorization. */
  readonly token: string;
  readonly timeoutMs?: number;
}

export class HttpTeabrewReader implements TeabrewReader {
  readonly id = "teabrew-http";
  private readonly timeoutMs: number;

  constructor(private readonly cfg: HttpReaderConfig) {
    if (!cfg.baseUrl) {
      throw new CapabilityError("not_configured", "brak TEABREW_BASE_URL");
    }
    if (!cfg.token) {
      throw new CapabilityError("not_configured", "brak TEABREW_AI_OPERATOR_TOKEN");
    }
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  async getOrder(args: { query: string; limit: number; signal?: AbortSignal }) {
    return (
      await this.get(OrderResponse, ROUTES.order, { ref: args.query, limit: String(args.limit) }, args.signal)
    ).data;
  }

  async getSalesSummary(args: {
    from: string;
    to: string;
    sources: readonly ("medusa" | "allegro")[];
    topLimit: number;
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        SalesSummaryResponse,
        ROUTES.salesSummary,
        {
          from: args.from,
          to: args.to,
          sources: args.sources.join(","),
          topLimit: String(args.topLimit),
        },
        args.signal,
      )
    ).data;
  }

  async getStock(args: {
    codes: readonly string[];
    profile: "finished_goods" | "all_locations";
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        StockResponse,
        ROUTES.stock,
        { codes: args.codes.join(","), profile: args.profile },
        args.signal,
      )
    ).data;
  }

  async searchProducts(args: { query: string; limit: number; signal?: AbortSignal }) {
    return (
      await this.get(
        ProductSearchResponse,
        ROUTES.productSearch,
        { query: args.query, limit: String(args.limit) },
        args.signal,
      )
    ).data;
  }

  async getProduction(args: { limit: number; status?: string; signal?: AbortSignal }) {
    return (
      await this.get(
        ProductionResponse,
        ROUTES.production,
        { limit: String(args.limit), ...(args.status ? { status: args.status } : {}) },
        args.signal,
      )
    ).data;
  }

  async listCustomerCases(args: {
    state: "new" | "open" | "all";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        CustomerCasesResponse,
        ROUTES.customerCases,
        {
          state: args.state,
          limit: String(args.limit),
          includeContent: String(args.includeContent),
          contentMode: args.contentMode,
        },
        args.signal,
      )
    ).data;
  }

  async getCustomerCase(args: {
    id: string;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        CustomerCaseResponse,
        ROUTES.customerCase,
        {
          id: args.id,
          includeContent: String(args.includeContent),
          contentMode: args.contentMode,
        },
        args.signal,
      )
    ).data;
  }

  async getCustomerCaseMessages(args: {
    id: string;
    limit: number;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        CustomerCaseMessagesResponse,
        ROUTES.customerCaseMessages,
        { id: args.id, limit: String(args.limit), contentMode: args.contentMode },
        args.signal,
      )
    ).data;
  }

  async searchCustomerCases(args: {
    query: string;
    by: "order" | "buyer";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
    signal?: AbortSignal;
  }) {
    return (
      await this.get(
        CustomerCaseSearchResponse,
        ROUTES.customerCaseSearch,
        {
          query: args.query,
          by: args.by,
          limit: String(args.limit),
          includeContent: String(args.includeContent),
          contentMode: args.contentMode,
        },
        args.signal,
      )
    ).data;
  }

  async health(args?: { signal?: AbortSignal }) {
    return (await this.get(HealthResponse, ROUTES.health, {}, args?.signal)).data;
  }

  private async get<T extends z.ZodType>(
    schema: T,
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          // Token w nagłówku, nigdy w query stringu — URL-e trafiają do logów.
          authorization: `Bearer ${this.cfg.token}`,
          accept: "application/json",
        },
        signal: combined,
      });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError";
      throw new CapabilityError(
        aborted ? "timeout" : "upstream_unavailable",
        aborted
          ? `TeaBrew nie odpowiedział w ${this.timeoutMs} ms (${path})`
          : `nie udało się połączyć z TeaBrew (${path})`,
        err,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new CapabilityError(
        "forbidden_scope",
        `TeaBrew odrzucił token agenta (${res.status}) na ${path}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new CapabilityError(
        "upstream_error",
        `TeaBrew ograniczył odczyt (HTTP 429) na ${path}; spróbuj ponownie${retryAfter ? ` za ${retryAfter} s` : " później"}`,
      );
    }
    if (!res.ok) {
      throw new CapabilityError(
        "upstream_error",
        `TeaBrew zwrócił HTTP ${res.status} na ${path}`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new CapabilityError("upstream_error", `TeaBrew zwrócił odpowiedź nie-JSON na ${path}`, err);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // Nieznany kształt odpowiedzi to błąd, nie zaproszenie do interpretacji.
      // Lepiej powiedzieć „nie udało się sprawdzić" niż zgadywać z połowy pól.
      throw new CapabilityError(
        "upstream_error",
        `odpowiedź TeaBrew nie zgadza się z kontraktem ${CONTRACT_VERSION} (${path}): ` +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  }
}

/**
 * Czytnik na fiksturach. Ten sam kontrakt, dane z plików JSON.
 * Pozwala uruchomić i przetestować całą ścieżkę poczta -> AI -> TeaBrew
 * bez tokenu produkcyjnego.
 */
export class FixtureTeabrewReader implements TeabrewReader {
  readonly id = "teabrew-fixture";
  private readonly data: FixtureData;

  constructor(input: { filePath?: string; data?: FixtureDataInput }) {
    const raw = input.filePath
      ? JSON.parse(readFileSync(input.filePath, "utf8"))
      : (input.data ?? {});
    this.data = FixtureSchema.parse(resolveRelativeTimestamps(raw));
  }

  async health() {
    return { contractId: "teabrew.ai-operator.read.v1" as const, readOnly: true as const };
  }

  async getOrder(args: { query: string; limit: number }) {
    const q = args.query.trim().toLowerCase();
    const matchers: {
      by: "externalOrderId" | "nexoZkNumber" | "productionOrderNumber" | "id";
      hit: (o: FixtureData["orders"][number]) => boolean;
    }[] = [
      { by: "externalOrderId", hit: (o) => (o.externalOrderId ?? "").toLowerCase() === q },
      { by: "nexoZkNumber", hit: (o) => (o.nexoZkNumber ?? "").toLowerCase() === q },
      {
        by: "productionOrderNumber",
        hit: (o) => o.production.some((p) => p.number.toLowerCase() === q),
      },
      { by: "id", hit: (o) => o.id.toLowerCase() === q },
    ];

    for (const m of matchers) {
      const hits = this.data.orders.filter(m.hit).slice(0, args.limit);
      if (hits.length > 0) {
        return { matchedBy: m.by, query: args.query, count: hits.length, orders: hits };
      }
    }
    return { matchedBy: "none" as const, query: args.query, count: 0, orders: [] };
  }

  async getSalesSummary(args: {
    from: string;
    to: string;
    sources: readonly ("medusa" | "allegro")[];
  }) {
    const saved = this.data.salesSummaries.find(
      (summary) => summary.from === args.from && summary.to === args.to,
    );
    if (saved) return saved;
    return {
      from: args.from,
      to: args.to,
      timezone: "Europe/Warsaw" as const,
      definition: {
        included: "opłacone zamówienia, według daty złożenia",
        excluded: "anulowane i nieopłacone; zwroty nie są odejmowane",
      },
      orderCount: 0,
      grossSalesPLN: 0,
      unitsSold: 0,
      averageOrderPLN: 0,
      channels: args.sources.map((source) => ({
        source,
        orderCount: 0,
        grossSalesPLN: 0,
        unitsSold: 0,
      })),
      daily: [],
      topProducts: [],
      productsTruncated: false,
      dataQuality: { unmappedLines: 0, ordersWithoutTotal: 0 },
    };
  }

  async getStock(args: { codes: readonly string[]; profile: "finished_goods" | "all_locations" }) {
    const wanted = args.codes.map((c) => c.trim()).filter(Boolean);
    const items = wanted
      .map((code) => this.data.stock.find((s) => s.code.toLowerCase() === code.toLowerCase()))
      .filter((s): s is FixtureData["stock"][number] => Boolean(s));
    const found = new Set(items.map((i) => i.code.toLowerCase()));
    return {
      profile: args.profile,
      count: items.length,
      items,
      unknownCodes: wanted.filter((c) => !found.has(c.toLowerCase())),
    };
  }

  async searchProducts(args: { query: string; limit: number }) {
    const q = args.query.trim().toLowerCase();
    const matches = (code: string, name: string): boolean =>
      code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    const skus = this.data.skus.filter((s) => matches(s.code, s.name));
    const materials = this.data.materials.filter((m) => matches(m.code, m.name));
    const total = skus.length + materials.length;
    return {
      query: args.query,
      skus: skus.slice(0, args.limit),
      materials: materials.slice(0, args.limit),
      totalCount: total,
      truncated: skus.length > args.limit || materials.length > args.limit,
    };
  }

  async getProduction(args: { limit: number; status?: string }) {
    const orders = this.data.production.filter((p) =>
      args.status ? p.status === args.status : true,
    );
    const countByStatus: Record<string, number> = {};
    for (const o of this.data.production) {
      countByStatus[o.status] = (countByStatus[o.status] ?? 0) + 1;
    }
    return {
      countByStatus,
      orders: orders.slice(0, args.limit),
      activeRuns: this.data.activeRuns,
      truncated: orders.length > args.limit,
    };
  }

  async listCustomerCases(args: {
    state: "new" | "open" | "all";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
  }) {
    const matching = this.data.customerCases
      .filter((customerCase) => {
        if (args.state === "all") return true;
        if (args.state === "new") {
          return customerCase.status.toLowerCase() === "new" || !customerCase.isRead;
        }
        return customerCaseIsOpen(customerCase.status);
      })
      .sort(compareCustomerCases);
    const cases = matching
      .slice(0, args.limit)
      .map((customerCase) => presentFixtureCase(customerCase, args.includeContent, args.contentMode));
    return {
      freshness: this.data.customerCasesFreshness,
      cases,
      count: cases.length,
      truncated: matching.length > args.limit,
      contentIncluded: args.includeContent,
      contentMode: args.includeContent ? args.contentMode : ("none" as const),
    };
  }

  async getCustomerCase(args: {
    id: string;
    includeContent: boolean;
    contentMode: "display" | "model";
  }) {
    const found = this.data.customerCases.find((customerCase) => customerCase.id === args.id);
    return {
      freshness: this.data.customerCasesFreshness,
      found: Boolean(found),
      case: found ? presentFixtureCase(found, args.includeContent, args.contentMode) : null,
      contentIncluded: args.includeContent,
      contentMode: args.includeContent ? args.contentMode : ("none" as const),
    };
  }

  async getCustomerCaseMessages(args: {
    id: string;
    limit: number;
    contentMode: "display" | "model";
  }) {
    const matching = this.data.customerCaseMessages
      .filter((message) => message.caseId === args.id)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const selected = matching.slice(Math.max(0, matching.length - args.limit));
    const messages = selected.map(({ caseId: _caseId, ...message }) =>
      args.contentMode === "model"
        ? {
            ...message,
            authorLogin: null,
            text: redactCustomerText(message.text),
            subject: redactCustomerText(message.subject),
            attachments: [],
          }
        : message,
    );
    return {
      freshness: this.data.customerCasesFreshness,
      caseId: args.id,
      messages,
      count: messages.length,
      truncated: matching.length > args.limit,
      contentIncluded: true,
      contentMode: args.contentMode,
      attachmentsExcluded: true as const,
    };
  }

  async searchCustomerCases(args: {
    query: string;
    by: "order" | "buyer";
    limit: number;
    includeContent: boolean;
    contentMode: "display" | "model";
  }) {
    const query = args.query.trim().toLowerCase();
    const matching = this.data.customerCases
      .filter((customerCase) =>
        args.by === "order"
          ? (customerCase.orderId ?? "").toLowerCase().includes(query)
          : (customerCase.buyerLogin ?? "").toLowerCase().includes(query),
      )
      .sort(compareCustomerCases);
    const cases = matching
      .slice(0, args.limit)
      .map((customerCase) => presentFixtureCase(customerCase, args.includeContent, args.contentMode));
    return {
      freshness: this.data.customerCasesFreshness,
      cases,
      count: cases.length,
      truncated: matching.length > args.limit,
      contentIncluded: args.includeContent,
      contentMode: args.includeContent ? args.contentMode : ("none" as const),
    };
  }
}

const FixtureSchema = z.object({
  orders: z.array(OrderResponse.shape.data.shape.orders.element).default([]),
  stock: z.array(StockResponse.shape.data.shape.items.element).default([]),
  skus: z.array(ProductSearchResponse.shape.data.shape.skus.element).default([]),
  materials: z.array(ProductSearchResponse.shape.data.shape.materials.element).default([]),
  production: z.array(ProductionResponse.shape.data.shape.orders.element).default([]),
  activeRuns: z.array(ProductionResponse.shape.data.shape.activeRuns.element).default([]),
  salesSummaries: z.array(SalesSummaryResponse.shape.data).default([]),
  customerCases: z.array(CustomerCasesResponse.shape.data.shape.cases.element).default([]),
  customerCaseMessages: z
    .array(CustomerCaseMessagesResponse.shape.data.shape.messages.element.extend({ caseId: z.string() }))
    .default([]),
  customerCasesFreshness: CustomerCasesResponse.shape.data.shape.freshness.default({
    status: "ready",
    lastSuccessfulSyncAt: null,
    nextAttemptAt: null,
    ageMs: null,
    stale: false,
    scopeState: "ready",
    message: null,
  }),
});

type FixtureData = z.infer<typeof FixtureSchema>;
export type FixtureDataInput = z.input<typeof FixtureSchema>;

function customerCaseIsOpen(status: string): boolean {
  return !["closed", "resolved", "ended", "finished"].includes(status.toLowerCase());
}

function compareCustomerCases(
  left: FixtureData["customerCases"][number],
  right: FixtureData["customerCases"][number],
): number {
  const priorityRank = { P0: 0, P1: 1, P2: 2 } as const;
  const leftRank = left.priority ? priorityRank[left.priority] : 3;
  const rightRank = right.priority ? priorityRank[right.priority] : 3;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftDeadline = left.responseDueAt ?? Number.POSITIVE_INFINITY;
  const rightDeadline = right.responseDueAt ?? Number.POSITIVE_INFINITY;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  return (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0);
}

function presentFixtureCase(
  customerCase: FixtureData["customerCases"][number],
  includeContent: boolean,
  contentMode: "display" | "model",
): FixtureData["customerCases"][number] {
  if (!includeContent) {
    return {
      ...customerCase,
      buyerLogin: null,
      offerName: null,
      subject: null,
      lastMessagePreview: null,
    };
  }
  if (contentMode === "display") return customerCase;
  return {
    ...customerCase,
    buyerLogin: null,
    subject: redactCustomerText(customerCase.subject),
    lastMessagePreview: redactCustomerText(customerCase.lastMessagePreview),
  };
}

function redactCustomerText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?48[\s.-]?)?(?:\d[\s.-]?){9}\b/g, "[telefon]")
    .replace(/\b\d{2}-\d{3}\b/g, "[kod pocztowy]")
    .replace(/\b\d{11}\b/g, "[identyfikator]");
}

/**
 * Fikstury ERP zapisują znaczniki czasu względnie: "{{+2d}}", "{{-1d}}", "{{-4h}}".
 * Terminy zamówień muszą wypadać w przyszłości niezależnie od dnia uruchomienia,
 * inaczej demo po tygodniu pokazuje wyłącznie przekroczone deadline'y.
 */
const RELATIVE_TS = /^\{\{([+-])(\d+)([mhd])\}\}$/;

function resolveRelativeTimestamps(value: unknown, now: number = Date.now()): unknown {
  if (typeof value === "string") {
    const m = RELATIVE_TS.exec(value.trim());
    if (!m) return value;
    const unitMs = m[3] === "m" ? 60_000 : m[3] === "h" ? 3_600_000 : 86_400_000;
    const delta = Number(m[2]) * unitMs;
    return m[1] === "+" ? now + delta : now - delta;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRelativeTimestamps(v, now));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveRelativeTimestamps(v, now),
      ]),
    );
  }
  return value;
}
