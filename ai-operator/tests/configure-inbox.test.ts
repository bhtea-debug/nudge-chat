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
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(operatorDir, "scripts/configure-inbox.sh");

const PROJECT = "bd311917-f3d7-419f-aeba-79bf5b4dafe4";
const ENVIRONMENT = "e8e60c09-4de2-4fb3-a11d-6e9048371e54";
const SERVICE = "c4a9c0ad-7c0e-4494-a16e-321e0e382b6c";

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

  const status = JSON.stringify({
    id: fake.projectId ?? PROJECT,
    environment: { id: fake.environmentId ?? ENVIRONMENT },
  });
  const service = JSON.stringify({ id: fake.serviceId ?? SERVICE });
  const variables = Object.entries(fake.vars ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  writeFileSync(
    join(dir, "railway"),
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      `  status) cat <<'JSON'\n${status}\nJSON`,
      "  ;;",
      `  service) cat <<'JSON'\n${service}\nJSON`,
      "  ;;",
      `  volume) printf '%s\\n' ${JSON.stringify(fake.volumes ?? "/data")}`,
      "  ;;",
      `  variables) cat <<'KV'\n${variables}\nKV`,
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

const FULL_INBOUND = {
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

describe("outbound-live", () => {
  it("odrzuca niekompletny outbound", () => {
    const result = run("outbound-live", { vars: FULL_INBOUND });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/INBOX_RESEND_API_KEY/);
  });

  it("odrzuca WSPOLNY token odczytu i wysylki", () => {
    const result = run("outbound-live", {
      vars: {
        ...FULL_INBOUND,
        INBOX_RESEND_API_KEY: "re_x",
        INBOX_RESEND_WEBHOOK_SECRET: "whsec_x",
        MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: "ten-sam-token",
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: "ten-sam-token",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/IDENTYCZNE/);
  });

  it("przechodzi z rozdzielnymi tokenami", () => {
    const result = run("outbound-live", {
      vars: {
        ...FULL_INBOUND,
        INBOX_RESEND_API_KEY: "re_x",
        INBOX_RESEND_WEBHOOK_SECRET: "whsec_x",
        MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: "token-odczytu",
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: "token-wysylki",
      },
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
  it("nie wypisuje ZADNEJ wartosci sekretu", () => {
    const result = run("outbound-live", {
      vars: {
        ...FULL_INBOUND,
        INBOX_EMAIL_SKLEP_PASSWORD: "TAJNE-HASLO-SKLEPU",
        INBOX_RESEND_API_KEY: "re_TAJNY_KLUCZ",
        INBOX_RESEND_WEBHOOK_SECRET: "whsec_TAJNY",
        MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: "TAJNY-ODCZYT",
        CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: "TAJNA-WYSYLKA",
      },
    });
    for (const secret of [
      "TAJNE-HASLO-SKLEPU",
      "re_TAJNY_KLUCZ",
      "whsec_TAJNY",
      "TAJNY-ODCZYT",
      "TAJNA-WYSYLKA",
    ]) {
      expect(result.out, `sekret ${secret} wyciekl do wyjscia`).not.toContain(secret);
    }
  });
});
