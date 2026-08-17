import {
  CONNECTEAM_BASE_URL,
  ChatMessage,
  Conversation,
  type ChatProvider,
  type ConnecteamProbe,
} from "./types.js";

/**
 * Klient Connecteam API.
 *
 * Uwierzytelnienie: nagłówek `X-API-KEY`. Klucz NIGDY nie idzie w URL i nigdy
 * nie trafia do logu ani do komunikatu błędu — ta klasa nie ma metody, która by
 * go zwróciła.
 *
 * Kształt tego pliku wynika z jednego ustalenia: publiczna dokumentacja sekcji
 * Chat opisuje wysyłanie wiadomości i listę konwersacji, nie opisuje odczytu
 * treści. Dlatego odczyt jest zrealizowany jako SONDA po kilku prawdopodobnych
 * ścieżkach, która raportuje kody odpowiedzi, zamiast jednej ścieżki uznanej za
 * pewną. Jeśli dostawca odczyt udostępnia (choćby w Becie włączonej dla tej
 * firmy), sonda go znajdzie i powie którą ścieżką. Jeśli nie — powie, że nie ma,
 * i tak też będzie wyglądał produkt.
 *
 * Czego tu NIE MA i bez osobnej zgody właściciela być nie może: scrapingu,
 * automatyzacji przeglądarki i odtwarzania prywatnego API. Zakaz jest wprost
 * w zadaniu (§12) i jest zasadny — obejście oficjalnego API oznacza integrację,
 * która psuje się cicho przy każdej zmianie u dostawcy.
 */

const TIMEOUT_MS = 15_000;

/**
 * Ścieżki sprawdzane w poszukiwaniu odczytu wiadomości.
 *
 * Kolejność od najbardziej do najmniej prawdopodobnej. `{c}` podstawiamy
 * identyfikatorem istniejącej konwersacji — bez niego serwer odpowie 404 nawet
 * wtedy, gdy trasa istnieje, i sonda wyciągnęłaby fałszywy wniosek.
 */
const READ_CANDIDATES = [
  "/chat/v1/conversations/{c}/messages",
  "/chat/v1/conversations/{c}",
  "/chat/v1/messages?conversationId={c}",
] as const;

interface Attempt {
  path: string;
  status: number | string;
}

export class ConnecteamClient implements ChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = CONNECTEAM_BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call(
    path: string,
    method = "GET",
  ): Promise<{ status: number | string; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "x-api-key": this.apiKey, accept: "application/json" },
        signal: ctrl.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Nie każda odpowiedź błędu jest JSON-em. Kod statusu wystarcza.
      }
      return { status: res.status, body };
    } catch (err) {
      // Błąd sieci nie jest odpowiedzią „nie ma takiej trasy" — musi wyglądać
      // inaczej niż 404, inaczej sonda uzna brak łączności za brak funkcji.
      return { status: err instanceof Error ? err.name : "network_error", body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(): Promise<ConnecteamProbe> {
    const notes: string[] = [];

    const me = await this.call("/me");
    const authOk = me.status === 200;
    if (!authOk) {
      notes.push(
        me.status === 401 || me.status === 403
          ? `GET /me zwróciło ${me.status} — klucz API nie działa albo konto nie ma dostępu do API ` +
            "(wymagany plan Expert lub wyżej)."
          : `GET /me zwróciło ${me.status} — nie mogę potwierdzić niczego dalej.`,
      );
      return {
        authOk: false,
        accountName: null,
        canListConversations: null,
        conversationCount: null,
        canReadMessages: false,
        readAttempts: [],
        webhooksAvailable: null,
        webhookEventTypes: [],
        chatWebhookAvailable: false,
        notes,
      };
    }

    const accountName = pickString(me.body, ["name", "companyName", "accountName"]);

    // ── konwersacje ──────────────────────────────────────────────────────────
    const convRes = await this.call("/chat/v1/conversations");
    const canListConversations = convRes.status === 200 ? true : convRes.status === 404 ? false : null;
    const conversations = convRes.status === 200 ? parseConversations(convRes.body) : [];
    if (canListConversations === null) {
      notes.push(`GET /chat/v1/conversations zwróciło ${convRes.status} — nie rozstrzygam.`);
    }
    if (canListConversations === true && conversations.length === 0) {
      notes.push(
        "Lista konwersacji jest pusta. To NIE znaczy, że firma nie używa czatu — " +
          "oficjalne API zwraca czaty zespołowe i kanały, a rozmowy prywatne normalnie " +
          "się w tej liście nie pojawiają.",
      );
    }

    // ── odczyt treści: pytanie rozstrzygające ────────────────────────────────
    const readAttempts: Attempt[] = [];
    let canReadMessages = false;
    const sample = conversations[0]?.id;
    if (!sample) {
      notes.push(
        "Nie sprawdziłem odczytu wiadomości, bo nie mam ani jednej konwersacji, na której " +
          "dałoby się to zrobić. Sprawdzenie na wymyślonym identyfikatorze dałoby 404 " +
          "niezależnie od tego, czy trasa istnieje — czyli wynik bez wartości.",
      );
    } else {
      for (const template of READ_CANDIDATES) {
        const path = template.replace("{c}", encodeURIComponent(sample));
        const res = await this.call(path);
        readAttempts.push({ path: template, status: res.status });
        if (res.status === 200 && looksLikeMessages(res.body)) {
          canReadMessages = true;
          break;
        }
      }
      if (!canReadMessages) {
        notes.push(
          "Żadna sprawdzona ścieżka nie zwróciła treści wiadomości. Zgodne z publiczną " +
            "dokumentacją, która w sekcji Chat opisuje wysyłanie i listę konwersacji, " +
            "ale nie odczyt.",
        );
      }
    }

    // ── webhooki ─────────────────────────────────────────────────────────────
    const hookRes = await this.call("/settings/v1/webhooks");
    const webhooksAvailable = hookRes.status === 200 ? true : hookRes.status === 404 ? false : null;
    const webhookEventTypes = hookRes.status === 200 ? collectEventTypes(hookRes.body) : [];
    const chatWebhookAvailable = webhookEventTypes.some((t) => /chat|message|conversation/i.test(t));
    if (webhooksAvailable === true && webhookEventTypes.length === 0) {
      notes.push(
        "API webhooków odpowiada, ale konto nie ma jeszcze skonfigurowanego żadnego webhooka, " +
          "więc lista typów zdarzeń jest pusta. Dostępne typy zna dopiero próba utworzenia — " +
          "a tego nie robię, bo tworzyłoby to konfigurację w Twoim koncie bez Twojej zgody.",
      );
    }

    return {
      authOk,
      accountName,
      canListConversations,
      conversationCount: canListConversations === true ? conversations.length : null,
      canReadMessages,
      readAttempts,
      webhooksAvailable,
      webhookEventTypes,
      chatWebhookAvailable,
      notes,
    };
  }

  async listConversations(): Promise<Conversation[] | null> {
    const res = await this.call("/chat/v1/conversations");
    if (res.status !== 200) return null;
    return parseConversations(res.body);
  }

  /**
   * Wiadomości od podanego momentu.
   *
   * Zwraca `null`, gdy odczyt jest niedostępny — i to jest normalny, oczekiwany
   * wynik przy dzisiejszym stanie API. Wywołujący MUSI rozróżnić `null` od `[]`;
   * gdyby traktował je jednakowo, produkt raportowałby „brak nowych wiadomości"
   * w sytuacji „nie mam jak ich zobaczyć".
   */
  async messagesSince(since: string): Promise<ChatMessage[] | null> {
    const conversations = await this.listConversations();
    if (!conversations || conversations.length === 0) return null;

    const out: ChatMessage[] = [];
    let anyRouteWorked = false;

    for (const conv of conversations) {
      for (const template of READ_CANDIDATES) {
        const res = await this.call(template.replace("{c}", encodeURIComponent(conv.id)));
        if (res.status === 200 && looksLikeMessages(res.body)) {
          anyRouteWorked = true;
          out.push(...parseMessages(res.body, conv).filter((m) => m.at > since));
          break;
        }
      }
    }
    return anyRouteWorked ? out.sort((a, b) => a.at.localeCompare(b.at)) : null;
  }

  async close(): Promise<void> {
    // fetch nie trzyma puli, którą trzeba zamykać. Metoda istnieje, żeby
    // dostawca był wymienny na taki, który jej potrzebuje.
  }
}

// ── parsowanie odpowiedzi ─────────────────────────────────────────────────────
/**
 * Odpowiedzi dostawcy parsujemy DEFENSYWNIE: schemat nie jest naszą własnością
 * i nie mamy jego kontraktu z fixture'ami po obu stronach. Wszystko, czego nie
 * rozumiemy, jest pomijane, a nie zgadywane.
 */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Wyciąga tablicę spod jednego z typowych opakowań (`data`, `items`, korzeń). */
function arrayFrom(body: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const rec = asRecord(body);
  if (!rec) return [];
  for (const key of [...keys, "data", "items", "results"]) {
    const inner = rec[key];
    if (Array.isArray(inner)) return inner;
    const nested = asRecord(inner);
    if (nested) {
      for (const k2 of keys) {
        if (Array.isArray(nested[k2])) return nested[k2] as unknown[];
      }
    }
  }
  return [];
}

function pickString(body: unknown, keys: readonly string[]): string | null {
  const rec = asRecord(body);
  if (!rec) return null;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const data = asRecord(rec["data"]);
  if (data) {
    for (const key of keys) {
      const v = data[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function parseConversations(body: unknown): Conversation[] {
  return arrayFrom(body, ["conversations", "chats", "channels"])
    .map((raw) => {
      const rec = asRecord(raw);
      if (!rec) return null;
      const id = rec["id"] ?? rec["conversationId"] ?? rec["chatId"];
      if (typeof id !== "string" && typeof id !== "number") return null;
      return {
        id: String(id),
        name: typeof rec["name"] === "string" ? rec["name"] : null,
        kind: typeof rec["type"] === "string" ? rec["type"] : null,
      };
    })
    .filter((c): c is Conversation => c !== null);
}

/**
 * Czy to w ogóle wygląda na listę wiadomości.
 *
 * Warunek jest OSTRY celowo: wymagamy elementu z rozpoznawalnym czasem. Bez tego
 * `{"conversations": […]}` albo puste `{"data": []}` przeszłoby jako „umiemy
 * czytać wiadomości", a sonda ma odpowiadać na pytanie rozstrzygające i nie wolno
 * jej odpowiedzieć twierdząco na podstawie samego kodu 200.
 */
function looksLikeMessages(body: unknown): boolean {
  const arr = arrayFrom(body, ["messages"]);
  if (arr.length === 0) return false;
  return arr.some((raw) => {
    const rec = asRecord(raw);
    return rec !== null && timeOf(rec) !== null;
  });
}

function timeOf(rec: Record<string, unknown>): string | null {
  for (const key of ["createdAt", "timestamp", "sentAt", "time", "date"]) {
    const v = rec[key];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
    // Znaczniki uniksowe przychodzą i w sekundach, i w milisekundach.
    if (typeof v === "number" && Number.isFinite(v)) {
      const ms = v > 1e11 ? v : v * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

export function parseMessages(body: unknown, conv: Conversation): ChatMessage[] {
  return arrayFrom(body, ["messages"])
    .map((raw) => {
      const rec = asRecord(raw);
      if (!rec) return null;
      const at = timeOf(rec);
      const id = rec["id"] ?? rec["messageId"];
      if (at === null || (typeof id !== "string" && typeof id !== "number")) return null;
      const author =
        pickString(rec["sender"], ["name", "fullName"]) ??
        pickString(rec["author"], ["name", "fullName"]) ??
        (typeof rec["senderName"] === "string" ? rec["senderName"] : null);
      const text = ["text", "body", "message", "content"]
        .map((k) => (typeof rec[k] === "string" ? (rec[k] as string) : ""))
        .find((s) => s.trim().length > 0);
      return {
        id: String(id),
        conversationId: conv.id,
        conversationName: conv.name,
        at,
        authorName: author,
        text: (text ?? "").trim(),
      };
    })
    .filter((m): m is ChatMessage => m !== null);
}

function collectEventTypes(body: unknown): string[] {
  const types = new Set<string>();
  for (const raw of arrayFrom(body, ["webhooks"])) {
    const rec = asRecord(raw);
    if (!rec) continue;
    for (const key of ["eventType", "eventTypes", "events", "type"]) {
      const v = rec[key];
      if (typeof v === "string") types.add(v);
      if (Array.isArray(v)) for (const one of v) if (typeof one === "string") types.add(one);
    }
  }
  return [...types].sort();
}
