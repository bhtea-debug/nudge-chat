#!/usr/bin/env node
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import webpush from "web-push";

/**
 * Klucze VAPID — tożsamość naszego serwera wobec bramki push.
 *
 * Generowane RAZ i zapisywane do `.env`, nigdy nie wypisywane na ekran. Powód
 * jest ten sam co przy haśle i tokenie: każdy sekret, który pokazał się
 * w terminalu, prędzej czy później ląduje wklejony w rozmowie.
 *
 * **Rotacja unieważnia wszystkie subskrypcje.** Bramka push wiąże subskrypcję
 * urządzenia z konkretnym kluczem publicznym; po zmianie klucza stare
 * subskrypcje przestają przyjmować nasze wysyłki i właściciel musi włączyć
 * powiadomienia ponownie. Dlatego istniejących kluczy NIE nadpisujemy.
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

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

const bez = env
  .split("\n")
  .filter((l) => !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l))
  .join("\n")
  .replace(/\n+$/, "");

writeFileSync(
  PLIK,
  `${bez}\nVAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`,
  { encoding: "utf8", mode: 0o600 },
);
chmodSync(PLIK, 0o600);

// Ani jednej wartości na ekranie.
process.stdout.write("wygenerowane i zapisane w .env (wartości nigdzie nie wypisane)\n");
