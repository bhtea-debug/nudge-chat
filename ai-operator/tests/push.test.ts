import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Odbiornik powiadomień — na żywym procesie.
 *
 * Testy jednostkowe nie odpowiedzą na pytanie, które tu jest istotne: czy iPhone
 * ma z czego zbudować subskrypcję. Do tego potrzeba prawdziwych odpowiedzi HTTP
 * z prawdziwymi typami zawartości, bo Safari odrzuca service workera podanego
 * z niewłaściwym `content-type` i robi to po cichu.
 *
 * Osobno pilnujemy rzeczy, której złamanie jest kosztowne: `/push/subscribe`
 * BEZ hasła zapisałby cudze urządzenie do listy odbiorców alertów o sprawach
 * firmy — i nie byłoby tego widać, bo właściciel dostawałby swoje jak zwykle.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));

const PORT = 8853;
const BAZA = `http://127.0.0.1:${PORT}`;
const HASLO = "haslo-wlasciciela-do-testu";
const VAPID = webpush.generateVAPIDKeys();

let serwer: ChildProcess;

/** Subskrypcja o poprawnym KSZTAŁCIE, ale z adresem, który nigdzie nie prowadzi. */
const FALSZYWA = {
  endpoint: "https://push.example.invalid/urzadzenie-testowe",
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
};

beforeAll(async () => {
  serwer = spawn(process.execPath, [tsxCli, httpEntry], {
    cwd: operatorDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MODE: "fixture",
      MONITOR_IN_PROCESS: "0",
      COPILOT_STATE_DIR: join(tmpdir(), `bht-push-${PORT}-${process.pid}`),
      PORT: String(PORT),
      MCP_BEARER_TOKEN: "t".repeat(48),
      COPILOT_AUTH_PASSWORD: HASLO,
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const koniec = Date.now() + 25_000;
  for (;;) {
    try {
      await fetch(`${BAZA}/health`);
      return;
    } catch {
      if (Date.now() > koniec) throw new Error("serwer HTTP nie wstał w 25 s");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}, 30_000);

afterAll(() => {
  serwer?.kill();
});

const zapisz = (haslo: string, subskrypcja: unknown = FALSZYWA): Promise<Response> =>
  fetch(`${BAZA}/push/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ haslo, opis: "iPhone testowy", subskrypcja }),
  });

describe("odbiornik powiadomień — to, z czego iPhone buduje subskrypcję", () => {
  it("strona podaje klucz publiczny VAPID, bo bez niego nie da się zasubskrybować", async () => {
    const res = await fetch(`${BAZA}/push`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(VAPID.publicKey);
    // Klucz PRYWATNY nie ma prawa nigdy opuścić serwera.
    expect(html).not.toContain(VAPID.privateKey);
  });

  it("strona mówi wprost, że na iOS trzeba dodać do ekranu początkowego", async () => {
    // To nie jest kosmetyka: karta w Safari NIGDY nie dostanie powiadomienia,
    // a przycisk bez tego ostrzeżenia rzucałby wyjątkiem bez wyjaśnienia.
    const html = await (await fetch(`${BAZA}/push`)).text();
    expect(html).toContain("Dodaj do ekranu początkowego");
  });

  it("service worker jest podawany jako JavaScript i pokazuje powiadomienie", async () => {
    const res = await fetch(`${BAZA}/push/sw.js`);
    expect(res.status).toBe(200);
    // Safari odrzuca service workera z niewłaściwym typem — i robi to po cichu.
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("showNotification");
    expect(js).toContain('addEventListener("push"');
  });

  it("manifest ma zasięg i tryb, bez których iOS nie zrobi z tego aplikacji", async () => {
    const res = await fetch(`${BAZA}/push/manifest.webmanifest`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m["display"]).toBe("standalone");
    expect(m["start_url"]).toBe("/push/");
    expect(m["scope"]).toBe("/push/");
  });

  it("ikona jest prawdziwym PNG-iem", async () => {
    const res = await fetch(`${BAZA}/push/ikona.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bajty = Buffer.from(await res.arrayBuffer());
    expect(bajty.subarray(1, 4).toString("ascii")).toBe("PNG");
  });
});

describe("kto może zapisać urządzenie do alertów", () => {
  it("BEZ hasła nie da się zapisać — inaczej cudze urządzenie dostaje sprawy firmy", async () => {
    const res = await zapisz("nie-to-haslo");
    expect(res.status).toBe(401);
  });

  it("niekompletna subskrypcja jest odrzucana, a nie zapisywana po cichu", async () => {
    const res = await zapisz(HASLO, { endpoint: "https://push.example.invalid/x" });
    expect(res.status).toBe(400);
  });

  it("z hasłem zapisuje, a /health liczy urządzenia", async () => {
    const res = await zapisz(HASLO);
    expect(res.status).toBe(200);

    const zdrowie = (await (await fetch(`${BAZA}/health`)).json()) as Record<string, unknown>;
    expect(zdrowie["push"]).toBe(true);
    expect(zdrowie["pushUrzadzenia"]).toBe(1);
  });

  it("ten sam endpoint zapisany drugi raz NIE tworzy drugiego wpisu", async () => {
    // Właściciel może nacisnąć „włącz" kilka razy — każde naciśnięcie to jedno
    // powiadomienie więcej, gdyby wpisy się mnożyły.
    await zapisz(HASLO);
    const zdrowie = (await (await fetch(`${BAZA}/health`)).json()) as Record<string, unknown>;
    expect(zdrowie["pushUrzadzenia"]).toBe(1);
  });

  it("wypisanie usuwa urządzenie", async () => {
    const res = await fetch(`${BAZA}/push/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ haslo: HASLO, endpoint: FALSZYWA.endpoint }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { usuniete: boolean }).toMatchObject({ usuniete: true });
  });
});

describe("wysyłka testowa", () => {
  it("bez ani jednego urządzenia mówi to wprost, zamiast udawać sukces", async () => {
    const res = await fetch(`${BAZA}/push/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ haslo: HASLO }),
    });
    expect(res.status).toBe(409);
  });

  it("nieudana wysyłka NIE jest raportowana jako udana", async () => {
    // Adres bramki prowadzi donikąd, więc wysyłka musi się nie udać. Kluczowe
    // jest to, co serwer wtedy mówi: „nie wysłałem", a nie ciche 200.
    await zapisz(HASLO);
    const res = await fetch(`${BAZA}/push/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ haslo: HASLO, tytul: "Test", tresc: "treść", waga: "pilne" }),
    });
    expect(res.status).toBe(502);
    const wynik = (await res.json()) as { wyslane: number; bledy: string[] };
    expect(wynik.wyslane).toBe(0);
    expect(wynik.bledy.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("generator kluczy VAPID", () => {
  /**
   * Ten test istnieje, bo pierwsza wersja generatora importowała `web-push`
   * i wywróciła wdrożenie na maszynie właściciela: `git pull` przynosi
   * package.json, ale nie instaluje paczek. Uruchamiamy skrypt w katalogu BEZ
   * node_modules — dokładnie w warunkach, w których padł.
   */
  it("działa bez ani jednej zainstalowanej zależności i daje klucze, które web-push przyjmuje", async () => {
    const { mkdtempSync, mkdirSync, copyFileSync, readFileSync } = await import("node:fs");
    const katalog = mkdtempSync(join(tmpdir(), "bht-vapid-"));
    mkdirSync(join(katalog, "scripts"));
    copyFileSync(
      fileURLToPath(new URL("../scripts/generuj-vapid.mjs", import.meta.url)),
      join(katalog, "scripts", "generuj-vapid.mjs"),
    );

    const kod = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, ["scripts/generuj-vapid.mjs"], {
        cwd: katalog,
        // Środowisko bez niczego z tego projektu.
        env: { PATH: process.env["PATH"] ?? "", HOME: katalog },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let wyjscie = "";
      p.stdout.on("data", (d: Buffer) => (wyjscie += d.toString()));
      p.stderr.on("data", (d: Buffer) => (wyjscie += d.toString()));
      p.on("exit", (c) => {
        // Sekret nie ma prawa pojawić się na ekranie — stamtąd trafia do rozmowy.
        expect(wyjscie).not.toMatch(/[A-Za-z0-9_-]{40,}/);
        resolve(c);
      });
    });
    expect(kod).toBe(0);

    const env = readFileSync(join(katalog, ".env"), "utf8");
    const pub = /^VAPID_PUBLIC_KEY=(.+)$/m.exec(env)?.[1] ?? "";
    const priv = /^VAPID_PRIVATE_KEY=(.+)$/m.exec(env)?.[1] ?? "";

    // Kształt wymagany przez Web Push: nieskompresowany punkt P-256 i skalar.
    expect(Buffer.from(pub, "base64url")).toHaveLength(65);
    expect(Buffer.from(priv, "base64url")).toHaveLength(32);
    expect(() => webpush.setVapidDetails("mailto:x@y.pl", pub, priv)).not.toThrow();
  }, 20_000);
});
