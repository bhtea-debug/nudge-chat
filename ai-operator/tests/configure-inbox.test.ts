import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Bramka konfiguracji Railway.
 *
 * Testy uruchamiają PRAWDZIWY skrypt z podstawionym `railway` na ścieżce.
 * Bez tego jedynym dowodem byłaby lektura kodu, a bramka, która wygląda na
 * mocną i nie jest, to gorsze niż brak bramki — daje fałszywe poczucie
 * zabezpieczenia dokładnie tam, gdzie chodzi o cudze skrzynki.
 *
 * Druga rzecz, której te testy pilnują: bramka ma odwzorowywać walidację
 * z `src/bin/mcp-http.ts` i `src/config.ts` 1:1. Konfiguracja „kompletna"
 * według skryptu, przy której proces kończy się kodem 1 przy starcie, jest
 * gorsza niż brak skryptu — mówi, że jest dobrze, a nic nie wstanie.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(operatorDir, "scripts/configure-inbox.sh");

const PROJECT = "bd311917-f3d7-419f-aeba-79bf5b4dafe4";
const ENVIRONMENT = "e8e60c09-4de2-4fb3-a11d-6e9048371e54";
const SERVICE = "c4a9c0ad-7c0e-4494-a16e-321e0e382b6c";

/** Proces odrzuca token krótszy niż tyle znaków (MIN_TOKEN_LENGTH w mcp-http.ts). */
const MIN_TOKEN_LENGTH = 32;

/** Token o DOKŁADNIE zadanej długości — bramka patrzy na długość, nie na treść. */
function token(prefix: string, length: number = MIN_TOKEN_LENGTH): string {
  return prefix.padEnd(length, "x").slice(0, length);
}

const MCP_TOKEN = token("mcp-bearer-");
const TRUSTED_TOKEN = token("trusted-chat-");
const BRIDGE_TOKEN = token("bridge-reply-");
const REPLY_TOKEN = token("teabrew-reply-");
const READ_TOKEN = token("teabrew-read-");

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface FakeRailway {
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly serviceId?: string;
  readonly volumes?: string;
  readonly vars?: Record<string, string>;
}

/** Podstawia atrapę `railway` na PATH i uruchamia skrypt w danym trybie. */
function run(mode: string, fake: FakeRailway): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "railway-guard-"));
  dirs.push(dir);

  /*
   * Kształt odpowiedzi CLI odwzorowany ze ZMIERZONEGO `railway status --json`
   * (2026-08-23): projekt z nazwą, środowiska w edges, usługi i wolumeny
   * w serviceInstances/volumeInstances danego środowiska. Stary kształt
   * (`environment.id` na szczycie) w dzisiejszym CLI nie istnieje — bramka
   * pisana pod niego poległa pierwszego dnia na produkcji.
   */
  const maWolumen = (fake.volumes ?? "/data") === "/data";
  const status = JSON.stringify({
    id: fake.projectId ?? PROJECT,
    name: "heartfelt-spontaneity",
    environments: {
      edges: [
        {
          node: {
            id: fake.environmentId ?? ENVIRONMENT,
            name: "production",
            serviceInstances: {
              edges: [{ node: { serviceId: fake.serviceId ?? SERVICE, serviceName: "bht-copilot" } }],
            },
            volumeInstances: {
              edges: maWolumen
                ? [{ node: { serviceId: fake.serviceId ?? SERVICE, mountPath: "/data", state: "READY", sizeMB: 10000 } }]
                : [],
            },
          },
        },
      ],
    },
  });
  const variables = JSON.stringify(fake.vars ?? {});

  writeFileSync(
    join(dir, "railway"),
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      `  status) cat <<'JSON'\n${status}\nJSON`,
      "  ;;",
      `  variable) cat <<'JSON'\n${variables}\nJSON`,
      "  ;;",
      "esac",
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(dir, "railway"), 0o755);

  const result = spawnSync("bash", [script, mode], {
    env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** Konfiguracja bez jednej zmiennej — do przypadków „brakuje dokładnie tego". */
function without(vars: Record<string, string>, name: string): Record<string, string> {
  const copy = { ...vars };
  delete copy[name];
  return copy;
}

const FULL_INBOUND = {
  MCP_BEARER_TOKEN: MCP_TOKEN,
  INBOX_ENABLED: "true",
  INBOX_STATE_DIR: "/data/inbox",
  INBOX_BACKFILL_MODE: "import",
  INBOX_EMAIL_ACCOUNTS: "sklep,biuro,hurt",
  INBOX_EMAIL_SKLEP_HOST: "x",
  INBOX_EMAIL_SKLEP_USER: "x",
  INBOX_EMAIL_SKLEP_PASSWORD: "x",
  INBOX_EMAIL_SKLEP_ADDRESS: "sklep@brownhouseandtea.pl",
  INBOX_EMAIL_BIURO_HOST: "x",
  INBOX_EMAIL_BIURO_USER: "x",
  INBOX_EMAIL_BIURO_PASSWORD: "x",
  INBOX_EMAIL_BIURO_ADDRESS: "biuro@brownhouseandtea.pl",
  INBOX_EMAIL_HURT_HOST: "x",
  INBOX_EMAIL_HURT_USER: "x",
  INBOX_EMAIL_HURT_PASSWORD: "x",
  INBOX_EMAIL_HURT_ADDRESS: "hurt@brownhouseandtea.pl",
};

/** Komplet dla wysyłki: Resend plus cztery ROZDZIELNE tokeny i origin TeaBrew. */
const FULL_OUTBOUND = {
  ...FULL_INBOUND,
  INBOX_RESEND_API_KEY: "re_x",
  INBOX_RESEND_WEBHOOK_SECRET: "whsec_x",
  MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: TRUSTED_TOKEN,
  CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: BRIDGE_TOKEN,
  TEABREW_AI_OPERATOR_REPLY_TOKEN: REPLY_TOKEN,
  TEABREW_AI_OPERATOR_TOKEN: READ_TOKEN,
  TEABREW_BASE_URL: "https://teabrew.example.pl",
};

/** MODE=live: config.ts woła req() na tych zmiennych już przy loadConfig. */
const FULL_LIVE = {
  ...FULL_INBOUND,
  MODE: "live",
  MAIL_IMAP_HOST: "imap.example.pl",
  MAIL_IMAP_USER: "operator@example.pl",
  MAIL_IMAP_PASSWORD: "x",
  TEABREW_BASE_URL: "https://teabrew.example.pl",
  TEABREW_AI_OPERATOR_TOKEN: READ_TOKEN,
};

describe("skladnia skryptu", () => {
  it("jest poprawna", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });
});

describe("bramka projektu, srodowiska i uslugi", () => {
  it("odrzuca ZLY projekt", () => {
    const result = run("inbound-preview", { projectId: "obcy-projekt", vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/nie BHT Copilot/i);
  });

  it("odrzuca ZLE srodowisko", () => {
    const result = run("inbound-preview", { environmentId: "staging", vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/srodowisko|środowisko/i);
  });

  it("odrzuca ZLA usluge — to bylo martwe sprawdzenie", () => {
    const result = run("inbound-preview", { serviceId: "inna-usluga", vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/usługa|usluga/i);
  });

  it("odrzuca brak trwalego wolumenu", () => {
    const result = run("inbound-preview", { volumes: "brak", vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/wolumen/i);
  });

  it("odrzuca stan poza wolumenem trwalym", () => {
    const result = run("inbound-preview", {
      vars: { ...FULL_INBOUND, INBOX_STATE_DIR: "/tmp/inbox", INBOX_BACKFILL_MODE: "preview" },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/INBOX_STATE_DIR/);
  });
});

describe("tryby", () => {
  it("nieznany tryb jest odrzucany", () => {
    const result = run("cokolwiek", { vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/Użycie|Uzycie/);
  });

  it("inbound-preview WYMAGA trybu podgladu", () => {
    const result = run("inbound-preview", { vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/podglądu|podgladu/i);
  });

  it("inbound-live wymaga jawnej aktywacji importu", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, INBOX_BACKFILL_MODE: "preview" },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/import/i);
  });

  it("inbound-live wymaga WSZYSTKICH trzech skrzynek", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, INBOX_EMAIL_ACCOUNTS: "sklep,biuro" },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/hurt/);
  });

  it("inbound-live przechodzi z kompletem", () => {
    const result = run("inbound-live", { vars: FULL_INBOUND });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/kompletna/i);
  });
});

describe("start procesu MCP", () => {
  it("odrzuca brak MCP_BEARER_TOKEN — bez niego serwer nie wstaje wcale", () => {
    const result = run("inbound-live", { vars: without(FULL_INBOUND, "MCP_BEARER_TOKEN") });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/MCP_BEARER_TOKEN/);
  });

  it("odrzuca MCP_BEARER_TOKEN krotszy niz 32 znaki", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, MCP_BEARER_TOKEN: token("krotki-", MIN_TOKEN_LENGTH - 1) },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/MCP_BEARER_TOKEN/);
  });

  it("przepuszcza MCP_BEARER_TOKEN o dlugosci dokladnie 32", () => {
    const exact = token("rowno-", MIN_TOKEN_LENGTH);
    expect(exact).toHaveLength(MIN_TOKEN_LENGTH);
    const result = run("inbound-live", { vars: { ...FULL_INBOUND, MCP_BEARER_TOKEN: exact } });
    expect(result.code, result.out).toBe(0);
  });

  it("odrzuca za krotki token firmowego czatu, choc jest opcjonalny", () => {
    const result = run("inbound-live", {
      vars: {
        ...FULL_INBOUND,
        MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: token("czat-", MIN_TOKEN_LENGTH - 1),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN/);
  });

  it("odrzuca token firmowego czatu rowny MCP_BEARER_TOKEN", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: MCP_TOKEN },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/IDENTYCZNE/);
  });

  it("odrzuca MODE spoza fixture|live", () => {
    const result = run("inbound-live", { vars: { ...FULL_INBOUND, MODE: "produkcja" } });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/MODE/);
  });

  it("MODE=live przechodzi z kompletem", () => {
    const result = run("inbound-live", { vars: FULL_LIVE });
    expect(result.code, result.out).toBe(0);
  });

  for (const name of [
    "MAIL_IMAP_HOST",
    "MAIL_IMAP_USER",
    "MAIL_IMAP_PASSWORD",
    "TEABREW_BASE_URL",
    "TEABREW_AI_OPERATOR_TOKEN",
  ]) {
    it(`MODE=live odrzuca brak ${name}`, () => {
      const result = run("inbound-live", { vars: without(FULL_LIVE, name) });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(name);
    });
  }

  it("MODE=fixture NIE wymaga zmiennych IMAP", () => {
    const result = run("inbound-live", { vars: { ...FULL_INBOUND, MODE: "fixture" } });
    expect(result.code, result.out).toBe(0);
  });

  it("odrzuca polowke pary planera marketingowego", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, MARKETING_PLANNER_BASE_URL: "https://marketing.example.pl" },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("MARKETING_PLANNER_TOKEN");
  });

  it("odrzuca polowke pary Budzecika", () => {
    const result = run("inbound-live", {
      vars: { ...FULL_INBOUND, BUDZECIK_COPILOT_TOKEN: token("budzecik-") },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("BUDZECIK_BASE_URL");
  });
});

describe("most odpowiedzi w trybie przychodzacym", () => {
  const PREVIEW = { ...FULL_INBOUND, INBOX_BACKFILL_MODE: "preview" };

  /*
   * Stan zastany produkcji: most odpowiedzi bywa WŁĄCZONY przez wcześniejszy
   * pilot Allegro (doręczenia przez TeaBrew, poza tym kanałem). Właściwa
   * granica bezpieczeństwa w trybach przychodzących: kanał generyczny nie może
   * mieć DOSTAWCY doręczeń (Resend / Graph API). Sam most = ostrzeżenie;
   * most + dostawca = twarda odmowa.
   */
  it("inbound-preview PRZEPUSZCZA sam most (pilot Allegro) z jawnym ostrzeżeniem", () => {
    const result = run("inbound-preview", {
      vars: {
        ...PREVIEW,
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: BRIDGE_TOKEN,
        TEABREW_AI_OPERATOR_REPLY_TOKEN: REPLY_TOKEN,
        TEABREW_BASE_URL: "https://teabrew.example.pl",
      },
    });
    expect(result.out).toContain("pilot odpowiedzi Allegro");
    expect(result.out).toContain("pisać nie może");
    expect(result.code).toBe(0);
  });

  it("inbound-preview odrzuca most RAZEM z kluczem Resend", () => {
    const result = run("inbound-preview", {
      vars: {
        ...PREVIEW,
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: BRIDGE_TOKEN,
        TEABREW_AI_OPERATOR_REPLY_TOKEN: REPLY_TOKEN,
        TEABREW_BASE_URL: "https://teabrew.example.pl",
        INBOX_RESEND_API_KEY: "re_klucz_testowy",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("INBOX_RESEND_API_KEY");
  });

  it("inbound-live odrzuca most RAZEM z tokenem Graph API konta Meta", () => {
    const result = run("inbound-live", {
      vars: {
        ...FULL_INBOUND,
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: BRIDGE_TOKEN,
        TEABREW_AI_OPERATOR_REPLY_TOKEN: REPLY_TOKEN,
        TEABREW_BASE_URL: "https://teabrew.example.pl",
        INBOX_META_ACCOUNTS: "ig",
        INBOX_META_IG_PROVIDER: "instagram",
        INBOX_META_IG_ID: "17840000000000000",
        INBOX_META_IG_PAGE_ID: "10150000000000000",
        INBOX_META_IG_TOKEN: "EAAGraphApiTokenTestowy1234567890",
        INBOX_META_APP_SECRET: "sekret-aplikacji-meta-testowy-123",
        INBOX_META_VERIFY_TOKEN: "verify-token-testowy-1234567890ab",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Graph API");
  });
});

describe("outbound-live", () => {
  it("odrzuca niekompletny outbound", () => {
    const result = run("outbound-live", { vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/INBOX_RESEND_API_KEY/);
  });

  it("przechodzi z pelnym kompletem", () => {
    const result = run("outbound-live", { vars: FULL_OUTBOUND });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/kompletna/i);
  });

  for (const name of [
    "INBOX_RESEND_API_KEY",
    "INBOX_RESEND_WEBHOOK_SECRET",
    "MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN",
    "CUSTOMER_CASE_REPLY_BRIDGE_TOKEN",
    "TEABREW_AI_OPERATOR_REPLY_TOKEN",
    "TEABREW_BASE_URL",
  ]) {
    it(`odrzuca brak ${name}`, () => {
      const result = run("outbound-live", { vars: without(FULL_OUTBOUND, name) });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(name);
    });
  }

  it("odrzuca token mostu krotszy niz 32 znaki", () => {
    const result = run("outbound-live", {
      vars: {
        ...FULL_OUTBOUND,
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: token("most-", MIN_TOKEN_LENGTH - 1),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("CUSTOMER_CASE_REPLY_BRIDGE_TOKEN");
  });

  it("przepuszcza token mostu o dlugosci dokladnie 32", () => {
    const exact = token("most-", MIN_TOKEN_LENGTH);
    expect(exact).toHaveLength(MIN_TOKEN_LENGTH);
    const result = run("outbound-live", {
      vars: { ...FULL_OUTBOUND, CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: exact },
    });
    expect(result.code, result.out).toBe(0);
  });

  // Wszystkie pary, ktore proces uznaje za blad (forbiddenReuse w mcp-http.ts).
  // Skrypt znal wczesniej JEDNA z nich, wiec szesc pozostalych przechodzilo.
  const ZAKAZANE_PARY: ReadonlyArray<readonly [string, string]> = [
    ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "MCP_BEARER_TOKEN"],
    ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN"],
    ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_TOKEN"],
    ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_REPLY_TOKEN"],
    ["TEABREW_AI_OPERATOR_REPLY_TOKEN", "MCP_BEARER_TOKEN"],
    ["TEABREW_AI_OPERATOR_REPLY_TOKEN", "MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN"],
    ["TEABREW_AI_OPERATOR_REPLY_TOKEN", "TEABREW_AI_OPERATOR_TOKEN"],
  ];

  for (const [left, right] of ZAKAZANE_PARY) {
    it(`odrzuca wspolna wartosc ${left} i ${right}`, () => {
      const shared = token("wspolny-");
      const result = run("outbound-live", {
        vars: { ...FULL_OUTBOUND, [left]: shared, [right]: shared },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/IDENTYCZNE/);
      expect(result.out).toContain(left);
      expect(result.out).toContain(right);
    });
  }

  for (const url of [
    "http://teabrew.example.pl",
    "https://teabrew.example.pl/api",
    "https://user:haslo@teabrew.example.pl",
    "https://teabrew.example.pl?token=1",
    "https://teabrew.example.pl#fragment",
    "teabrew.example.pl",
  ]) {
    it(`odrzuca TEABREW_BASE_URL o ksztalcie ${url}`, () => {
      const result = run("outbound-live", {
        vars: { ...FULL_OUTBOUND, TEABREW_BASE_URL: url },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("TEABREW_BASE_URL");
    });
  }

  it("przepuszcza origin HTTPS z portem", () => {
    const result = run("outbound-live", {
      vars: { ...FULL_OUTBOUND, TEABREW_BASE_URL: "https://teabrew.example.pl:8443" },
    });
    expect(result.code, result.out).toBe(0);
  });

  it("Instagram bez PAGE ID jest odrzucany", () => {
    const result = run("inbound-live", {
      vars: {
        ...FULL_INBOUND,
        INBOX_META_ACCOUNTS: "ig",
        INBOX_META_IG_PROVIDER: "instagram",
        INBOX_META_IG_ID: "ig-999",
        INBOX_META_IG_TOKEN: "t",
        INBOX_META_APP_SECRET: "s",
        INBOX_META_VERIFY_TOKEN: "v",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/PAGE_ID/);
  });
});

describe("prywatnosc", () => {
  const SEKRETY = {
    MCP_BEARER_TOKEN: token("TAJNY-MCP-", 44),
    MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: token("TAJNY-ODCZYT-", 44),
    CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: token("TAJNA-WYSYLKA-", 44),
    TEABREW_AI_OPERATOR_REPLY_TOKEN: token("TAJNA-ODPOWIEDZ-", 44),
    TEABREW_AI_OPERATOR_TOKEN: token("TAJNY-ODCZYT-ERP-", 44),
    INBOX_EMAIL_SKLEP_PASSWORD: "TAJNE-HASLO-SKLEPU",
    INBOX_RESEND_API_KEY: "re_TAJNY_KLUCZ",
    INBOX_RESEND_WEBHOOK_SECRET: "whsec_TAJNY",
    MAIL_IMAP_PASSWORD: "TAJNE-HASLO-IMAP",
  };

  function sprawdzBrakWyciekow(out: string): void {
    for (const secret of Object.values(SEKRETY)) {
      expect(out, `sekret ${secret} wyciekl do wyjscia`).not.toContain(secret);
    }
  }

  it("nie wypisuje ZADNEJ wartosci sekretu przy konfiguracji poprawnej", () => {
    const result = run("outbound-live", { vars: { ...FULL_OUTBOUND, ...SEKRETY } });
    expect(result.code, result.out).toBe(0);
    sprawdzBrakWyciekow(result.out);
  });

  it("nie wypisuje ZADNEJ wartosci sekretu przy konfiguracji odrzuconej", () => {
    const wspolny = SEKRETY.CUSTOMER_CASE_REPLY_BRIDGE_TOKEN;
    const result = run("outbound-live", {
      vars: {
        ...FULL_OUTBOUND,
        ...SEKRETY,
        MODE: "live",
        MAIL_IMAP_HOST: "imap.example.pl",
        MAIL_IMAP_USER: "operator@example.pl",
        TEABREW_AI_OPERATOR_REPLY_TOKEN: wspolny,
      },
    });
    expect(result.code).not.toBe(0);
    sprawdzBrakWyciekow(result.out);
  });
});
