#!/usr/bin/env tsx
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRegistryForProjections } from "../index.js";
import { toOpenApiDocument } from "../capability/projections.js";

/**
 * Generuje projekcję HTTP/OpenAPI z rejestru capability.
 *
 *   npm run openapi                 # na stdout
 *   npm run openapi -- openapi.json # do pliku
 *
 * Nie wymaga żadnego sekretu — działa w CI.
 */
const caps = createRegistryForProjections().list();
const doc = toOpenApiDocument(caps, {
  title: "inbox-operator — capability read-only",
  version: "0.1.0",
});
const json = JSON.stringify(doc, null, 2);

const out = process.argv[2];
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json + "\n", "utf8");
  process.stderr.write(`zapisano ${out} (${caps.length} capability)\n`);
} else {
  process.stdout.write(json + "\n");
}
