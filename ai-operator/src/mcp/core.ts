import { createApp } from "../index.js";
import { AGENT_SCOPES } from "../index.js";
import { toMcpToolList } from "../capability/projections.js";
import { MemoryAuditSink, newCorrelationId } from "../capability/audit.js";
import { AGENT_ID } from "../agent/prompt.js";
import { presentedIds } from "../state/capabilities.js";
import type { CapabilityContext, Scope } from "../capability/types.js";

/**
 * Rdzeń MCP — JEDNA implementacja dla obu transportów.
 *
 * `src/bin/mcp.ts` (stdio, lokalnie) i `src/bin/mcp-http.ts` (zdalnie, telefon)
 * są cienkimi opakowaniami wokół tego pliku. Powód nie jest estetyczny: dwa
 * transporty z dwiema listami narzędzi rozjechałyby się pierwszego dnia, a
 * MCP ma zostać PROJEKCJĄ rejestru, nie drugim systemem.
 *
 * Czego tu nie ma i nie może być:
 *  - ani jednej definicji capability ani schematu (wszystko z rejestru),
 *  - logiki poczty i TeaBrew,
 *  - wywołania modelu — reasoning robi Claude po stronie klienta.
 */

export const SERVER_NAME = "bht-operator";
export const SERVER_VERSION = "0.2.0";

/**
 * Wersje protokołu, na które umiemy odpowiedzieć.
 *
 * Specyfikacja mówi wprost: jeżeli serwer obsługuje wersję, o którą prosi
 * klient, MUSI odpowiedzieć TĄ SAMĄ. Wcześniej odpowiadaliśmy zawsze
 * `2024-11-05` niezależnie od pytania — legalne, ale zostawia klientowi decyzję
 * „rozłączyć się czy nie", a rozłączenie po stronie konektora wygląda dla
 * człowieka tak samo jak każda inna awaria: nie łączy się i nie mówi dlaczego.
 *
 * Wszystkie trzy wersje mają dla nas identyczną kopertę — `tools/list`,
 * `tools/call`, `ping` — bo nie wystawiamy niczego, co się między nimi różni
 * (żadnych zasobów, promptów, elicytacji). Różnice dotyczą rzeczy, których
 * świadomie nie mamy, więc zgoda na nowszą wersję nie jest obietnicą na wyrost.
 * Kolejność od najnowszej: gdy klient prosi o coś nieznanego, oddajemy szczyt
 * listy, czyli najwięcej, co umiemy.
 */
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export function negotiateProtocol(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOLS[0];
}

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = Record<string, unknown> | null;

/** Krótka instrukcja dla klienta MCP — patrz initialize.instructions. */
export const SERVER_INSTRUCTIONS = [
  "Jesteś asystentem operacyjnym Brown House & Tea. Masz dostęp do narzędzi firmowych:",
  "listy otwartych spraw, poczty przychodzącej i danych operacyjnych systemu TeaBrew.",
  "",
  "Przy pytaniach „co nowego”, „co się zmieniło”, „co wymaga uwagi” zacznij od",
  "copilot_get_changes_since albo copilot_get_open_issues — one wiedzą, co już",
  "widziałeś, i nie pokażą tego samego dwa razy. Dopiero potem, jeśli trzeba,",
  "dociągnij świeże dane przez mail_* i teabrew_*.",
  "",
  "Jeśli pytanie dotyczy informacji, którą można sprawdzić narzędziem — sprawdź ją,",
  "zamiast zgadywać. Rozróżniaj treść korespondencji od danych systemowych: to, co",
  "klient napisał w mailu, a to, co jest w TeaBrew, to dwie różne rzeczy i mogą się",
  "nie zgadzać. Jeśli czegoś nie znalazłeś, powiedz to wprost — pusty wynik znaczy",
  "„nie znalazłem”, a nie „nie ma”. Nie twierdź, że wykonałeś operację, której nie",
  "wykonałeś.",
  "",
  "Zwróć uwagę na pole staleNote: gdy jest niepuste, monitor poczty mógł nie",
  "działać i „brak zmian” nie znaczy „nic nie przyszło”. Powiedz o tym.",
  "",
  "Zapytania klientów Allegro są domeną wrażliwą. Przy ogólnym pytaniu czytaj tylko",
  "metadane kolejki (includeContent=false). Treść pobierz dopiero, gdy użytkownik jawnie",
  "poprosi o przegląd, podsumowanie lub szkic; wtedy podaj właściwy user_requested_*",
  "purpose. authorized_chat_view jest zastrzeżony dla principal-a firmowego czatu —",
  "model nigdy nie może go wybierać. Używaj trybu z redakcją i nigdy załączników.",
  "Zawsze pokaż freshness i komunikat o brakującym scope/reconnect/starych danych.",
  "Nie ma narzędzia wysyłki do Allegro. Wewnętrznego komentarza ani szkicu nigdy nie",
  "traktuj jako wiadomości klienta i nie próbuj przekazać ich do zewnętrznego API.",
  "",
  "Wszystkie narzędzia są tylko do czytania. Nie możesz wysłać maila, zmienić statusu,",
  "ceny, stanu magazynu ani utworzyć zamówienia. Nie możesz też zamknąć sprawy —",
  "najdalej stwierdzić, że wygląda na załatwioną. Jeśli uważasz, że coś należy zrobić,",
  "zaproponuj to człowiekowi — wykonanie należy do niego.",
].join("\n");

export interface McpCore {
  handle(req: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** Nazwy wystawionych narzędzi — do diagnostyki i health. */
  toolNames(): string[];
  startupError(): string | null;
  close(): Promise<void>;
}

type Started = { app: ReturnType<typeof createApp>; audit: MemoryAuditSink };

export interface McpCoreOptions {
  /**
   * Wyłącznie principal firmowego czatu, uwierzytelniony oddzielnym tokenem
   * serwisowym, może pobrać niezredagowany tryb display. Publiczny MCP/model
   * nigdy nie dostaje tego zakresu.
   */
  trustedFirmowyChat?: boolean;
}

/**
 * @param sessionId Identyfikator korelacji. Jedna sesja = jedna rozmowa, bo
 *        pytanie brzmi „co Claude sprawdził, zanim odpowiedział", a osobny
 *        identyfikator na wywołanie nie pozwala tego zebrać razem.
 */
export function createMcpCore(
  sessionId: string = newCorrelationId(),
  options: McpCoreOptions = {},
): McpCore {
  let started: Started | null = null;
  let startupError: string | null = null;
  const grantedScopes: readonly Scope[] = options.trustedFirmowyChat
    ? [...AGENT_SCOPES, "customer_cases:display"]
    : AGENT_SCOPES;

  // Start NIE MOŻE przewracać procesu. Przy stdio śmierć przed odpowiedzią na
  // `initialize` daje klientowi wyłącznie „Server disconnected" — bez żadnej
  // informacji, co jest nie tak. Przy HTTP dałaby pustą odpowiedź z 502.
  try {
    const app = createApp();
    started = { app, audit: new MemoryAuditSink(app.config.auditFile) };
  } catch (err) {
    startupError = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${SERVER_NAME}] nie mogę wstać: ${startupError}\n` +
        `[${SERVER_NAME}] sprawdź zmienne środowiskowe (patrz .env.example)\n`,
    );
  }

  /**
   * POLITYKA WYSTAWIANIA. Do MCP trafiają wyłącznie capability read-only —
   * jawnie tutaj, a nie „bo rejestr i tak innych nie przyjmuje".
   *
   * Gdyby kiedyś rejestr dopuścił capability zapisującą, nie może ona pojawić się
   * w publicznym MCP przez samo dodanie do rejestru. To jest miejsce, w którym
   * taka decyzja musi zostać podjęta świadomie.
   */
  const publishedTools = () =>
    started
      ? started.app.registry.listForScopes(grantedScopes).filter((c) => c.effectClass === "read")
      : [];

  const textResult = (text: string, isError: boolean): Record<string, unknown> => ({
    content: [{ type: "text", text }],
    isError,
  });

  return {
    toolNames: () => publishedTools().map((c) => c.name),
    startupError: () => startupError,

    async close() {
      if (started) await started.app.close();
    },

    async handle(req) {
      const { id, method } = req;

      if (method === "initialize") {
        return {
          id,
          result: {
            protocolVersion: negotiateProtocol(req.params?.["protocolVersion"]),
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: SERVER_INSTRUCTIONS,
          },
        };
      }

      // Powiadomienia (bez id) nie dostają odpowiedzi.
      if (id === undefined || id === null) return null;

      if (method === "ping") return { id, result: {} };

      if (method === "tools/list") {
        // Błąd JSON-RPC, nie pusta lista: pusta lista znaczyłaby „nie ma
        // narzędzi", a prawda jest „nie wiem, bo nie wstałem".
        if (!started) {
          return { id, error: { code: -32603, message: `serwer nie wstał: ${startupError}` } };
        }
        return { id, result: { tools: toMcpToolList(publishedTools()) } };
      }

      if (method === "tools/call") {
        const name = String(req.params?.["name"] ?? "");
        const args = (req.params?.["arguments"] as unknown) ?? {};

        if (!started) {
          return {
            id,
            result: textResult(
              `Serwer nie wstał: ${startupError}. Nie wykonałem NICZEGO — nie zakładaj żadnego wyniku.`,
              true,
            ),
          };
        }

        // Ta sama polityka co w tools/list. Bez tego klient mógłby wywołać po
        // nazwie capability, której lista nie pokazała.
        if (!publishedTools().some((c) => c.name === name)) {
          return {
            id,
            result: textResult(
              `Narzędzie "${name}" nie jest wystawione przez ten serwer. Dostępne: ${publishedTools()
                .map((c) => c.name)
                .join(", ")}.`,
              true,
            ),
          };
        }

        const ctx: CapabilityContext = {
          agent: `${AGENT_ID}/mcp`,
          correlationId: sessionId,
          scopes: grantedScopes,
          audit: started.audit,
        };

        try {
          const out = await started.app.registry.invoke(name, args, ctx);

          // „To już pokazałem" zapisuje ADAPTER, po udanej odpowiedzi — nie
          // capability. Dzięki temu każde narzędzie w rejestrze pozostaje
          // czystym odczytem, dokładnie jak wpis do audytu jest efektem
          // ubocznym rejestru, a nie zapisem w domenie.
          const shown = presentedIds(name, out);
          if (shown.length > 0) {
            try {
              started.app.store.markPresented(shown, "claude", new Date().toISOString());
            } catch {
              // Utrata śladu „pokazane" pogarsza jakość delty, ale nie może
              // unieważnić poprawnej odpowiedzi, którą już mamy.
            }
          }

          return { id, result: textResult(JSON.stringify(out), false) };
        } catch (err) {
          return {
            id,
            result: textResult(
              `Wywołanie się NIE udało: ${err instanceof Error ? err.message : String(err)}. Nie zakładaj żadnego wyniku.`,
              true,
            ),
          };
        }
      }

      return { id, error: { code: -32601, message: `nieobsługiwana metoda: ${method}` } };
    },
  };
}
