import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { CapabilityError } from "../capability/types.js";

/**
 * Warstwa modeli oparta na ROLACH, nie na nazwach modeli.
 *
 * W żadnym miejscu logiki agenta nie występuje identyfikator modelu. Zmiana
 * dostawcy albo wersji to zmiana jednej zmiennej środowiskowej.
 *
 *  - "classify" — klasyfikacja i etykietowanie wielu wiadomości,
 *  - "chat"     — krótka odpowiedź użytkownikowi w Czat Firmowy,
 *  - "reason"   — łączenie źródeł i decyzje wymagające głębszego rozumowania.
 *
 * Roli "deep", "vision" i "embeddings" celowo tu nie ma: nic w tym MVP ich
 * nie potrzebuje, a rola bez wywołania to martwy kod.
 */
export type ModelRole = "classify" | "chat" | "reason";

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
    // Sprawdzane tutaj, a nie przy wczytywaniu konfiguracji: klucz jest
    // potrzebny wyłącznie wtedy, gdy MY wołamy model. W trybie MCP modelem jest
    // Claude po stronie klienta, więc wymaganie klucza blokowałoby start bez powodu.
    if (!cfg.anthropicApiKey) {
      throw new CapabilityError(
        "not_configured",
        "brak ANTHROPIC_API_KEY — jest wymagany tylko dla `ask` i `triage`, " +
          "które wołają model po naszej stronie. Tryb MCP go nie potrzebuje.",
      );
    }
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    this.profiles = {
      classify: { model: cfg.models.classify, maxTokens: 2_048 },
      chat: { model: cfg.models.chat, maxTokens: 2_048 },
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
    return (await this.completeDetailed(args)).text;
  }

  /**
   * To samo, ale ze zużyciem tokenów.
   *
   * Istnieje, bo monitor w tle pracuje bez człowieka i jego koszt musi być
   * mierzony, a nie szacowany. `complete` zwracał wyłącznie tekst i wyrzucał
   * `usage` — czyli jedyną twardą liczbę, jaką dostajemy od API.
   */
  async completeDetailed(args: {
    role: ModelRole;
    system: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
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
    return {
      text: res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim(),
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      model: p.model,
    };
  }
}
