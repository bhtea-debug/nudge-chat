import { CapabilityError } from "../capability/types.js";
import {
  MarketingCampaignsResponse,
  MarketingScheduleResponse,
  MarketingTasksResponse,
  type MarketingCampaignsData,
  type MarketingCampaignView,
  type MarketingScheduleData,
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

export interface MarketingScheduleQuery {
  from: string;
  to: string;
  limit: number;
  signal?: AbortSignal;
}

export interface MarketingCampaignQuery {
  view: MarketingCampaignView;
  limit: number;
  signal?: AbortSignal;
}

export interface MarketingPlannerReader {
  listTasks(args: MarketingTaskQuery): Promise<MarketingTasksData>;
  getSchedule(args: MarketingScheduleQuery): Promise<MarketingScheduleData>;
  listCampaigns(args: MarketingCampaignQuery): Promise<MarketingCampaignsData>;
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
    const json = await this.readJson(url, args.signal);
    const parsed = MarketingTasksResponse.safeParse(json);
    if (!parsed.success) this.invalidOutput(parsed.error.issues);
    return parsed.data.data;
  }

  async getSchedule(args: MarketingScheduleQuery): Promise<MarketingScheduleData> {
    const url = new URL("/api/copilot/marketing", this.baseUrl.origin);
    url.searchParams.set("mode", "schedule");
    url.searchParams.set("today", warsawDay());
    url.searchParams.set("from", args.from);
    url.searchParams.set("to", args.to);
    url.searchParams.set("limit", String(args.limit));
    const json = await this.readJson(url, args.signal);
    const parsed = MarketingScheduleResponse.safeParse(json);
    if (!parsed.success) this.invalidOutput(parsed.error.issues);
    return parsed.data.data;
  }

  async listCampaigns(args: MarketingCampaignQuery): Promise<MarketingCampaignsData> {
    const url = new URL("/api/copilot/marketing", this.baseUrl.origin);
    url.searchParams.set("mode", "campaigns");
    url.searchParams.set("today", warsawDay());
    url.searchParams.set("view", args.view);
    url.searchParams.set("limit", String(args.limit));
    const json = await this.readJson(url, args.signal);
    const parsed = MarketingCampaignsResponse.safeParse(json);
    if (!parsed.success) this.invalidOutput(parsed.error.issues);
    return parsed.data.data;
  }

  private async readJson(url: URL, callerSignal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

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
    return json;
  }

  private invalidOutput(
    issues: readonly { path: PropertyKey[]; message: string }[],
  ): never {
    throw new CapabilityError(
      "invalid_output",
      `Odpowiedź Planera nie zgadza się z kontraktem: ${issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
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

  async getSchedule(): Promise<never> {
    return this.listTasks();
  }

  async listCampaigns(): Promise<never> {
    return this.listTasks();
  }
}
