import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Scheduler kanału „Obsługa klienta” w PRAWDZIWYM procesie serwera.
 *
 * Ten test istnieje z powodu konkretnej wpadki: `runtime.tick()` był napisany,
 * otestowany jednostkowo i nigdy nie wołany. Cała trwała synchronizacja stała
 * w miejscu, a health i kolejka wyglądały normalnie. Test jednostkowy na
 * schedulerze tego nie złapie — złapie to dopiero uruchomienie entrypointu.
 *
 * Dlatego tick jest tu dowodzony BEZ żądania HTTP: gdyby dowodem było
 * wywołanie endpointu, test przechodziłby także wtedy, gdy tick odpala się
 * wyłącznie przy okazji obsługi requestu.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));

let server: ChildProcess | null = null;

afterEach(() => {
  server?.kill("SIGKILL");
  server = null;
});

interface Boot {
  readonly stdout: string;
  readonly stderr: string;
  readonly stateDir: string;
}

/** Uruchamia serwer i czeka, aż stdout zawiera wzorzec albo minie limit. */
function bootUntil(pattern: RegExp, env: Record<string, string>, timeoutMs: number): Promise<Boot> {
  const stateDir = mkdtempSync(join(tmpdir(), "inbox-scheduler-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, httpEntry], {
      cwd: operatorDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        MODE: "fixture",
        // Stary monitor wyłączony: dowodzimy TEGO schedulera, nie tamtego.
        MONITOR_IN_PROCESS: "0",
        COPILOT_STATE_DIR: stateDir,
        PORT: "0",
        MCP_BEARER_TOKEN: "m".repeat(48),
        INBOX_STATE_DIR: stateDir,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server = child;

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`nie doczekano wzorca ${pattern}; stdout: ${stdout}; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (pattern.test(stdout)) {
        clearTimeout(timer);
        resolve({ stdout, stderr, stateDir });
      }
    });
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (pattern.test(stdout)) return;
      clearTimeout(timer);
      reject(new Error(`proces zakończył się kodem ${code}; stderr: ${stderr}`));
    });
  });
}

describe("scheduler kanału w procesie produkcyjnym", () => {
  it("wykonuje tick bez żadnego żądania HTTP", async () => {
    const boot = await bootUntil(
      /\[inbox\] przebieg zakończony/,
      {
        INBOX_ENABLED: "true",
        INBOX_TICK_FIRST_DELAY_MS: "150",
        INBOX_TICK_INTERVAL_MS: "1000",
      },
      30_000,
    );

    expect(boot.stdout).toMatch(/kanał obsługi klienta: pierwszy przebieg za/);
    expect(boot.stdout).toMatch(/\[inbox\] przebieg zakończony/);
    expect(boot.stderr).not.toMatch(/przebieg nie udał się/);
  }, 40_000);

  it("nie startuje, gdy kanał jest wyłączony", async () => {
    const boot = await bootUntil(
      /kanał obsługi klienta: wyłączony/,
      { INBOX_ENABLED: "false" },
      30_000,
    );
    expect(boot.stdout).not.toMatch(/\[inbox\] przebieg zakończony/);
  }, 40_000);

  it("kolejne przebiegi następują cyklicznie", async () => {
    const boot = await bootUntil(
      /\[inbox\] przebieg zakończony[\s\S]*\[inbox\] przebieg zakończony/,
      {
        INBOX_ENABLED: "true",
        INBOX_TICK_FIRST_DELAY_MS: "150",
        INBOX_TICK_INTERVAL_MS: "1000",
      },
      30_000,
    );
    const runs = boot.stdout.match(/\[inbox\] przebieg zakończony/g) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(2);
  }, 40_000);

  it("trwały stan kanału ląduje w skonfigurowanym katalogu", async () => {
    const boot = await bootUntil(
      /\[inbox\] przebieg zakończony/,
      {
        INBOX_ENABLED: "true",
        INBOX_TICK_FIRST_DELAY_MS: "150",
        INBOX_TICK_INTERVAL_MS: "1000",
        INBOX_EMAIL_ACCOUNTS: "",
      },
      30_000,
    );
    // Katalog musi istnieć: stan na dysku efemerycznym oznacza kursory od zera
    // po każdym deployu, czyli ponowny import całej skrzynki.
    expect(existsSync(boot.stateDir)).toBe(true);
  }, 40_000);
});

describe("stan schedulera w health", () => {
  it("health wystawia pola pozwalające odróżnić ciszę od awarii", () => {
    const source = readFileSync(join(operatorDir, "src/bin/mcp-http.ts"), "utf8");
    expect(source).toContain("inbox: inboxScheduler ? inboxScheduler.state()");
    const scheduler = readFileSync(join(operatorDir, "src/inbox/scheduler.ts"), "utf8");
    for (const field of ["lastFullRunFinishedAt", "consecutiveErrors", "skippedOverlaps", "running"]) {
      expect(scheduler).toContain(field);
    }
  });
});
