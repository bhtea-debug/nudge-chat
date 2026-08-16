#!/usr/bin/env node
/**
 * Wpisuje serwer MCP `bht-operator` do konfiguracji Claude Desktop.
 *
 *   node ai-operator/scripts/install-claude-desktop-config.mjs
 *
 * Trzy rzeczy, które ten skrypt robi, a ręczna edycja łatwo psuje:
 *
 * 1. SCALA, nie nadpisuje. Jeśli masz już inne serwery MCP, zostają.
 * 2. Używa ABSOLUTNEJ ścieżki do node i do tsx, nie `npx`. Aplikacje GUI na
 *    macOS nie dziedziczą PATH z shella, więc `npx` bywa dla Claude Desktop
 *    niewidoczne — i to jest najczęstsza przyczyna serwera MCP, który „się nie
 *    podłącza" bez żadnego sensownego komunikatu.
 * 3. Sprawdza, że pliki naprawdę istnieją, ZANIM cokolwiek zapisze. Wpis
 *    wskazujący nieistniejącą ścieżkę wygląda w Claude Desktop identycznie jak
 *    zepsuty serwer.
 *
 * Nie zapisuje żadnego sekretu. Serwer czyta je z `.env` po swojej stronie.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const operatorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(operatorDir, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(operatorDir, "src", "bin", "mcp.ts");
const envFile = join(operatorDir, ".env");

function fail(message) {
  console.error(`\n[bht-operator] ${message}\n`);
  process.exit(1);
}

if (!existsSync(tsxCli)) {
  fail(`Nie ma ${tsxCli}\nUruchom najpierw: cd ${operatorDir} && npm install`);
}
if (!existsSync(entry)) fail(`Nie ma ${entry}`);
if (!existsSync(envFile)) {
  console.warn(
    `[bht-operator] Uwaga: nie ma ${envFile}.\n` +
      "Serwer wstanie, ale w trybie fixture. Do prawdziwych danych uruchom:\n" +
      `  cd ${operatorDir} && bash scripts/live-setup.sh\n`,
  );
}

// Ścieżka konfiguracji Claude Desktop. Katalog powstaje razem z aplikacją,
// ale sam plik dopiero przy pierwszej konfiguracji — dlatego mkdirSync.
const configDir =
  process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude")
    : join(homedir(), "Library", "Application Support", "Claude");
const configFile = join(configDir, "claude_desktop_config.json");

mkdirSync(configDir, { recursive: true });

let config = {};
if (existsSync(configFile)) {
  const raw = readFileSync(configFile, "utf8").trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      // Nie nadpisujemy pliku, którego nie rozumiemy — mógłby zawierać
      // konfigurację, której odtworzenie kosztowałoby człowieka czas.
      fail(
        `${configFile} istnieje, ale nie jest poprawnym JSON-em.\n` +
          "Popraw go albo usuń, i uruchom skrypt ponownie. Nic nie zmieniłem.",
      );
    }
  }
}

config.mcpServers = config.mcpServers ?? {};
const existed = Object.prototype.hasOwnProperty.call(config.mcpServers, "bht-operator");

config.mcpServers["bht-operator"] = {
  command: process.execPath,
  args: [tsxCli, `--env-file-if-exists=${envFile}`, entry],
  cwd: operatorDir,
};

writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

const others = Object.keys(config.mcpServers).filter((n) => n !== "bht-operator");
console.log(`
[bht-operator] ${existed ? "Zaktualizowano" : "Dodano"} serwer MCP.

  plik:  ${configFile}
  node:  ${process.execPath}
  katalog serwera: ${operatorDir}
${others.length > 0 ? `  inne serwery zachowane: ${others.join(", ")}` : "  innych serwerów nie było"}

Teraz ZRESTARTUJ Claude Desktop (całkowicie, nie tylko okno) i zapytaj:

  Co ważnego przyszło dzisiaj na moją pocztę?

Jeśli Claude nie widzi narzędzi, sprawdź w aplikacji:
Settings → Developer — powinien tam być "bht-operator" ze statusem połączenia.
`);
