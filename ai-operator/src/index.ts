import { CapabilityRegistry } from "./capability/registry.js";
import type { AnyCapability, Scope } from "./capability/types.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ModelLayer } from "./model/roles.js";
import { createMailCapabilities } from "./mail/capabilities.js";
import { FixtureMailProvider } from "./mail/fixture.js";
import { ImapMailProvider } from "./mail/imap.js";
import type { MailProvider } from "./mail/types.js";
import { createTeabrewCapabilities } from "./teabrew/capabilities.js";
import { FixtureTeabrewReader, HttpTeabrewReader, type TeabrewReader } from "./teabrew/client.js";
import { InboxOperator } from "./agent/operator.js";
import { MailTriage } from "./agent/triage.js";

/** Zakresy przyznane agentowi inbox-operator. Oba są tylko do czytania. */
export const AGENT_SCOPES: readonly Scope[] = ["mail:read", "erp:read"];

export interface App {
  readonly config: AppConfig;
  readonly registry: CapabilityRegistry;
  readonly models: ModelLayer;
  readonly operator: InboxOperator;
  readonly triage: MailTriage;
  close(): Promise<void>;
}

/**
 * Złożenie aplikacji. Dostawcy są tworzeni leniwie: uruchomienie w trybie
 * fikstur nigdy nie próbuje otworzyć połączenia IMAP, a `npm run openapi`
 * nie potrzebuje ani skrzynki, ani klucza API.
 */
export function createApp(config: AppConfig = loadConfig()): App {
  let mailProvider: MailProvider | null = null;
  let teabrewReader: TeabrewReader | null = null;

  const getMail = async (): Promise<MailProvider> => {
    if (mailProvider) return mailProvider;
    mailProvider =
      config.mail.kind === "imap"
        ? new ImapMailProvider({
            host: config.mail.host,
            port: config.mail.port,
            user: config.mail.user,
            pass: config.mail.pass,
            folder: config.mail.folder,
            threadFolders: config.mail.threadFolders,
          })
        : new FixtureMailProvider({ filePath: config.mail.filePath });
    return mailProvider;
  };

  const getTeabrew = async (): Promise<TeabrewReader> => {
    if (teabrewReader) return teabrewReader;
    teabrewReader =
      config.teabrew.kind === "http"
        ? new HttpTeabrewReader({ baseUrl: config.teabrew.baseUrl, token: config.teabrew.token })
        : new FixtureTeabrewReader({ filePath: config.teabrew.filePath });
    return teabrewReader;
  };

  const registry = new CapabilityRegistry().registerAll([
    ...createMailCapabilities(getMail),
    ...createTeabrewCapabilities(getTeabrew),
  ]);

  const models = new ModelLayer(config);
  const shared = {
    registry,
    models,
    scopes: AGENT_SCOPES,
    auditFile: config.auditFile,
  };

  return {
    config,
    registry,
    models,
    operator: new InboxOperator(shared),
    triage: new MailTriage(shared),
    async close() {
      await mailProvider?.close();
    },
  };
}

/**
 * Rejestr bez modeli i bez dostawców — do generowania projekcji (OpenAPI, MCP,
 * spis capability). Nie wymaga żadnego sekretu, więc działa też w CI.
 */
export function createRegistryForProjections(): CapabilityRegistry {
  const unreachable = async (): Promise<never> => {
    throw new Error("rejestr do projekcji nie wykonuje wywołań");
  };
  const caps: AnyCapability[] = [
    ...createMailCapabilities(unreachable),
    ...createTeabrewCapabilities(unreachable),
  ];
  return new CapabilityRegistry().registerAll(caps);
}

export { CapabilityRegistry } from "./capability/registry.js";
export * from "./capability/types.js";
export { InboxOperator } from "./agent/operator.js";
export { MailTriage, renderTriage } from "./agent/triage.js";
