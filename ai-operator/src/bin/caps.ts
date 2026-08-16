#!/usr/bin/env tsx
import { createRegistryForProjections } from "../index.js";
import { toMarkdownTable, toToolDefinitions } from "../capability/projections.js";

/**
 * Spis capability widzianych przez agenta.
 *
 *   npm run caps            # tabela
 *   npm run caps -- --tools # definicje narzędzi dla function callingu
 */
const caps = createRegistryForProjections().list();

if (process.argv.includes("--tools")) {
  process.stdout.write(JSON.stringify(toToolDefinitions(caps), null, 2) + "\n");
} else {
  process.stdout.write(toMarkdownTable(caps) + "\n");
  const writes = caps.filter((c) => c.effectClass !== "read");
  process.stdout.write(
    `\nRazem: ${caps.length}. Capability zapisujących: ${writes.length}.\n`,
  );
}
