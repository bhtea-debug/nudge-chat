import type { z } from "zod";

/**
 * Klasa efektu. W MVP rejestr przyjmuje wyłącznie "read" — patrz registry.ts.
 * Pozostałe wartości istnieją, żeby deklaracja capability nie musiała zmieniać
 * kształtu, kiedy firma zdecyduje się dopuścić zapisy.
 */
export type EffectClass =
  | "read"
  | "write-reversible"
  | "write-irreversible"
  | "external";

/** Zakres uprawnień. Agent dostaje listę zakresów; capability wymaga jednego. */
export type Scope =
  | "mail:read"
  | "erp:read";

export interface CapabilityContext {
  /** Kto wywołuje. W MVP zawsze jeden agent: "inbox-operator". */
  readonly agent: string;
  /** Id korelacji jednej odpowiedzi dla właściciela — wspólne dla wszystkich wywołań. */
  readonly correlationId: string;
  /** Zakresy przyznane temu wywołującemu. */
  readonly scopes: readonly Scope[];
  /** Logger audytu. */
  readonly audit: AuditSink;
  /** Sygnał przerwania (timeout / Ctrl-C). */
  readonly signal?: AbortSignal;
}

export interface AuditRecord {
  readonly ts: string;
  readonly agent: string;
  readonly correlationId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Klucz błędu, nigdy treść danych. */
  readonly error?: string;
  /**
   * Wyłącznie identyfikatory i liczniki — nigdy treść maila.
   * Np. { orderNumber: "12345" } albo { messageCount: 4 }.
   */
  readonly refs?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditSink {
  write(record: AuditRecord): void;
  records(): readonly AuditRecord[];
}

/**
 * Jedna deklaracja capability. Z niej wyprowadzamy:
 *  - klienta TypeScript (typy in/out),
 *  - definicje narzędzi dla function callingu (JSON Schema),
 *  - dokument OpenAPI,
 *  - opcjonalny adapter MCP.
 * Nie ma drugiego miejsca, w którym opisujemy tę samą funkcję.
 */
export interface Capability<I = unknown, O = unknown> {
  /** snake_case, stabilna nazwa widziana przez model i przez HTTP. */
  readonly name: string;
  readonly version: string;
  /** Opis pisany dla modelu: kiedy tego użyć, czego to NIE robi. */
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly scope: Scope;
  readonly effectClass: EffectClass;
  /**
   * Co wolno zapisać w audycie z tego wywołania. Dostaje input i output,
   * zwraca wyłącznie identyfikatory / liczniki. Brak funkcji = brak refs.
   */
  readonly auditRefs?: (
    input: I,
    output: O | undefined,
  ) => Record<string, string | number | boolean>;
  readonly handler: (input: I, ctx: CapabilityContext) => Promise<O>;
}

/** Wygodny alias, kiedy typy nie mają znaczenia (rejestr, projekcje). */
export type AnyCapability = Capability<any, any>;

export class CapabilityError extends Error {
  constructor(
    /** Stabilny klucz do audytu i do decyzji agenta. */
    readonly code:
      | "not_found"
      | "invalid_input"
      | "invalid_output"
      | "forbidden_effect"
      | "forbidden_scope"
      | "upstream_unavailable"
      | "upstream_error"
      | "not_configured"
      | "timeout",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}
