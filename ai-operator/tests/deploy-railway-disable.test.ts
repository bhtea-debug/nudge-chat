import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Wyłącznik awaryjny mostu odpowiedzi: `BHT_COPILOT_DISABLE_REPLY_ONLY=1`.
 *
 * Testy uruchamiają PRAWDZIWY `deploy-railway.sh` z atrapami `railway`
 * i `curl` na PATH. Wyłącznik, który wygląda na pewny i nie jest, daje
 * spokój dokładnie w chwili, w której wysyłka do klientów wciąż działa —
 * dlatego osobno sprawdzamy też przebiegi, w których CLI kłamie.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(operatorDir, "scripts/deploy-railway.sh");

const PROJECT = "bd311917-f3d7-419f-aeba-79bf5b4dafe4";
const ENVIRONMENT = "e8e60c09-4de2-4fb3-a11d-6e9048371e54";
const SERVICE = "c4a9c0ad-7c0e-4494-a16e-321e0e382b6c";
/** Wartość-wskaźnik: jeśli pojawi się w wyjściu skryptu, sekret wyciekł na ekran. */
const SEKRET = "SEKRET-MOSTU-NIE-DLA-EKRANU-xyz";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Atrapa {
  /** Stan zmiennych Railway na starcie. */
  readonly vars?: Record<string, string>;
  /** `variable set` melduje sukces, ale niczego nie zmienia. */
  readonly setKlamie?: boolean;
  /** `redeploy` kończy się błędem. */
  readonly redeployPada?: boolean;
  /** Treść, którą /health zwraca przez atrapę curl. */
  readonly health?: string;
  /** Nadpisanie identyfikatora projektu w `status --json`. */
  readonly projectId?: string;
}

function przygotuj(atrapa: Atrapa): { dir: string; log: string; varsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "railway-disable-"));
  dirs.push(dir);
  const log = join(dir, "wywolania.log");
  const varsFile = join(dir, "vars.json");
  writeFileSync(varsFile, JSON.stringify(atrapa.vars ?? {}));

  const status = JSON.stringify({
    id: atrapa.projectId ?? PROJECT,
    name: "heartfelt-spontaneity",
    environments: {
      edges: [
        {
          node: {
            id: ENVIRONMENT,
            name: "production",
            serviceInstances: {
              edges: [{ node: { serviceId: SERVICE, serviceName: "bht-copilot" } }],
            },
          },
        },
      ],
    },
  });

  writeFileSync(
    join(dir, "railway"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "railway $*" >> "${log}"`,
      'case "$1" in',
      "  whoami) echo tester; exit 0 ;;",
      `  status) cat <<'JSON'`,
      status,
      "JSON",
      "  exit 0 ;;",
      "  variable)",
      '    if [ "$2" = "list" ]; then',
      `      cat "${varsFile}"; exit 0`,
      "    fi",
      '    if [ "$2" = "set" ]; then',
      "      VALUE=$(cat)",
      `      if [ "\${FAKE_SET_KLAMIE:-0}" = "1" ]; then exit 0; fi`,
      `      KEY="$3" VALUE="$VALUE" node -e 'const fs=require("node:fs");const f=${JSON.stringify(varsFile)};const v=JSON.parse(fs.readFileSync(f,"utf8"));v[process.env.KEY]=process.env.VALUE;fs.writeFileSync(f,JSON.stringify(v));'`,
      "      exit 0",
      "    fi",
      "    exit 0 ;;",
      "  redeploy)",
      `    if [ "\${FAKE_REDEPLOY_PADA:-0}" = "1" ]; then echo "redeploy failed"; exit 1; fi`,
      "    exit 0 ;;",
      "  domain) echo 'stub-service.up.railway.app'; exit 0 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "railway"), 0o755);

  writeFileSync(
    join(dir, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "curl $*" >> "${log}"`,
      `printf '%s\\n' ${JSON.stringify(atrapa.health ?? '{"ok":true,"customerCaseReplyBridge":false}')}`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "curl"), 0o755);

  return { dir, log, varsFile };
}

function uruchom(
  atrapa: Atrapa,
  env: Record<string, string> = {},
): { code: number; out: string; log: string[]; vars: Record<string, string> } {
  const { dir, log, varsFile } = przygotuj(atrapa);
  const result = spawnSync("bash", [script], {
    cwd: operatorDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      BHT_COPILOT_PRODUCTION: "1",
      BHT_COPILOT_DISABLE_REPLY_ONLY: "1",
      BHT_COPILOT_HEALTH_PROBY: "1",
      FAKE_SET_KLAMIE: atrapa.setKlamie ? "1" : "0",
      FAKE_REDEPLOY_PADA: atrapa.redeployPada ? "1" : "0",
      ...env,
    },
  });
  let linie: string[] = [];
  try {
    linie = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    linie = [];
  }
  return {
    code: result.status ?? 1,
    out: `${result.stdout}\n${result.stderr}`,
    log: linie,
    vars: JSON.parse(readFileSync(varsFile, "utf8")) as Record<string, string>,
  };
}

const OBA_TOKENY = {
  CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: SEKRET,
  TEABREW_AI_OPERATOR_REPLY_TOKEN: `${SEKRET}-teabrew`,
};

describe("BHT_COPILOT_DISABLE_REPLY_ONLY", () => {
  it("wymaga trybu produkcyjnego", () => {
    const { dir } = przygotuj({});
    const result = spawnSync("bash", [script], {
      cwd: operatorDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        BHT_COPILOT_DISABLE_REPLY_ONLY: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("BHT_COPILOT_PRODUCTION=1");
  });

  it("wyklucza się z trybem konfiguracji tokenów", () => {
    const { dir } = przygotuj({});
    const result = spawnSync("bash", [script], {
      cwd: operatorDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        BHT_COPILOT_PRODUCTION: "1",
        BHT_COPILOT_DISABLE_REPLY_ONLY: "1",
        BHT_COPILOT_CONFIGURE_REPLY_ONLY: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("wykluczaja sie");
  });

  it("czyści oba tokeny, weryfikuje, restartuje i potwierdza w /health", () => {
    const wynik = uruchom({ vars: OBA_TOKENY });
    expect(wynik.out).toContain("WYŁĄCZONY");
    expect(wynik.code).toBe(0);
    expect(wynik.vars.CUSTOMER_CASE_REPLY_BRIDGE_TOKEN).toBe("");
    expect(wynik.vars.TEABREW_AI_OPERATOR_REPLY_TOKEN).toBe("");
    const zapis = wynik.log.join("\n");
    expect(zapis).toContain("variable set CUSTOMER_CASE_REPLY_BRIDGE_TOKEN");
    expect(zapis).toContain("variable set TEABREW_AI_OPERATOR_REPLY_TOKEN");
    // dokładny cel: projekt, środowisko i usługa przypięte przy każdym setterze
    for (const linia of wynik.log.filter((wpis) => wpis.includes("variable set"))) {
      expect(linia).toContain(`--project ${PROJECT}`);
      expect(linia).toContain(`--environment ${ENVIRONMENT}`);
      expect(linia).toContain(`--service ${SERVICE}`);
      expect(linia).toContain("--skip-deploys");
    }
    expect(zapis).toContain("redeploy");
    expect(zapis).not.toContain("railway up");
    expect(zapis).toContain("curl");
  });

  it("jest idempotentny: puste tokeny to sukces bez setterów", () => {
    const wynik = uruchom({
      vars: { CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: "", TEABREW_AI_OPERATOR_REPLY_TOKEN: "" },
    });
    expect(wynik.out).toContain("już są puste");
    expect(wynik.code).toBe(0);
    expect(wynik.log.join("\n")).not.toContain("variable set");
    expect(wynik.log.join("\n")).toContain("redeploy");
  });

  it("nigdy nie wypisuje wartości tokenów", () => {
    const wynik = uruchom({ vars: OBA_TOKENY });
    expect(wynik.code).toBe(0);
    expect(wynik.out).not.toContain(SEKRET);
  });

  it("melduje KRYTYCZNE i NIE restartuje, gdy czyszczenie nie weszło", () => {
    const wynik = uruchom({ vars: OBA_TOKENY, setKlamie: true });
    expect(wynik.code).toBe(1);
    expect(wynik.out).toContain("KRYTYCZNE");
    expect(wynik.out).toContain("AKTYWNA");
    expect(wynik.log.join("\n")).not.toContain("redeploy");
  });

  it("kończy błędem i mówi wprost, gdy restart się nie powiódł", () => {
    const wynik = uruchom({ vars: OBA_TOKENY, redeployPada: true });
    expect(wynik.code).toBe(1);
    expect(wynik.out).toContain("AKTYWNY do restartu");
    // tokeny mimo to wyczyszczone i zweryfikowane
    expect(wynik.vars.CUSTOMER_CASE_REPLY_BRIDGE_TOKEN).toBe("");
  });

  it("kończy błędem, gdy /health po restarcie nadal melduje aktywny most", () => {
    const wynik = uruchom({
      vars: OBA_TOKENY,
      health: '{"ok":true,"customerCaseReplyBridge":true}',
    });
    expect(wynik.code).toBe(1);
    expect(wynik.out).toContain("customerCaseReplyBridge=false");
  });

  it("odmawia przy niewłaściwym projekcie Railway i nie dotyka zmiennych", () => {
    const wynik = uruchom({ vars: OBA_TOKENY, projectId: "00000000-zly-projekt" });
    expect(wynik.code).toBe(1);
    expect(wynik.vars.CUSTOMER_CASE_REPLY_BRIDGE_TOKEN).toBe(SEKRET);
    expect(wynik.log.join("\n")).not.toContain("variable set");
  });
});
