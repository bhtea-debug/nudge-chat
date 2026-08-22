import type { InboxMessage } from "../../contract.js";
import { contentSha256, deriveCaseId } from "../../ids.js";
import type { MetaAccount } from "./webhook.js";

/**
 * Klient Graph API do UZGODNIENIA rozmów.
 *
 * Webhook jest szybką ścieżką, nie źródłem prawdy: aplikacja bywa chwilowo
 * niedostępna, subskrypcja bywa zerwana przy zmianie uprawnień, a Meta ponawia
 * doręczenie ograniczoną liczbę razy. Bez tego pliku awaria webhooka jest
 * równoznaczna z cichą utratą wiadomości.
 *
 * Zweryfikowane w oficjalnej dokumentacji (2026-08-22):
 *  - lista rozmów: `GET /{PAGE-ID}/conversations?platform=messenger|instagram`,
 *  - szczegóły: `GET /{CONVERSATION-ID}?fields=messages{...}`; Meta zwraca
 *    identyfikatory wszystkich wiadomości, ale SZCZEGÓŁY tylko 20 najnowszych,
 *  - wysyłka: `POST /{PAGE-ID}/messages` — także dla Instagrama, z IGSID jako
 *    odbiorcą; ID konta Instagram NIE jest adresem tego wywołania,
 *  - okno odpowiedzi: 24 godziny, `messaging_type: RESPONSE`.
 *
 * https://developers.facebook.com/docs/messenger-platform/conversations/
 * https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
 */

const DEFAULT_GRAPH_VERSION = "v25.0";
const DEFAULT_TIMEOUT_MS = 25_000;
/** Ile stron rozmów bierzemy w jednym uzgodnieniu. Sufit czasu i pamięci. */
const MAX_PAGES = 10;

export interface GraphAccount extends MetaAccount {
  /** Identyfikator używany w wywołaniach API. Dla Instagrama to PAGE ID. */
  readonly pageId: string;
  readonly accessToken: string;
  readonly graphVersion?: string;
}

export interface GraphConversationsResult {
  readonly messages: InboxMessage[];
  readonly pages: number;
  /** true = zostały jeszcze rozmowy poza pobranymi stronami. */
  readonly truncated: boolean;
}

interface GraphMessage {
  id?: unknown;
  message?: unknown;
  created_time?: unknown;
  from?: { id?: unknown };
  to?: { data?: Array<{ id?: unknown }> };
}

interface GraphConversation {
  id?: unknown;
  updated_time?: unknown;
  messages?: { data?: GraphMessage[] };
  participants?: { data?: Array<{ id?: unknown }> };
}

/**
 * Platforma w rozumieniu Graph API.
 *
 * `instagram` i `messenger` to DWIE różne listy pod tym samym adresem strony.
 * Pominięcie parametru zwraca tylko Messengera i cicho gubi Instagram.
 */
function platformOf(provider: MetaAccount["provider"]): "instagram" | "messenger" {
  return provider === "instagram" ? "instagram" : "messenger";
}

export async function fetchConversations(input: {
  readonly account: GraphAccount;
  readonly sinceMs: number;
  readonly now: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
}): Promise<GraphConversationsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const version = input.account.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const maxPages = Math.max(1, input.maxPages ?? MAX_PAGES);

  const messages: InboxMessage[] = [];
  let url: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(input.account.pageId)}/conversations` +
    `?platform=${platformOf(input.account.provider)}` +
    `&fields=${encodeURIComponent("id,updated_time,participants,messages{id,message,created_time,from,to}")}` +
    `&limit=25`;

  let pages = 0;
  let truncated = false;

  for (; pages < maxPages && url; pages += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let payload: { data?: GraphConversation[]; paging?: { next?: unknown } };
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${input.account.accessToken}` },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new GraphError("reconnect_required", "Token konta wygasl albo brakuje uprawnien");
      }
      if (response.status === 429) {
        throw new GraphError("rate_limited", "Meta ograniczyla tempo odczytu");
      }
      if (!response.ok) {
        throw new GraphError(`http_${response.status}`, "Meta odrzucila odczyt rozmow");
      }
      payload = (await response.json()) as typeof payload;
    } finally {
      clearTimeout(timer);
    }

    for (const conversation of payload.data ?? []) {
      messages.push(...normalizeConversation(conversation, input.account, input.sinceMs, input.now));
    }

    const next = typeof payload.paging?.next === "string" ? payload.paging.next : null;
    url = next;
    if (next && pages + 1 >= maxPages) truncated = true;
  }

  return { messages, pages, truncated };
}

export class GraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

function normalizeConversation(
  conversation: GraphConversation,
  account: GraphAccount,
  sinceMs: number,
  now: number,
): InboxMessage[] {
  const out: InboxMessage[] = [];
  const key = { provider: account.provider, accountKey: account.accountKey };

  for (const message of conversation.messages?.data ?? []) {
    const mid = typeof message.id === "string" ? message.id : null;
    if (!mid) continue;

    const createdAt =
      typeof message.created_time === "string" ? Date.parse(message.created_time) : Number.NaN;
    const sourceCreatedAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null;
    // Okno uzgodnienia liczymy po czasie ŹRÓDŁA. Wiadomość bez czasu zostaje,
    // bo pominięcie jej byłoby cichą utratą przez brak metadanych.
    if (sourceCreatedAt !== null && sourceCreatedAt < sinceMs) continue;

    const fromId = typeof message.from?.id === "string" ? message.from.id : null;
    // Nasza strona rozpoznawana po PAGE ID (Messenger) albo ID konta (IG):
    // Meta używa obu w zależności od platformy, więc sprawdzamy oba.
    const isOurs = fromId === account.pageId || fromId === account.accountKey;
    const counterpart = isOurs
      ? (conversation.participants?.data ?? [])
          .map((entry) => (typeof entry.id === "string" ? entry.id : null))
          .find((id) => id !== null && id !== account.pageId && id !== account.accountKey) ?? null
      : fromId;
    if (!counterpart) continue;

    const text = typeof message.message === "string" ? message.message : "";

    out.push({
      provider: account.provider,
      accountKey: account.accountKey,
      externalConversationId: counterpart,
      externalMessageId: mid,
      caseId: deriveCaseId(key, counterpart),
      direction: isOurs ? "outgoing" : "incoming",
      sourceCreatedAt,
      receivedAt: now,
      authorLabel: isOurs ? null : counterpart,
      subject: null,
      body: text,
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: null,
      rfcInReplyTo: null,
      rfcReferences: [],
      // Wiadomość wychodząca z uzgodnienia jest tym samym, co echo webhooka:
      // dedup po `mid` sklei je w jeden rekord zamiast zrobić duplikat.
      isEcho: isOurs,
      contentFingerprint: contentSha256([mid, String(sourceCreatedAt ?? ""), text].join(" ")).slice(0, 32),
    });
  }

  return out;
}
