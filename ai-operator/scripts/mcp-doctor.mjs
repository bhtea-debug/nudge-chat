#!/usr/bin/env node
/**
 * Diagnostyka serwera MCP — odtwarza sposób, w jaki uruchamia go Claude Desktop.
 *
 *   node ai-operator/scripts/mcp-doctor.mjs
 *
 * Po co osobne narzędzie, skoro `npm run mcp` działa: bo `npm run` uruchamia
 * serwer w warunkach, których w aplikacji graficznej NIE MA. `npm run` daje
 * katalog roboczy ai-operator, pełne PATH i zmienne wyeksportowane w shellu.
 * Claude Desktop nie daje żadnej z tych trzech rzeczy. Serwer, który wstaje pod
 * `npm run` i nie wstaje pod Claude Desktop, to norma, nie wyjątek — a jedyny
 * komunikat, jaki wtedy widać, to „Server disconnected".
 *
 * Skrypt robi dwa przebiegi:
 *   1. DOKŁADNIE jak w zainstalowanej konfiguracji (z jej `cwd`),
 *   2. WROGO: katalog roboczy `/` i minimalne środowisko — tak jak proces
 *      startowany z aplikacji graficznej.
 *
 * Przebieg 2 wykrywa zależność od katalogu roboczego, czyli najczęstszą
 * przyczynę. Jeśli 1 przechodzi, a 2 nie — winna jest ścieżka relatywna.
 *
 * Nie czyta i nie wypisuje sekretów. Serwer wczytuje je sam, po swojej stronie.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const operatorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30_000;

const configFile =
  process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(configFile)) {
  die(
    `Nie ma ${configFile}\nUruchom najpierw:  cd ${operatorDir} && npm run mcp:install`,
  );
}

let entry;
try {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  entry = cfg?.mcpServers?.["bht-operator"];
} catch (err) {
  die(`${configFile} nie jest poprawnym JSON-em: ${err.message}`);
}
if (!entry) {
  die(`W ${configFile} nie ma wpisu "bht-operator".\nUruchom:  cd ${operatorDir} && npm run mcp:install`);
}

console.log(`konfiguracja:  ${configFile}`);
console.log(`polecenie:     ${entry.command}`);
console.log(`argumenty:     ${(entry.args ?? []).join(" ")}`);
console.log(`cwd we wpisie: ${entry.cwd ?? "(brak)"}`);

// Ścieżki z konfiguracji muszą istnieć — wpis wskazujący nieistniejący plik
// wygląda w kliencie identycznie jak zepsuty serwer.
const missing = [entry.command, ...(entry.args ?? [])]
  .filter((a) => typeof a === "string" && a.startsWith("/") && !a.includes("="))
  .filter((p) => !existsSync(p));
if (missing.length > 0) {
  die(`Te ścieżki z konfiguracji NIE ISTNIEJĄ:\n  ${missing.join("\n  ")}`);
}

/** Jeden przebieg: uruchom serwer, przeprowadź handshake, policz narzędzia. */
function probe({ label, cwd, env }) {
  return new Promise((done) => {
    const child = spawn(entry.command, entry.args ?? [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      done({ label, stderr: err.trim(), ...result });
    };
    const timer = setTimeout(() => finish({ verdict: "timeout" }), TIMEOUT_MS);

    child.on("error", (e) => finish({ verdict: "spawn-failed", detail: e.message }));
    child.on("exit", (code, signal) => {
      if (settled) return;
      finish({ verdict: "died", detail: signal ? `sygnał ${signal}` : `kod wyjścia ${code}` });
    });

    child.stderr.on("data", (b) => (err += b.toString()));
    child.stdout.on("data", (b) => {
      out += b.toString();
      for (const line of out.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          finish({ verdict: "not-json", detail: line.slice(0, 200) });
          return;
        }
        if (msg.id === 2) {
          if (msg.error) finish({ verdict: "error", detail: msg.error.message });
          else finish({ verdict: "ok", tools: (msg.result?.tools ?? []).map((t) => t.name) });
          return;
        }
      }
      out = out.slice(out.lastIndexOf("\n") + 1);
    });

    const say = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-doctor", version: "1" },
      },
    });
    say({ jsonrpc: "2.0", method: "notifications/initialized" });
    say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

function report(r) {
  console.log(`\n── ${r.label} ${"─".repeat(Math.max(0, 60 - r.label.length))}`);
  if (r.verdict === "ok") {
    console.log(`✓ handshake OK, narzędzi: ${r.tools.length}`);
    console.log(`  ${r.tools.join(", ")}`);
  } else {
    const why = {
      timeout: `serwer nie odpowiedział w ${TIMEOUT_MS / 1000}s`,
      died: "proces zakończył się przed odpowiedzią",
      "spawn-failed": "nie udało się uruchomić polecenia",
      "not-json": "serwer wypisał na stdout coś, co nie jest JSON-RPC",
      error: "serwer odpowiedział błędem",
    }[r.verdict];
    console.log(`✗ ${why}${r.detail ? `: ${r.detail}` : ""}`);
  }
  if (r.stderr) {
    console.log("  stderr serwera:");
    for (const line of r.stderr.split("\n").slice(0, 20)) console.log(`    ${line}`);
  }
  return r.verdict === "ok";
}

const asConfigured = await probe({
  label: "1. dokładnie jak w konfiguracji",
  cwd: entry.cwd ?? process.cwd(),
  env: { ...process.env, ...(entry.env ?? {}) },
});
const okConfigured = report(asConfigured);

const hostile = await probe({
  label: "2. jak z aplikacji graficznej (cwd=/, minimalne env)",
  cwd: "/",
  env: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    ...(entry.env ?? {}),
  },
});
const okHostile = report(hostile);

console.log(`\n${"═".repeat(64)}`);
if (okConfigured && okHostile) {
  console.log(`
✓ Serwer wstaje w obu warunkach.

Jeśli Claude Desktop nadal pokazuje „Server disconnected":
  1. Zamknij aplikację całkowicie (Cmd+Q, nie samo okno) i otwórz ponownie.
  2. Zajrzyj do logu klienta:
     tail -50 ~/Library/Logs/Claude/mcp-server-bht-operator.log
`);
} else if (okConfigured && !okHostile) {
  console.log(`
✗ Serwer wstaje z właściwym katalogiem roboczym, ale NIE wstaje bez niego.

To znaczy, że coś w konfiguracji jest ścieżką relatywną — a Claude Desktop
uruchamia proces z katalogiem roboczym /. Popraw AUDIT_FILE / FIXTURES_DIR
w ${join(operatorDir, ".env")} na ścieżki bezwzględne
albo usuń te wpisy (kod liczy je wtedy od katalogu pakietu).
`);
} else {
  console.log(`
✗ Serwer nie wstaje. Komunikat ze stderr powyżej jest przyczyną — nie „Server
disconnected", które widzisz w aplikacji.

Najczęstsze przypadki:
  brak zmiennej środowiskowej X   → uzupełnij ${join(operatorDir, ".env")}
  EACCES / EROFS                  → ścieżka relatywna w AUDIT_FILE
  Cannot find module              → cd ${operatorDir} && npm install
`);
}
process.exit(okConfigured && okHostile ? 0 : 1);
