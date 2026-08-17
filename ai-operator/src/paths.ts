import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ścieżki z konfiguracji liczymy od katalogu PAKIETU, nie od katalogu roboczego
 * procesu.
 *
 * Powód nie jest kosmetyczny. `AUDIT_FILE=./.audit/calls.jsonl` i
 * `FIXTURES_DIR=fixtures` działają, dopóki ktoś uruchamia to przez `npm run`
 * z katalogu ai-operator. Klient MCP uruchamiany z aplikacji graficznej startuje
 * proces z katalogiem roboczym `/` — wtedy ta sama konfiguracja oznacza
 * `/.audit/calls.jsonl` i `/fixtures`, czyli w pierwszym przypadku zapis do
 * woluminu systemowego (na macOS tylko do czytania), a w drugim brak fikstur.
 *
 * Ścieżka bezwzględna z konfiguracji jest zawsze respektowana bez zmian.
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function fromPackageRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(PACKAGE_ROOT, p);
}
