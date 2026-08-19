import { CapabilityError } from "../capability/types.js";
import {
  MarketingTasksResponse,
  type MarketingTasksData,
  type MarketingTaskView,
} from "./contract.js";

export interface MarketingTaskQuery {
  view: MarketingTaskView;
  dueFrom?: string;
  dueTo?: string;
  limit: number;
  signal?: AbortSignal;
}

export interface MarketingPlannerReader {
  listTasks(args: MarketingTaskQuery): Promise<MarketingTasksData>;
}

export interface MarketingPlannerHttpConfig {
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

export class HttpMarketingPlannerReader implements MarketingPlannerReader {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(private readonly config: MarketingPlannerHttpConfig) {
    try {
      this.baseUrl = new URL(config.baseUrl);
    } catch (error) {
      throw new CapabilityError(
        "not_configured",
        "MARKETING_PLANNER_BASE_URL nie jest adresem URL",
        error,
      );
    }
    if (
      this.baseUrl.protocol !== "https:" ||
      this.baseUrl.username ||
      this.baseUrl.password
    ) {
      throw new CapabilityError(
        "not_configured",
        "MARKETING_PLANNER_BASE_URL musi używać HTTPS",
      );
    }
    if (config.token.trim().length < 32) {
      throw new CapabilityError(
        "not_configured",
        "MARKETING_PLANNER_TOKEN musi mieć co najmniej 32 znaki",
      );
    }
    this.timeoutMs = config.timeoutMs ?? 12_000;
  }

  async listTasks(args: MarketingTaskQuery): Promise<MarketingTasksData> {
    const url = new URL("/api/copilot/tasks", this.baseUrl.origin);
    url.searchParams.set("view", args.view);
    url.searchParams.set("today", warsawDay());
    url.searchParams.set("limit", String(args.limit));
    if (args.dueFrom) url.searchParams.set("dueFrom", args.dueFrom);
    if (args.dueTo) url.searchParams.set("dueTo", args.dueTo);
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
      const timeoutError =
        (error as Error)?.name === "AbortError" ||
        (error as Error)?.name === "TimeoutError";
      throw new CapabilityError(
        timeoutError ? "timeout" : "upstream_unavailable",
        timeoutError
          ? "Planer Marketingowy nie odpowiedział na czas"
          : "Nie udało się połączyć z Planerem Marketingowym",
        error,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new CapabilityError(
        "auth_failed",
        "Planer Marketingowy odrzucił token Copilota",
      );
    }
    if (!response.ok) {
      throw new CapabilityError(
        "upstream_error",
        `Planer Marketingowy zwrócił HTTP ${response.status}`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CapabilityError(
        "upstream_error",
        "Planer Marketingowy zwrócił odpowiedź nie-JSON",
        error,
      );
    }
    const parsed = MarketingTasksResponse.safeParse(json);
    if (!parsed.success) {
      throw new CapabilityError(
        "invalid_output",
        `Odpowiedź Planera nie zgadza się z kontraktem: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data.data;
  }
}

export class UnavailableMarketingPlannerReader
  implements MarketingPlannerReader
{
  async listTasks(): Promise<never> {
    throw new CapabilityError(
      "not_configured",
      "Planer Marketingowy nie jest podłączony",
    );
  }
}
