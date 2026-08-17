#!/usr/bin/env tsx
import { ConnecteamClient } from "../connecteam/client.js";

/**
 * Sprawdzenie, co konto Connecteam FAKTYCZNIE udostępnia.
 *
 *   npm run check:connecteam
 *
 * Po co osobne narzędzie, zamiast wpisania w dokumentacji „API pozwala na X":
 * publiczna dokumentacja mówi o możliwościach produktu, a nie o tym, co ma
 * włączone konkretna firma na konkretnym planie, z konkretnym kluczem i z Betami
 * włączanymi per firma. Różnica jest tu decydująca — od niej zależy, czy
 * Connecteam zasila sprawy, czy nie.
 *
 * Narzędzie NICZEGO nie zapisuje w Connecteam. Nie tworzy webhooka, nie wysyła
 * wiadomości, nie zmienia ustawień. Wyłącznie pyta i raportuje.
 */

const key = process.env["CONNECTEAM_API_KEY"]?.trim();

if (!key) {
  process.stdout.write(
    "Brak CONNECTEAM_API_KEY.\n\n" +
      "Klucz pobierz w Connecteam: Settings → API Keys → Add API key.\n" +
      "Wymaga planu Expert lub wyższego.\n\n" +
      "Wpisz go do pliku .env (NIE w rozmowie, NIE w kodzie):\n" +
      "  echo 'CONNECTEAM_API_KEY=twoj-klucz' >> ai-operator/.env\n",
  );
  process.exit(2);
}

const client = new ConnecteamClient(key);

const p = await client.probe();
const out: string[] = [];
const tick = (v: boolean | null): string => (v === true ? "✓" : v === false ? "✗" : "?");

out.push("Connecteam — co to konto faktycznie udostępnia\n");
out.push(`${tick(p.authOk)} Klucz API działa${p.accountName ? ` — konto: ${p.accountName}` : ""}`);

if (p.authOk) {
  out.push(
    `${tick(p.canListConversations)} Lista czatów zespołowych i kanałów` +
      (p.conversationCount !== null ? ` — ${p.conversationCount}` : ""),
  );
  out.push(`${tick(p.canReadMessages)} ODCZYT TREŚCI WIADOMOŚCI  ← to jest pytanie rozstrzygające`);
  for (const a of p.readAttempts) {
    out.push(`      ${a.path} → ${a.status}`);
  }
  out.push(`${tick(p.webhooksAvailable)} API webhooków`);
  if (p.webhookEventTypes.length > 0) {
    out.push(`      skonfigurowane zdarzenia: ${p.webhookEventTypes.join(", ")}`);
  }
  out.push(`${tick(p.chatWebhookAvailable)} Webhook na nową wiadomość czatu`);
}

if (p.notes.length > 0) {
  out.push("\nCzego to NIE rozstrzyga:");
  for (const n of p.notes) out.push(`  · ${n}`);
}

out.push("\n── Co z tego wynika ─────────────────────────────────────────────");
if (!p.authOk) {
  out.push(
    "Nie mogę sprawdzić niczego dalej. Najpierw musi działać klucz — sprawdź plan konta\n" +
      "(wymagany Expert lub wyżej) i czy klucz nie został wyłączony.",
  );
} else if (p.canReadMessages) {
  out.push(
    "Odczyt wiadomości DZIAŁA. Connecteam może zasilać sprawy przez odpytywanie,\n" +
      "a webhook (jeśli dostępny) będzie tylko szybszą drogą do tego samego.",
  );
} else if (p.chatWebhookAvailable) {
  out.push(
    "Odczytu na żądanie nie ma, ale jest webhook czatu — i to wystarcza.\n" +
      "Wiadomości będą wpadać do spraw w momencie napisania, bez odpytywania.",
  );
} else {
  out.push(
    "Ani odczytu wiadomości, ani webhooka czatu. To znaczy, że Connecteam NIE MOŻE\n" +
      "dziś zasilać spraw treścią — i produkt musi to mówić wprost, zamiast pokazywać\n" +
      "pustą sekcję, która wygląda jak „nic nie napisano”.\n\n" +
      "Jedyna droga, jaką znam, prowadzi przez pytanie do Connecteam, czy dla Twojej firmy\n" +
      "da się włączyć webhooki czatu. Scrapingu i odtwarzania prywatnego API nie zrobię\n" +
      "bez Twojej wyraźnej zgody — taka integracja psuje się cicho przy każdej zmianie\n" +
      "u dostawcy, a psuje się w sposób nieodróżnialny od „nikt nic nie napisał”.",
  );
}

process.stdout.write(out.join("\n") + "\n");
await client.close();
// Kod wyjścia mówi o pytaniu rozstrzygającym, żeby dało się to wpiąć w skrypt.
process.exit(p.canReadMessages || p.chatWebhookAvailable ? 0 : 1);
