import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";

/**
 * Warstwa modeli oparta na ROLACH, nie na nazwach modeli.
 *
 * W żadnym miejscu logiki agenta nie występuje identyfikator modelu. Zmiana
 * dostawcy albo wersji to zmiana jednej zmiennej środowiskowej.
 *
 * Dwie role wystarczają na MVP:
 *  - "fast"   — klasyfikacja i etykietowanie wielu wiadomości,
 *  - "reason" — łączenie poczty z danymi operacyjnymi i pisanie odpowiedzi.
 *
 * Roli "deep", "vision" i "embeddings" celowo tu nie ma: nic w tym MVP ich
 * nie potrzebuje, a rola bez wywołania to martwy kod.
 */
export type ModelRole = "fast" | "reason";

export interface RoleProfile {
  readonly model: string;
  readonly maxTokens: number;
  /**
   * Rozszerzone myślenie. Adaptive jest domyślnie włączone na modelach 4.6+,
   * a parametry samplingu (temperature/top_p/top_k) są na nich odrzucane —
   * dlatego ta warstwa świadomie nie wystawia żadnego z nich.
   */
  readonly thinking?: { readonly type: "adaptive" };
}

export class ModelLayer {
  private readonly client: Anthropic;
  private readonly profiles: Record<ModelRole, RoleProfile>;

  constructor(cfg: AppConfig) {
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    this.profiles = {
      fast: { model: cfg.models.fast, maxTokens: 2_048 },
      reason: { model: cfg.models.reason, maxTokens: 8_192, thinking: { type: "adaptive" } },
    };
  }

  raw(): Anthropic {
    return this.client;
  }

  profile(role: ModelRole): RoleProfile {
    return this.profiles[role];
  }

  /** Jednorazowe zapytanie bez narzędzi — używane przez triage. */
  async complete(args: {
    role: ModelRole;
    system: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const p = this.profile(args.role);
    const res = await this.client.messages.create(
      {
        model: p.model,
        max_tokens: p.maxTokens,
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
        ...(p.thinking ? { thinking: p.thinking } : {}),
      },
      args.signal ? { signal: args.signal } : {},
    );
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
}
