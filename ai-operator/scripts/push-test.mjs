#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Wysłanie prawdziwego powiadomienia na urządzenia właściciela.
 *
 *   npm run push:test
 *   npm run push:test -- "Pilne — Rossmann" "Klient pyta o termin." pilne
 *
 * Hasło czytamy z `.env` i **nigdy go nie wypisujemy** — właściciel nie ma go
 * ani szukać, ani kopiować, bo każdy sekret, który przeszedł przez ekran,
 * prędzej czy później ląduje wklejony w rozmowie.
 *
 * To narzędzie NIE decyduje, co jest warte powiadomienia. Treść podaje człowiek.
 * Dobór spraw jest osobnym problemem i — jak pokazał spike UX — trudniejszym
 * niż samo dostarczenie.
 */

const PLIK = new URL("../.env", import.meta.url).pathname;

let env = "";
try {
  env = readFileSync(PLIK, "utf8");
} catch {
  process.stderr.write("Nie ma pliku .env — nie wiem, dokąd wysłać ani jakim hasłem.\n");
  process.exit(1);
}

const zEnv = (klucz) => new RegExp(`^${klucz}=(.+)$`, "m").exec(env)?.[1]?.trim() ?? "";

const haslo = zEnv("COPILOT_AUTH_PASSWORD");
const adres = zEnv("COPILOT_PUBLIC_URL").replace(/\/+$/, "");

if (!adres) {
  process.stderr.write(
    "Brak COPILOT_PUBLIC_URL w .env — zapisuje go `npm run wdroz`.\n" +
      "Możesz też podać adres ręcznie: PUSH_URL=https://… npm run push:test\n",
  );
}
const baza = (process.env.PUSH_URL ?? adres).replace(/\/+$/, "");
if (!baza) process.exit(1);

if (!haslo) {
  process.stderr.write("Brak COPILOT_AUTH_PASSWORD w .env.\n");
  process.exit(1);
}

const [tytul, tresc, waga] = process.argv.slice(2);

const alert = {
  haslo,
  tytul: tytul || "Pilne — Rossmann",
  tresc: tresc || "Klient pyta o termin zamówienia. Sprawa wymaga sprawdzenia dzisiaj.",
  waga: waga || "pilne",
};

process.stdout.write(`Wysyłam na ${baza}\n  ${alert.tytul}\n  ${alert.tresc}\n\n`);

const odp = await fetch(`${baza}/push/test`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(alert),
});

const wynik = await odp.json().catch(() => ({}));

if (odp.status === 200) {
  process.stdout.write(`✓ wysłane na ${wynik.wyslane} urządzenie(a)\n`);
  if (wynik.usuniete) process.stdout.write(`  (${wynik.usuniete} martwych subskrypcji skasowano)\n`);
  process.stdout.write(
    "\nSpójrz na telefon. Jeśli nic nie przyszło, powiedz to wprost:\n" +
      "„wysłane” znaczy tylko, że bramka push przyjęła — nie, że zobaczyłeś.\n",
  );
  process.exit(0);
}

if (odp.status === 409) {
  process.stderr.write("✗ Żadne urządzenie nie ma włączonych powiadomień.\n");
  process.stderr.write(`  Wejdź na telefonie: ${baza}/push\n`);
  process.exit(1);
}

if (odp.status === 401) {
  process.stderr.write("✗ Serwer nie przyjął hasła z .env — czy na Railwayu jest to samo?\n");
  process.exit(1);
}

process.stderr.write(`✗ HTTP ${odp.status}: ${JSON.stringify(wynik)}\n`);
process.exit(1);
