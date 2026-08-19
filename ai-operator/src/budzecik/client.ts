import { CapabilityError } from "../capability/types.js";
import {
  BudzecikResponse,
  type BudzecikData,
  type BudzecikResource,
} from "./contract.js";

export interface BudzecikReadQuery {
  resource: BudzecikResource;
  from?: string;
  to?: string;
  month?: string;
  query?: string;
  status?: string;
  direction?: "inflow" | "outflow";
  budgetId?: string;
  channel?: string;
  view?: "all" | "unpaid" | "overdue" | "paid" | "cashflow";
  limit?: number;
  signal?: AbortSignal;
}

export interface BudzecikReader {
  read(args: BudzecikReadQuery): Promise<BudzecikData>;
}

export interface BudzecikHttpConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

function warsawDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export class HttpBudzecikReader implements BudzecikReader {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(private readonly config: BudzecikHttpConfig) {
    try {
      this.baseUrl = new URL(config.baseUrl);
    } catch (error) {
      throw new CapabilityError("not_configured", "BUDZECIK_BASE_URL nie jest adresem URL", error);
    }
    if (this.baseUrl.protocol !== "https:" || this.baseUrl.username || this.baseUrl.password) {
      throw new CapabilityError("not_configured", "BUDZECIK_BASE_URL musi używać HTTPS");
    }
    if (config.token.trim().length < 32) {
      throw new CapabilityError("not_configured", "BUDZECIK_COPILOT_TOKEN musi mieć co najmniej 32 znaki");
    }
    this.timeoutMs = config.timeoutMs ?? 12_000;
  }

  async read(args: BudzecikReadQuery): Promise<BudzecikData> {
    const url = new URL("/copilot/read", this.baseUrl.origin);
    url.searchParams.set("resource", args.resource);
    url.searchParams.set("today", warsawDay());
    for (const [key, value] of Object.entries({
      from: args.from,
      to: args.to,
      month: args.month,
      query: args.query,
      status: args.status,
      direction: args.direction,
      budgetId: args.budgetId,
      channel: args.channel,
      view: args.view,
      limit: args.limit,
    })) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/json",
        },
        redirect: "error",
        signal,
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === "AbortError" || (error as Error)?.name === "TimeoutError";
      throw new CapabilityError(
        timedOut ? "timeout" : "upstream_unavailable",
        timedOut ? "Budżecik nie odpowiedział na czas" : "Nie udało się połączyć z Budżecikiem",
        error,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new CapabilityError("auth_failed", "Budżecik odrzucił token Copilota");
    }
    if (!response.ok) {
      throw new CapabilityError("upstream_error", `Budżecik zwrócił HTTP ${response.status}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CapabilityError("upstream_error", "Budżecik zwrócił odpowiedź nie-JSON", error);
    }
    const parsed = BudzecikResponse.safeParse(json);
    if (!parsed.success) {
      throw new CapabilityError(
        "invalid_output",
        `Odpowiedź Budżecika nie zgadza się z kontraktem: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data.data;
  }
}

export class UnavailableBudzecikReader implements BudzecikReader {
  async read(): Promise<never> {
    throw new CapabilityError("not_configured", "Budżecik nie jest podłączony");
  }
}
