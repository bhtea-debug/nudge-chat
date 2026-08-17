import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Serwer MCP uruchamiany z aplikacji graficznej NIE dostaje tego, co daje
 * `npm run`: katalog roboczy to `/`, a środowisko nie ma nic z shella.
 *
 * Te testy uruchamiają prawdziwy `src/bin/mcp.ts` w takich właśnie warunkach,
 * bo dokładnie tam się wywracał — a pod `npm run mcp` wstawał bez zarzutu.
 * Jedyny komunikat, jaki wtedy widzi człowiek, to „Server disconnected", więc
 * regresja tutaj jest kosztowna i nie może zostać złapana przez test jednostkowy
 * na module, który przy imporcie robi robotę.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const entry = fileURLToPath(new URL("../src/bin/mcp.ts", import.meta.url));

interface Handshake {
  /** Odpowiedź na `initialize` — musi przyjść ZAWSZE, także przy zepsutej konfiguracji. */
  initialize: any;
  /** Odpowiedź na `tools/list`. */
  tools: any;
  stderr: string;
  exitCode: number | null;
}

/**
 * Uruchamia serwer w podanym katalogu i środowisku, przeprowadza handshake,
 * zamyka stdin i zwraca to, co serwer odpowiedział.
 */
function handshake(cwd: string, env: Record<string, string>): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd,
      // Celowo BEZ process.env: chodzi o proces bez dziedziczonego środowiska.
      env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const replies = new Map<number, any>();
    let out = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serwer nie odpowiedział w 30s; stderr: ${stderr}`));
    }, 30_000);

    child.stderr.on("data", (b) => (stderr += String(b)));
    child.stdout.on("data", (b) => {
      out += String(b);
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) replies.set(JSON.parse(line).id, JSON.parse(line));
      }
      // Mamy obie odpowiedzi — kończymy sesję jak prawdziwy klient.
      if (replies.has(1) && replies.has(2)) child.stdin.end();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        initialize: replies.get(1),
        tools: replies.get(2),
        stderr,
        exitCode: code,
      });
    });

    const say = (o: unknown): void => {
      child.stdin.write(JSON.stringify(o) + "\n");
    };
    say({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    say({ jsonrpc: "2.0", method: "notifications/initialized" });
    say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

describe("serwer MCP wstaje w warunkach aplikacji graficznej", () => {
  it("działa z obcego katalogu roboczego — ścieżki liczone od pakietu, nie od cwd", async () => {
    // AUDIT_FILE i FIXTURES_DIR są w .env.example relatywne. Gdyby kod liczył je
    // od cwd, ten test padłby na mkdirSync("/tmp/.audit") albo na braku fikstur.
    const r = await handshake(tmpdir(), {
      MODE: "fixture",
      AUDIT_FILE: "./.audit/test-cwd.jsonl",
      FIXTURES_DIR: "fixtures",
    });

    expect(r.initialize?.result?.serverInfo?.name).toBe("bht-operator");
    expect(r.tools?.error, `tools/list zwróciło błąd; stderr: ${r.stderr}`).toBeUndefined();
    expect(r.tools.result.tools).toHaveLength(7);
    expect(r.exitCode).toBe(0);
  }, 40_000);

  it("nie umiera, gdy nie może pisać trwałego audytu — degraduje do pamięci", async () => {
    // Katalog "wewnątrz" istniejącego PLIKU — mkdirSync kończy się ENOTDIR
    // natychmiast i identycznie na macOS i Linuksie. Wcześniej rzut z
    // konstruktora MemoryAuditSink zabijał proces PRZED handshake.
    const r = await handshake(operatorDir, {
      MODE: "fixture",
      AUDIT_FILE: join(operatorDir, "package.json", "audyt", "calls.jsonl"),
    });

    expect(r.initialize?.result?.serverInfo?.name).toBe("bht-operator");
    expect(r.tools.result.tools).toHaveLength(7);
    // Utrata trwałego logu nie może być cicha.
    expect(r.stderr).toContain("[audit]");
  }, 40_000);

  it("przy zepsutej konfiguracji odpowiada na initialize i MÓWI, czego brakuje", async () => {
    // MODE=live bez zmiennych poczty. Kiedyś: proces padał, klient pokazywał
    // „Server disconnected" i nie było z czego wywnioskować przyczyny.
    const r = await handshake(operatorDir, { MODE: "live" });

    expect(r.initialize?.result?.serverInfo?.name).toBe("bht-operator");
    // Błąd, nie pusta lista: pusta lista znaczyłaby „nie ma narzędzi".
    expect(r.tools?.result).toBeUndefined();
    expect(r.tools.error.message).toContain("MAIL_IMAP_HOST");
    expect(r.stderr).toContain("MAIL_IMAP_HOST");
  }, 40_000);
});
