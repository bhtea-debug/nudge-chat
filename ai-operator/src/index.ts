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
import { CopilotStore } from "./state/store.js";
import { createIssueCapabilities } from "./state/capabilities.js";
import { MailMonitor } from "./state/monitor.js";
import { createMarketingCapabilities } from "./marketing/capabilities.js";
import {
  HttpMarketingPlannerReader,
  UnavailableMarketingPlannerReader,
  type MarketingPlannerReader,
} from "./marketing/client.js";
import { createBudzecikCapabilities } from "./budzecik/capabilities.js";
import {
  HttpBudzecikReader,
  UnavailableBudzecikReader,
  type BudzecikReader,
} from "./budzecik/client.js";

/**
 * Zakresy przyznane agentowi. Wszystkie są tylko do czytania.
 *
 * `issues:read` to pamięć Copilota — osobny zakres, bo to inna domena niż
 * poczta i ERP. Zapis do tej pamięci NIE przechodzi przez capability: robi to
 * store bezpośrednio, wołany przez monitor i przez adapter. Dzięki temu
 * `effectClass: "read"` pozostaje prawdą dla każdego narzędzia w rejestrze.
 */
export const AGENT_SCOPES: readonly Scope[] = [
  "mail:read",
  "erp:read",
  "issues:read",
  "planner:read",
  "budget:read",
  "customer_cases:read",
  "customer_cases:content",
];

export interface App {
  readonly config: AppConfig;
  readonly registry: CapabilityRegistry;
  /**
   * Warstwa modelu i agenci są LENIWE — powstają dopiero przy pierwszym użyciu.
   *
   * Dzięki temu tryb MCP, w którym modelem jest Claude po stronie klienta,
   * nigdy ich nie tworzy i nie potrzebuje ANTHROPIC_API_KEY. To nie jest
   * mikrooptymalizacja: bez tego `npm run mcp` nie wstawał bez klucza, mimo
   * że nie miał go po co używać.
   */
  readonly models: ModelLayer;
  readonly operator: InboxOperator;
  readonly triage: MailTriage;
  /** Pamięć Copilota. Leniwa — otwiera dziennik przy pierwszym użyciu. */
  readonly store: CopilotStore;
  readonly monitor: MailMonitor;
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
  let marketingPlannerReader: MarketingPlannerReader | null = null;
  let budzecikReader: BudzecikReader | null = null;

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

  const getMarketingPlanner = async (): Promise<MarketingPlannerReader> => {
    if (marketingPlannerReader) return marketingPlannerReader;
    marketingPlannerReader =
      config.marketingPlanner.kind === "http"
        ? new HttpMarketingPlannerReader({
            baseUrl: config.marketingPlanner.baseUrl,
            token: config.marketingPlanner.token,
          })
        : new UnavailableMarketingPlannerReader();
    return marketingPlannerReader;
  };

  const getBudzecik = async (): Promise<BudzecikReader> => {
    if (budzecikReader) return budzecikReader;
    budzecikReader = config.budzecik.kind === "http"
      ? new HttpBudzecikReader({
          baseUrl: config.budzecik.baseUrl,
          token: config.budzecik.token,
        })
      : new UnavailableBudzecikReader();
    return budzecikReader;
  };

  // Stan Copilota jest leniwy: `npm run caps` i `openapi` nie mają po co
  // otwierać dziennika, a MCP otwiera go dopiero przy pierwszym pytaniu o sprawy.
  let store: CopilotStore | null = null;
  const getStore = (): CopilotStore =>
    (store ??= new CopilotStore({ dir: config.copilot.stateDir, actor: "copilot" }));

  const registry = new CapabilityRegistry().registerAll([
    ...createMailCapabilities(getMail),
    ...createTeabrewCapabilities(getTeabrew),
    ...createMarketingCapabilities(getMarketingPlanner),
    ...createBudzecikCapabilities(getBudzecik),
    ...createIssueCapabilities(getStore),
  ]);

  let models: ModelLayer | null = null;
  const getModels = (): ModelLayer => (models ??= new ModelLayer(config));
  const shared = () => ({
    registry,
    models: getModels(),
    scopes: AGENT_SCOPES,
    auditFile: config.auditFile,
  });

  let operator: InboxOperator | null = null;
  let triage: MailTriage | null = null;
  let monitor: MailMonitor | null = null;

  return {
    config,
    registry,
    get store() {
      return getStore();
    },
    get monitor() {
      return (monitor ??= new MailMonitor({
        registry,
        // Warstwa modelu jest LENIWA i w trybie deterministycznym nigdy nie
        // powstaje — dlatego monitor bez kredytów API startuje bez problemu.
        get models() {
          return getModels();
        },
        scopes: AGENT_SCOPES,
        store: getStore(),
        auditFile: config.auditFile,
        folders: config.copilot.monitorFolders,
        firstRunDays: config.copilot.firstRunDays,
        maxPerFolder: config.copilot.maxPerFolder,
        maxErpLookups: config.copilot.maxErpLookups,
        classifier: config.copilot.classifier,
        ownAddress: config.mail.kind === "imap" ? config.mail.user : null,
        sentFolder: config.copilot.sentFolder,
      }));
    },
    get models() {
      return getModels();
    },
    get operator() {
      return (operator ??= new InboxOperator(shared()));
    },
    get triage() {
      return (triage ??= new MailTriage(shared()));
    },
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
    ...createMarketingCapabilities(unreachable),
    ...createBudzecikCapabilities(unreachable),
    ...createIssueCapabilities(() => {
      throw new Error("rejestr do projekcji nie otwiera stanu");
    }),
  ];
  return new CapabilityRegistry().registerAll(caps);
}

export { CapabilityRegistry } from "./capability/registry.js";
export * from "./capability/types.js";
export { InboxOperator } from "./agent/operator.js";
export { MailTriage, renderTriage } from "./agent/triage.js";
