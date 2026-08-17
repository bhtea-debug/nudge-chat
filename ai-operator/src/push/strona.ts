import { deflateSync } from "node:zlib";
import { crc32 } from "node:zlib";

/**
 * Odbiornik powiadomień. **To nie jest interfejs produktu.**
 *
 * Właściciel zamknął temat własnej aplikacji jednoznacznie: całe UI ma być
 * w Claude. Ta strona nie jest wyjątkiem od tamtej decyzji, bo nie pokazuje
 * ani jednej sprawy, listy czy szczegółu. Ma jedno pole i jeden przycisk,
 * a po włączeniu powiadomień nie ma powodu jej otwierać.
 *
 * Istnieje, bo bez niej nie ma fizycznej drogi z serwera na iPhone'a: Apple
 * dostarcza powiadomienia wyłącznie do czegoś zainstalowanego na urządzeniu,
 * a Web Push jest jedynym sposobem, żeby to „coś" nie było osobną aplikacją
 * z App Store ani cudzą usługą pośredniczącą.
 *
 * ── Ograniczenie iOS, które trzeba powiedzieć wprost ─────────────────────────
 * Karta w Safari **nigdy** nie dostanie powiadomienia. Strona musi być dodana do
 * ekranu początkowego (iOS 16.4+). To reguła Apple i nie da się jej obejść —
 * dlatego strona sama wykrywa, że działa w karcie, i mówi, co zrobić, zamiast
 * pozwolić właścicielowi nacisnąć przycisk, który i tak by nie zadziałał.
 */

/** Brąz marki. Ikona jest jednolita — ma być rozpoznawalna, nie ładna. */
const KOLOR: [number, number, number] = [0x4a, 0x2f, 0x1c];

export function manifest(): string {
  return JSON.stringify({
    name: "BHT Copilot — alerty",
    short_name: "BHT Alerty",
    description: "Powiadomienia o sprawach wymagających uwagi. Rozmowa toczy się w Claude.",
    start_url: "/push/",
    scope: "/push/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4a2f1c",
    icons: [
      { src: "/push/ikona.png", sizes: "180x180", type: "image/png", purpose: "any" },
      { src: "/push/ikona.png", sizes: "192x192", type: "image/png", purpose: "any" },
    ],
  });
}

export function serviceWorker(): string {
  return `// Odbiornik powiadomień BHT Copilot.
//
// iOS wymaga, żeby KAŻDY push pokazał powiadomienie — cichy push (odebrany
// i nie pokazany) grozi cofnięciem uprawnienia przez system. Dlatego nawet
// nierozpoznany ładunek kończy się widocznym powiadomieniem.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let dane = { tytul: "BHT Copilot", tresc: "", waga: "zwykle", tag: null };
  try {
    dane = Object.assign(dane, event.data ? event.data.json() : {});
  } catch (_) {
    if (event.data) dane.tresc = event.data.text();
  }

  const opcje = {
    body: dane.tresc,
    icon: "/push/ikona.png",
    badge: "/push/ikona.png",
    // Ten sam tag zastępuje poprzednie powiadomienie o tej samej sprawie,
    // zamiast układać stos powtórzeń.
    tag: dane.tag || undefined,
    requireInteraction: dane.waga === "pilne",
    data: { waga: dane.waga },
  };

  event.waitUntil(self.registration.showNotification(dane.tytul, opcje));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Świadomie NIE otwieramy rozmowy z Claude. Deep link został przetestowany
  // i odrzucony (docs/UX-SPIKE-CLAUDE.md): platforma i tak nie wyśle polecenia
  // bez potwierdzenia, a droga „otwórz Claude i zapytaj" jest krótsza.
  event.waitUntil(self.clients.openWindow("/push/"));
});
`;
}

export function stronaPush(kluczPubliczny: string): string {
  return `<!doctype html><html lang="pl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="BHT Alerty">
<meta name="theme-color" content="#4a2f1c">
<link rel="manifest" href="/push/manifest.webmanifest">
<link rel="apple-touch-icon" href="/push/ikona.png">
<title>BHT Copilot — alerty</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 margin:0;padding:32px 20px calc(32px + env(safe-area-inset-bottom));max-width:460px;margin-inline:auto}
h1{font-size:21px;margin:0 0 6px}
p{color:#666;margin:0 0 16px}
ol{color:#666;font-size:15px;padding-left:22px;margin:0 0 18px}
li{margin-bottom:6px}
input{font:inherit;width:100%;min-height:48px;padding:0 14px;margin-bottom:12px;
 border:1px solid #bbb;border-radius:11px;background:transparent;color:inherit}
button{font:inherit;font-weight:600;width:100%;min-height:52px;border:0;border-radius:11px;
 background:#4a2f1c;color:#fff}
button[disabled]{opacity:.45}
#stan{margin-top:16px;font-size:15px;min-height:24px}
.ok{color:#1c7c3a}.zle{color:#c0392b}
.karta{border:1px solid #ddd;border-radius:14px;padding:16px;margin-bottom:20px}
.stopka{color:#888;font-size:13px;margin-top:26px}
</style></head><body>

<h1>Alerty BHT Copilot</h1>
<p>Ta strona tylko włącza powiadomienia. Sprawy oglądasz i omawiasz w Claude.</p>

<div id="trzeba-zainstalowac" class="karta" hidden>
  <strong>Najpierw dodaj do ekranu początkowego.</strong>
  <ol>
    <li>Naciśnij <strong>Udostępnij</strong> (kwadrat ze strzałką na dole).</li>
    <li>Wybierz <strong>Dodaj do ekranu początkowego</strong>.</li>
    <li>Otwórz nową ikonę i wróć tutaj.</li>
  </ol>
  <p style="margin:0">Apple nie dostarcza powiadomień do karty w Safari — to reguła
  systemu, nie ustawienie tej strony.</p>
</div>

<div id="formularz" hidden>
  <input type="password" id="haslo" placeholder="Hasło BHT Copilota" autocomplete="current-password">
  <input type="text" id="opis" placeholder="Nazwa urządzenia, np. iPhone Michała">
  <button id="wlacz">Włącz powiadomienia</button>
</div>

<div id="stan"></div>

<p class="stopka">Wyłączasz je w Ustawieniach iOS → Powiadomienia, albo kasując
tę ikonę z ekranu. Treść alertu jest szyfrowana — po drodze nikt jej nie czyta.</p>

<script>
const KLUCZ = ${JSON.stringify(kluczPubliczny)};
const stan = document.getElementById("stan");
const powiedz = (t, zle) => { stan.textContent = t; stan.className = zle ? "zle" : "ok"; };

const wSamodzielnym =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// Na iOS bez instalacji na ekranie początkowym subskrypcja rzuci wyjątkiem.
// Lepiej nie pokazywać przycisku, który nie może zadziałać.
if (iOS && !wSamodzielnym) {
  document.getElementById("trzeba-zainstalowac").hidden = false;
} else if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
  powiedz("Ta przeglądarka nie obsługuje powiadomień push.", true);
} else {
  document.getElementById("formularz").hidden = false;
}

function b64ToU8(b64) {
  const uzup = "=".repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + uzup).replace(/-/g, "+").replace(/_/g, "/");
  const surowe = atob(s);
  const out = new Uint8Array(surowe.length);
  for (let i = 0; i < surowe.length; i++) out[i] = surowe.charCodeAt(i);
  return out;
}

document.getElementById("wlacz")?.addEventListener("click", async (e) => {
  const przycisk = e.currentTarget;
  const haslo = document.getElementById("haslo").value.trim();
  if (!haslo) return powiedz("Podaj hasło BHT Copilota.", true);

  przycisk.disabled = true;
  try {
    const rej = await navigator.serviceWorker.register("/push/sw.js", { scope: "/push/" });
    await navigator.serviceWorker.ready;

    // Musi wyjść z gestu użytkownika — dlatego siedzi w obsłudze kliknięcia.
    const zgoda = await Notification.requestPermission();
    if (zgoda !== "granted") {
      return powiedz("Bez zgody na powiadomienia nic nie przyjdzie.", true);
    }

    const sub = await rej.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(KLUCZ),
    });

    const odp = await fetch("/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        haslo,
        opis: document.getElementById("opis").value.trim() || "urządzenie",
        subskrypcja: sub.toJSON(),
      }),
    });

    if (odp.status === 401) return powiedz("Nieprawidłowe hasło.", true);
    if (!odp.ok) return powiedz("Serwer odmówił: HTTP " + odp.status, true);

    document.getElementById("haslo").value = "";
    powiedz("Gotowe. To urządzenie będzie dostawać alerty.");
  } catch (err) {
    powiedz("Nie udało się: " + (err && err.message ? err.message : err), true);
  } finally {
    przycisk.disabled = false;
  }
});
</script>
</body></html>`;
}

// ── ikona ─────────────────────────────────────────────────────────────────────
/**
 * Jednolity kwadrat jako PNG, składany w kodzie.
 *
 * Alternatywą było dołożenie pliku binarnego do repozytorium albo wpisanie go
 * jako base64 w źródle — jedno i drugie znaczy „nikt nigdy nie sprawdzi, co tam
 * jest". Trzydzieści linii, które da się przeczytać, jest tu uczciwsze.
 */
export function ikonaPng(rozmiar = 180): Buffer {
  const [r, g, b] = KOLOR;
  // Format surowy: każdy wiersz poprzedzony bajtem filtra (0 = brak).
  const wiersz = Buffer.alloc(1 + rozmiar * 3);
  for (let x = 0; x < rozmiar; x++) {
    wiersz[1 + x * 3] = r;
    wiersz[2 + x * 3] = g;
    wiersz[3 + x * 3] = b;
  }
  const surowe = Buffer.concat(Array.from({ length: rozmiar }, () => wiersz));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rozmiar, 0);
  ihdr.writeUInt32BE(rozmiar, 4);
  ihdr[8] = 8; // bitów na kanał
  ihdr[9] = 2; // typ koloru: truecolor
  // 10..12: kompresja, filtr, przeplot — wszystkie 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    kawalek("IHDR", ihdr),
    kawalek("IDAT", deflateSync(surowe)),
    kawalek("IEND", Buffer.alloc(0)),
  ]);
}

function kawalek(typ: string, dane: Buffer): Buffer {
  const naglowek = Buffer.alloc(4);
  naglowek.writeUInt32BE(dane.length, 0);
  const trzon = Buffer.concat([Buffer.from(typ, "ascii"), dane]);
  const suma = Buffer.alloc(4);
  suma.writeUInt32BE(crc32(trzon) >>> 0, 0);
  return Buffer.concat([naglowek, trzon, suma]);
}
