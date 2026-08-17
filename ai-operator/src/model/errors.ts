/**
 * Tłumaczenie błędów API modelu na komunikaty dla człowieka.
 *
 * Powód jest ten sam, co przy rozdzieleniu „złe hasło" od „brak sieci" w
 * adapterze IMAP: surowy `400 {"type":"error","error":{...}}` wysyła właściciela
 * szukać usterki w kodzie, podczas gdy problemem jest saldo na koncie. Zły
 * komunikat błędu kosztuje więcej niż sam błąd.
 *
 * `transient` odpowiada na pytanie „czy warto powtórzyć w następnym przebiegu".
 * Brak kredytów nie naprawi się sam przez powtarzanie, limit szybkości owszem.
 */

export interface ModelErrorExplanation {
  readonly plain: string;
  readonly advice: string;
  /** true = ponowienie ma sens (limit, przeciążenie). false = trzeba coś zrobić. */
  readonly transient: boolean;
  /** Krótki kod do logu i statystyk. */
  readonly kind:
    | "brak_kredytow"
    | "zly_klucz"
    | "limit_szybkosci"
    | "przeciazenie"
    | "brak_klucza"
    | "inny";
}

const raw = (err: unknown): string =>
  err instanceof Error ? `${err.message}` : String(err);

export function explainModelError(err: unknown): ModelErrorExplanation {
  const text = raw(err).toLowerCase();

  if (text.includes("credit balance is too low") || text.includes("insufficient")) {
    return {
      kind: "brak_kredytow",
      plain: "Skończyły się kredyty API Anthropic.",
      advice:
        "To NIE jest usterka kodu i nic nie zostało pominięte — checkpoint stoi na miejscu, " +
        "więc po doładowaniu monitor przeczyta te same wiadomości. Uzupełnij saldo w Plans & Billing. " +
        "Uwaga: kredyty bywają dostępne z opóźnieniem po zakupie.",
      transient: false,
    };
  }

  if (text.includes("not_configured") || text.includes("brak anthropic_api_key")) {
    return {
      kind: "brak_klucza",
      plain: "Nie ma klucza ANTHROPIC_API_KEY.",
      advice:
        "Monitor i raport dzienny wołają model po naszej stronie, więc wymagają klucza. " +
        "Rozmowa z Claude przez MCP go NIE potrzebuje — tam modelem jest Claude po Twojej stronie.",
      transient: false,
    };
  }

  if (text.includes("authentication") || text.includes("invalid x-api-key") || text.includes("401")) {
    return {
      kind: "zly_klucz",
      plain: "Anthropic odrzucił klucz API.",
      advice: "Sprawdź ANTHROPIC_API_KEY w .env — najczęściej to obcięta albo unieważniona wartość.",
      transient: false,
    };
  }

  if (text.includes("rate_limit") || text.includes("429")) {
    return {
      kind: "limit_szybkosci",
      plain: "Limit szybkości API — za dużo zapytań naraz.",
      advice: "Następny przebieg powinien przejść. Jeśli powtarza się często, wydłuż MONITOR_INTERVAL_MINUTES.",
      transient: true,
    };
  }

  if (text.includes("overloaded") || text.includes("529") || text.includes("503")) {
    return {
      kind: "przeciazenie",
      plain: "API modelu chwilowo przeciążone.",
      advice: "Nic nie trzeba robić — następny przebieg spróbuje ponownie.",
      transient: true,
    };
  }

  return {
    kind: "inny",
    plain: raw(err).split("\n")[0]?.slice(0, 200) ?? "nieznany błąd",
    advice: "Pełna treść błędu jest w logu przebiegu.",
    transient: true,
  };
}

/** Jedna linia do logu: co się stało i co z tym zrobić. */
export function formatModelError(err: unknown): string {
  const e = explainModelError(err);
  return `${e.plain} ${e.advice}`;
}
