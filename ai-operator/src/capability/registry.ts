import {
  CapabilityError,
  type AnyCapability,
  type CapabilityContext,
  type EffectClass,
} from "./types.js";

/**
 * Klasy efektu dopuszczone w tym MVP. Lista jest tutaj, w jednym miejscu,
 * i jest sprawdzana dwa razy: przy rejestracji i przy każdym wywołaniu.
 *
 * Dzięki temu "agent jest read-only" nie jest obietnicą w promptcie —
 * capability zapisująca nie da się nawet zarejestrować.
 */
const ALLOWED_EFFECTS: readonly EffectClass[] = ["read"];

export class CapabilityRegistry {
  private readonly caps = new Map<string, AnyCapability>();

  register(cap: AnyCapability): this {
    if (!ALLOWED_EFFECTS.includes(cap.effectClass)) {
      throw new CapabilityError(
        "forbidden_effect",
        `capability "${cap.name}" ma effectClass="${cap.effectClass}"; ten rejestr przyjmuje wyłącznie: ${ALLOWED_EFFECTS.join(", ")}`,
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(cap.name)) {
      throw new CapabilityError(
        "invalid_input",
        `nazwa capability "${cap.name}" musi być snake_case (^[a-z][a-z0-9_]*$)`,
      );
    }
    if (this.caps.has(cap.name)) {
      throw new CapabilityError(
        "invalid_input",
        `capability "${cap.name}" jest już zarejestrowana`,
      );
    }
    this.caps.set(cap.name, cap);
    return this;
  }

  registerAll(caps: readonly AnyCapability[]): this {
    for (const c of caps) this.register(c);
    return this;
  }

  get(name: string): AnyCapability {
    const cap = this.caps.get(name);
    if (!cap) {
      throw new CapabilityError(
        "not_found",
        `nie ma capability o nazwie "${name}"`,
      );
    }
    return cap;
  }

  has(name: string): boolean {
    return this.caps.has(name);
  }

  list(): readonly AnyCapability[] {
    return [...this.caps.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Podzbiór widoczny dla wywołującego o danych zakresach. */
  listForScopes(scopes: readonly string[]): readonly AnyCapability[] {
    return this.list().filter((c) => scopes.includes(c.scope));
  }

  /**
   * Jedyna droga do wykonania capability. Waliduje wejście, sprawdza zakres
   * i klasę efektu, mierzy czas, waliduje wyjście i **zawsze** zapisuje audyt —
   * także dla błędów. Nie da się wywołać capability bez wpisu w audycie.
   */
  async invoke(
    name: string,
    rawInput: unknown,
    ctx: CapabilityContext,
  ): Promise<unknown> {
    const started = Date.now();
    let cap: AnyCapability | undefined;
    let parsedInput: unknown;
    let output: unknown;

    const finish = (ok: boolean, error?: string): void => {
      ctx.audit.write({
        ts: new Date(started).toISOString(),
        agent: ctx.agent,
        correlationId: ctx.correlationId,
        capability: name,
        capabilityVersion: cap?.version ?? "?",
        ok,
        latencyMs: Date.now() - started,
        ...(error ? { error } : {}),
        ...(cap?.auditRefs && parsedInput !== undefined
          ? { refs: safeRefs(cap, parsedInput, output) }
          : {}),
      });
    };

    try {
      cap = this.get(name);

      if (!ALLOWED_EFFECTS.includes(cap.effectClass)) {
        throw new CapabilityError(
          "forbidden_effect",
          `capability "${name}" nie jest read-only`,
        );
      }
      if (!ctx.scopes.includes(cap.scope)) {
        throw new CapabilityError(
          "forbidden_scope",
          `capability "${name}" wymaga zakresu "${cap.scope}", którego ten agent nie ma`,
        );
      }

      const inParse = cap.input.safeParse(rawInput);
      if (!inParse.success) {
        throw new CapabilityError(
          "invalid_input",
          `nieprawidłowe wejście dla "${name}": ${formatIssues(inParse.error)}`,
        );
      }
      parsedInput = inParse.data;

      const result = await cap.handler(parsedInput, ctx);

      const outParse = cap.output.safeParse(result);
      if (!outParse.success) {
        throw new CapabilityError(
          "invalid_output",
          `capability "${name}" zwróciła dane niezgodne ze schematem: ${formatIssues(outParse.error)}`,
        );
      }
      output = outParse.data;
      finish(true);
      return output;
    } catch (err) {
      const code = err instanceof CapabilityError ? err.code : "upstream_error";
      finish(false, code);
      throw err;
    }
  }
}

function safeRefs(
  cap: AnyCapability,
  input: unknown,
  output: unknown,
): Record<string, string | number | boolean> {
  try {
    return cap.auditRefs!(input, output);
  } catch {
    return {};
  }
}

function formatIssues(err: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
