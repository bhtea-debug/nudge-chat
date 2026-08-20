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

/**
 * Ile narzędzi publikuje MCP: istniejące narzędzia + 4 odczyty spraw Allegro.
 * Trzymane w jednym miejscu, bo ta liczba rośnie i rozjazd w dwóch testach
 * kosztowałby więcej niż stała.
 */
const EXPECTED_TOOLS = 22;

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
    expect(r.tools.result.tools).toHaveLength(EXPECTED_TOOLS);
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
    expect(r.tools.result.tools).toHaveLength(EXPECTED_TOOLS);
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

/**
 * Start serwera HTTP — trzy konfiguracje, trzy różne poprawne zachowania.
 *
 * Test istnieje, bo pierwsza wersja wymagała `MCP_BEARER_TOKEN` do startu CAŁEGO
 * procesu i właściciel, chcąc uruchomić u siebie sam interfejs, dostał odmowę
 * startu z powodu tokenu do funkcji, której nie zamierzał włączać. To była zła
 * odmiana fail-closed: wyłączyła produkt zamiast wyłączyć powierzchnię bez bramy.
 *
 * Uruchamiamy PRAWDZIWY proces, bo o tej klasie usterek decyduje kod wykonywany
 * przy starcie, a nie kod wywoływany z testu.
 */
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));

interface Boot {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: (path: string) => Promise<number>;
}

async function boot(env: Record<string, string>, port: number): Promise<Boot> {
  const child = spawn(process.execPath, [tsxCli, httpEntry], {
    cwd: operatorDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MODE: "fixture",
      MONITOR_IN_PROCESS: "0",
      COPILOT_STATE_DIR: join(tmpdir(), `bht-boot-${port}`),
      PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 12_000);
    // Serwer, który wstał, nie zakończy się sam — czekamy albo na wyjście,
    // albo na moment, w którym odpowiada na /health.
    const poll = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        clearInterval(poll);
        clearTimeout(timer);
        resolve(null);
      } catch {
        /* jeszcze nie wstał */
      }
    }, 250);
    child.on("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(code);
    });
  });

  const status = async (path: string): Promise<number> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "{}" });
    return res.status;
  };
  return { stdout, stderr, exitCode, status: async (p) => {
    try {
      return await status(p);
    } finally {
      child.kill();
    }
  } };
}

describe("start serwera HTTP", () => {
  const TOKEN = "x".repeat(48);

  it("z tokenem wstaje i wystawia narzędzia dla Claude", async () => {
    const b = await boot({ MCP_BEARER_TOKEN: TOKEN }, 8841);
    expect(b.exitCode).toBeNull();
    expect(b.stdout).toContain(`narzędzia dla Claude: ${EXPECTED_TOOLS}`);
    // Bez nagłówka Authorization nie ma dostępu do niczego.
    expect(await b.status("/mcp")).toBe(401);
  }, 20_000);

  it("token ustawiony PO CZĘŚCI nie wstaje — wygląda na zabezpieczenie, którym nie jest", async () => {
    const b = await boot({ MCP_BEARER_TOKEN: "krotki" }, 8842);
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("za krótki");
  }, 20_000);

  it("odrzuca współdzielenie tokenu modelu z principal-em firmowego czatu", async () => {
    const b = await boot({
      MCP_BEARER_TOKEN: TOKEN,
      MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN: TOKEN,
    }, 8844);
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("musi być inny");
  }, 20_000);

  it("bez tokenu nie wstaje wcale — Claude jest jedynym interfejsem", async () => {
    // Monitor bez wystawionego MCP zbierałby dane, których nikt nie zobaczy.
    const b = await boot({}, 8843);
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("nie mam czego uruchomić");
    expect(b.stderr).toContain("MCP_BEARER_TOKEN");
  }, 20_000);
});
