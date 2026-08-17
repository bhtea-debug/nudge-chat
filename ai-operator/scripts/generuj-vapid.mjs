#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Klucze VAPID — tożsamość naszego serwera wobec bramki push.
 *
 * ── Dlaczego bez biblioteki ───────────────────────────────────────────────────
 * Pierwsza wersja importowała `web-push` i wywróciła się na maszynie właściciela:
 * `git pull` przynosi package.json, ale nie instaluje paczek, więc skrypt
 * wdrożeniowy padał na module, którego jeszcze nie ma. Kazanie właścicielowi
 * uruchomić `npm install` byłoby przerzuceniem mojego problemu na niego.
 *
 * Klucz VAPID to zwyczajna para kluczy P-256, a Node ma to wbudowane:
 *  - publiczny  = nieskompresowany punkt krzywej (0x04 ‖ X ‖ Y), 65 bajtów,
 *  - prywatny   = skalar, 32 bajty,
 * oba zapisane w base64url. Dokładnie tego oczekuje biblioteka wysyłająca.
 *
 * ── Czego ten skrypt nie robi ─────────────────────────────────────────────────
 * Nie wypisuje żadnej wartości. Nie nadpisuje istniejących kluczy — rotacja
 * unieważnia WSZYSTKIE subskrypcje, bo bramka wiąże subskrypcję urządzenia
 * z konkretnym kluczem publicznym. Właściciel musiałby wtedy włączyć
 * powiadomienia od nowa na każdym urządzeniu.
 */

const PLIK = new URL("../.env", import.meta.url).pathname;

let env = "";
try {
  env = readFileSync(PLIK, "utf8");
} catch {
  /* brak .env — utworzymy przez dopisanie */
}

const ma = (klucz) => new RegExp(`^${klucz}=.+$`, "m").test(env);

if (ma("VAPID_PUBLIC_KEY") && ma("VAPID_PRIVATE_KEY")) {
  process.stdout.write("klucze VAPID już są w .env (nie generuję nowych — unieważniłyby subskrypcje)\n");
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

/** Współrzędne krzywej P-256 mają dokładnie 32 bajty; dopełniamy z lewej. */
const na32 = (b64url) => {
  const b = Buffer.from(b64url, "base64url");
  return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
};

const publiczny = Buffer.concat([Buffer.from([0x04]), na32(pub.x), na32(pub.y)]).toString("base64url");
const prywatny = na32(priv.d).toString("base64url");

const bez = env
  .split("\n")
  .filter((l) => !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l))
  .join("\n")
  .replace(/\n+$/, "");

writeFileSync(PLIK, `${bez}\nVAPID_PUBLIC_KEY=${publiczny}\nVAPID_PRIVATE_KEY=${prywatny}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
chmodSync(PLIK, 0o600);

process.stdout.write("wygenerowane i zapisane w .env (wartości nigdzie nie wypisane)\n");
