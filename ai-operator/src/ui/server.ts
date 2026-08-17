import type { IncomingMessage, ServerResponse } from "node:http";
import { LoginThrottle, readCookie, SESSION_COOKIE, UiAuth } from "./auth.js";
import { MANIFEST, renderCase, renderInbox, renderLogin, type SyncState } from "./views.js";
import type { CopilotStore } from "../state/store.js";

/**
 * Serwer UI — obsługa żądań BHT Copilota.
 *
 * Mieszka w TYM SAMYM procesie, co Remote MCP, i to jest decyzja, nie
 * przypadek: jedno wdrożenie, jeden wolumen ze stanem, jedno miejsce awarii.
 * Claude czyta stan przez MCP, właściciel patrzy na ten sam stan przez
 * przeglądarkę. Dwa procesy oznaczałyby dwie kopie stanu albo bazę do
 * uzgadniania — czyli nową infrastrukturę dla problemu, którego nie mamy.
 *
 * Kontrakt tej funkcji: zwraca `true`, jeśli obsłużyła żądanie. Dzięki temu
 * transport MCP zostaje nietknięty, a UI da się wyłączyć jedną zmienną
 * środowiskową, bez ruszania czegokolwiek innego.
 */

export interface UiDeps {
  readonly store: CopilotStore;
  readonly auth: UiAuth;
  /** Skąd wziąć aktualny stan synchronizacji. Funkcja, bo zmienia się w czasie. */
  readonly sync: () => SyncState;
  /** Adres do otwarcia rozmowy w Claude. `null` = pokazujemy tylko kopiowanie. */
  readonly claudeUrl: string | null;
}

const throttle = new LoginThrottle();

/** Ścieżki dostępne BEZ sesji. Manifest nie zawiera danych firmy. */
const PUBLIC_PATHS = new Set(["/login", "/manifest.webmanifest"]);

export async function handleUi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: UiDeps,
): Promise<boolean> {
  const path = url.pathname;

  if (path === "/manifest.webmanifest") {
    send(res, 200, "application/manifest+json", MANIFEST);
    return true;
  }

  const authed = deps.auth.valid(readCookie(req.headers.cookie, SESSION_COOKIE));

  // ── logowanie ──────────────────────────────────────────────────────────────
  if (path === "/login") {
    if (req.method === "GET") {
      if (authed) return redirect(res, "/");
      send(res, 200, "text/html; charset=utf-8", renderLogin(null));
      return true;
    }
    if (req.method === "POST") {
      // Klucz limitu to adres z warstwy transportu. Nie ufamy X-Forwarded-For:
      // klient może go podać dowolnie, więc oparcie limitu na nim znaczyłoby
      // brak limitu.
      const key = req.socket.remoteAddress ?? "nieznany";
      if (!throttle.allow(key)) {
        send(res, 429, "text/html; charset=utf-8", renderLogin("Za dużo prób. Odczekaj kilka minut."));
        return true;
      }
      const body = await readBody(req);
      const haslo = new URLSearchParams(body).get("haslo") ?? "";
      if (!deps.auth.passwordMatches(haslo)) {
        throttle.record(key);
        // Ten sam komunikat niezależnie od przyczyny i bez echa hasła.
        send(res, 401, "text/html; charset=utf-8", renderLogin("Nieprawidłowe hasło."));
        return true;
      }
      throttle.reset(key);
      res.writeHead(303, { location: "/", "set-cookie": deps.auth.cookieHeader(deps.auth.issue()) });
      res.end();
      return true;
    }
    send(res, 405, "text/plain; charset=utf-8", "użyj GET albo POST");
    return true;
  }

  if (path === "/wyloguj") {
    res.writeHead(303, { location: "/login", "set-cookie": deps.auth.clearCookieHeader() });
    res.end();
    return true;
  }

  if (!isUiPath(path)) return false;

  if (!authed && !PUBLIC_PATHS.has(path)) {
    // Bez sesji zawsze ekran logowania, także dla POST-a. Nie przekierowujemy
    // z powrotem do akcji po zalogowaniu — cicho wykonana akcja, o której
    // właściciel zapomniał, jest gorsza niż jedno kliknięcie więcej.
    send(res, 200, "text/html; charset=utf-8", renderLogin(null));
    return true;
  }

  // ── lista spraw ────────────────────────────────────────────────────────────
  if (path === "/") {
    send(res, 200, "text/html; charset=utf-8", renderInbox(deps.store.all(), deps.sync()));
    // „Pokazałem" zapisujemy PO wyrenderowaniu i tylko dla spraw widocznych na
    // ekranie głównym. Ten sam mechanizm, którym adapter MCP oznacza pokazane
    // sprawy — dzięki temu ekran i Claude nie liczą zmian inaczej.
    const widoczne = deps.store
      .all()
      .filter((i) => i.status !== "resolved" && !i.likelyIrrelevant)
      .map((i) => i.id);
    safely(() => deps.store.markPresented(widoczne, "ui"));
    return true;
  }

  // ── jedna sprawa ───────────────────────────────────────────────────────────
  const widok = /^\/sprawa\/([A-Za-z0-9_]+)$/.exec(path);
  if (widok && req.method === "GET") {
    const issue = deps.store.get(widok[1]!);
    if (!issue) {
      send(res, 404, "text/html; charset=utf-8", renderLogin("Nie mam takiej sprawy."));
      return true;
    }
    send(res, 200, "text/html; charset=utf-8", renderCase(issue, deps.sync(), deps.claudeUrl));
    safely(() => deps.store.markPresented([issue.id], "ui"));
    return true;
  }

  // ── działania właściciela ──────────────────────────────────────────────────
  const akcja = /^\/sprawa\/([A-Za-z0-9_]+)\/(zamknij|decyzja|obserwuj)$/.exec(path);
  if (akcja && req.method === "POST") {
    const [, id, co] = akcja as unknown as [string, string, "zamknij" | "decyzja" | "obserwuj"];
    // Ochrona przed żądaniem z obcej strony stoi na ciasteczku `SameSite=Strict`:
    // przeglądarka nie dołączy go do żądania wywołanego z innej witryny, więc
    // taki POST trafi na ekran logowania.
    applyOwnerAction(deps.store, id, co);
    return redirect(res, co === "zamknij" ? "/" : `/sprawa/${id}`);
  }

  send(res, 404, "text/html; charset=utf-8", renderLogin("Nie ma takiej strony."));
  return true;
}

/**
 * Trzy działania i ani jednego więcej.
 *
 * `zamknij` idzie przez `ownerResolve`, czyli jedyną drogę do statusu
 * `resolved` — z aktorem `wlasciciel`. Monitor i model tej drogi nie mają
 * i mieć nie mogą (§23 oraz `store.guardStatus`).
 */
function applyOwnerAction(store: CopilotStore, id: string, co: "zamknij" | "decyzja" | "obserwuj"): void {
  if (co === "zamknij") {
    store.ownerResolve(id, "z ekranu sprawy");
    return;
  }
  if (co === "decyzja") {
    store.ownerAction(id, { status: "waiting_for_owner" }, "oznaczona jako wymagająca mojej decyzji");
    return;
  }
  store.ownerAction(id, { status: "monitoring" }, "wróciła do obserwowanych");
}

/** Czy ta ścieżka należy do UI. Wszystko inne zostawiamy transportowi MCP. */
function isUiPath(path: string): boolean {
  return path === "/" || path.startsWith("/sprawa/") || PUBLIC_PATHS.has(path) || path === "/wyloguj";
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Strony zawierają pocztę firmy — nic z tego nie ma prawa wylądować
    // w cache przeglądarki ani pośrednika.
    "cache-control": "no-store, must-revalidate",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Bez zewnętrznych źródeł. `unsafe-inline` jest potrzebny, bo styl i te
    // kilkanaście linii skryptu są wpisane w stronę — nie ma tu żadnego pliku
    // z zewnątrz, więc powierzchnia jest własna i zamknięta.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): boolean {
  res.writeHead(303, { location: to, "cache-control": "no-store" });
  res.end();
  return true;
}

const MAX_FORM = 8 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_FORM) throw new Error("formularz za duży");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Zapis „pokazałem" nie może przewrócić odpowiedzi, która już poszła do klienta. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* stan Copilota jest warstwą pomocniczą — jego awaria nie psuje widoku */
  }
}
