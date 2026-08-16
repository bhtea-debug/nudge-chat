import { z } from "zod";
import type { AnyCapability } from "./types.js";
import type { CapabilityRegistry } from "./registry.js";

/**
 * Projekcje. Jedna deklaracja capability -> wiele klientów.
 * Tutaj nie ma żadnej wiedzy o poczcie ani o TeaBrew — tylko przepisanie
 * tego samego rejestru na trzy formaty.
 */

/** Kształt narzędzia dla function callingu (Claude: tools[].input_schema). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

function jsonSchema(
  schema: z.ZodType,
  io: "input" | "output",
  target: "draft-2020-12" | "openapi-3.0",
): Record<string, unknown> {
  const out = z.toJSONSchema(schema, {
    target,
    io,
    // Typy nieprzedstawialne w JSON Schema (np. Date) zamieniamy na any,
    // zamiast wywracać generowanie całego dokumentu.
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete out["$schema"];
  return out;
}

/** Definicje narzędzi dla modelu. Opis zawiera wersję i klasę efektu. */
export function toToolDefinitions(
  caps: readonly AnyCapability[],
): ToolDefinition[] {
  return caps.map((cap) => ({
    name: cap.name,
    description: `${cap.description}\n\n(read-only, v${cap.version})`,
    input_schema: jsonSchema(cap.input, "input", "draft-2020-12"),
  }));
}

/**
 * Projekcja HTTP. Każda capability to jeden POST /capabilities/{name}.
 * Jednolity kształt jest celowy: kolejna capability nie wymaga projektowania
 * kolejnego REST-owego zasobu.
 */
export function toOpenApiDocument(
  caps: readonly AnyCapability[],
  opts: { title: string; version: string; serverUrl?: string },
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const cap of caps) {
    paths[`/capabilities/${cap.name}`] = {
      post: {
        operationId: cap.name,
        summary: cap.description.split("\n")[0],
        description: cap.description,
        tags: [cap.scope],
        "x-capability-version": cap.version,
        "x-effect-class": cap.effectClass,
        "x-scope": cap.scope,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: jsonSchema(cap.input, "input", "openapi-3.0"),
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "data", "correlationId"],
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    correlationId: { type: "string" },
                    data: jsonSchema(cap.output, "output", "openapi-3.0"),
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/CapabilityError" },
          "401": { $ref: "#/components/responses/CapabilityError" },
          "403": { $ref: "#/components/responses/CapabilityError" },
          "502": { $ref: "#/components/responses/CapabilityError" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: opts.title,
      version: opts.version,
      description:
        "Warstwa capability agenta inbox-operator. Wszystkie operacje są read-only " +
        "(effectClass=read). Dokument jest generowany z rejestru capability, nie pisany ręcznie.",
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      responses: {
        CapabilityError: {
          description: "Błąd wywołania capability",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "error"],
                properties: {
                  ok: { type: "boolean", enum: [false] },
                  correlationId: { type: "string" },
                  error: {
                    type: "object",
                    required: ["code", "message"],
                    properties: {
                      code: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Projekcja MCP (tools/list). MCP jest tu wyłącznie adapterem — ten sam
 * rejestr, inny transport. Nic w systemie nie zależy od MCP.
 */
export function toMcpToolList(
  caps: readonly AnyCapability[],
): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return caps.map((cap) => ({
    name: cap.name,
    description: `${cap.description}\n\n(read-only, v${cap.version})`,
    inputSchema: jsonSchema(cap.input, "input", "draft-2020-12"),
  }));
}

/**
 * Typowany klient TypeScript. Sygnatury bierzemy z tych samych schematów zod,
 * więc klient nie może rozjechać się z rejestrem — kompilator to wyłapie.
 */
export type CapabilityClient<M extends Record<string, AnyCapability>> = {
  [K in keyof M]: M[K] extends { input: z.ZodType<infer I>; output: z.ZodType<infer O> }
    ? (input: I) => Promise<O>
    : never;
};

export function createLocalClient<M extends Record<string, AnyCapability>>(
  registry: CapabilityRegistry,
  map: M,
  ctx: Parameters<CapabilityRegistry["invoke"]>[2],
): CapabilityClient<M> {
  const client = {} as Record<string, (input: unknown) => Promise<unknown>>;
  for (const key of Object.keys(map)) {
    const cap = map[key]!;
    client[key] = (input: unknown) => registry.invoke(cap.name, input, ctx);
  }
  return client as CapabilityClient<M>;
}

/** Ludzki spis capability — do README i do `npm run caps`. */
export function toMarkdownTable(caps: readonly AnyCapability[]): string {
  const rows = caps.map(
    (c) =>
      `| \`${c.name}\` | ${c.version} | ${c.scope} | ${c.effectClass} | ${c.description.split("\n")[0]} |`,
  );
  return [
    "| capability | wersja | zakres | effectClass | opis |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
