import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { InboxMessage } from "../../contract.js";
import { contentSha256, deriveCaseId } from "../../ids.js";

/**
 * Webhooki Meta (Messenger Platform i Instagram API).
 *
 * Trzy rzeczy dzieją się TU i tylko tu, zawsze w tej kolejności:
 *  1. weryfikacja podpisu surowego ciała,
 *  2. odrzucenie ładunku, który nie pasuje do schematu,
 *  3. normalizacja do kontraktu generycznego.
 *
 * Zapis czegokolwiek przed punktem 1 znaczyłby, że dowolny host w internecie
 * może wstawić sprawę do kolejki obsługi klienta.
 */

export const META_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Weryfikacja `X-Hub-Signature-256`.
 *
 * Liczona z SUROWEGO ciała, nie z ponownie zserializowanego JSON-a: dwa
 * przebiegi przez `JSON.parse`/`stringify` zmieniają bajty (kolejność kluczy,
 * escapowanie) i podpis przestaje się zgadzać, choć ładunek jest prawdziwy.
 */
export function verifyMetaSignature(input: {
  readonly rawBody: Buffer | string;
  readonly header: string | null | undefined;
  readonly appSecret: string;
}): boolean {
  const header = input.header?.trim();
  if (!header || !header.startsWith("sha256=")) return false;
  if (!input.appSecret) return false;

  const provided = header.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const expected = createHmac("sha256", input.appSecret).update(body).digest("hex");

  // Porównanie stałoczasowe. Zwykłe === wycieka pozycję pierwszej różnicy.
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Handshake weryfikacyjny Meta. Zwraca challenge do odesłania albo null. */
export function metaVerificationChallenge(input: {
  readonly mode: string | null;
  readonly token: string | null;
  readonly challenge: string | null;
  readonly expectedToken: string;
}): string | null {
  if (input.mode !== "subscribe") return null;
  if (!input.expectedToken || !input.token) return null;
  const provided = Buffer.from(input.token, "utf8");
  const expected = Buffer.from(input.expectedToken, "utf8");
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return input.challenge ?? null;
}

const MetaAttachment = z
  .object({
    type: z.string().max(64).optional(),
    payload: z.object({ url: z.string().max(2_048).optional() }).partial().optional(),
  })
  .passthrough();

const MetaMessaging = z
  .object({
    sender: z.object({ id: z.string().min(1).max(128) }).optional(),
    recipient: z.object({ id: z.string().min(1).max(128) }).optional(),
    timestamp: z.number().int().nonnegative().optional(),
    message: z
      .object({
        mid: z.string().min(1).max(512),
        text: z.string().max(20_000).optional(),
        is_echo: z.boolean().optional(),
        is_deleted: z.boolean().optional(),
        attachments: z.array(MetaAttachment).max(50).optional(),
      })
      .optional(),
    /** Potwierdzenia dostarczenia i odczytu. Nie tworzą spraw. */
    delivery: z.object({ mids: z.array(z.string()).optional() }).partial().optional(),
    read: z.object({ watermark: z.number().optional() }).partial().optional(),
  })
  .passthrough();

const MetaEntry = z
  .object({
    id: z.string().min(1).max(128),
    time: z.number().int().nonnegative().optional(),
    messaging: z.array(MetaMessaging).max(200).optional(),
  })
  .passthrough();

export const MetaWebhookPayload = z
  .object({
    object: z.string().min(1).max(64),
    entry: z.array(MetaEntry).max(100),
  })
  .passthrough();
export type MetaWebhookPayload = z.infer<typeof MetaWebhookPayload>;

export interface MetaAccount {
  /** `instagram` albo `facebook`. Osobne konta, osobne zdrowie, osobne kursory. */
  readonly provider: "instagram" | "facebook";
  /** Page ID albo Instagram Professional Account ID. */
  readonly accountKey: string;
  readonly label: string;
}

export interface NormalizedMetaEvent {
  readonly kind: "message" | "delivery" | "read" | "ignored";
  readonly message?: InboxMessage;
  readonly deliveredMids?: string[];
  readonly reason?: string;
}

/**
 * Normalizacja zdarzeń webhooka.
 *
 * Echo własnej wiadomości (`is_echo`) jest zapisywane jako wiadomość
 * WYCHODZĄCA i oznaczone flagą — nie wolno go ani wyrzucić, ani policzyć jako
 * nowej sprawy. Wyrzucone znika z historii wątku; policzone jako przychodzące
 * budzi zespół w środku nocy powiadomieniem o własnej odpowiedzi.
 */
export function normalizeMetaPayload(
  payload: MetaWebhookPayload,
  accounts: readonly MetaAccount[],
  now: number,
): NormalizedMetaEvent[] {
  const byKey = new Map(accounts.map((entry) => [entry.accountKey, entry]));
  const out: NormalizedMetaEvent[] = [];

  for (const entry of payload.entry) {
    const account = byKey.get(entry.id);
    if (!account) {
      // Nieznane konto: nie zgadujemy, do kogo należy rozmowa.
      out.push({ kind: "ignored", reason: "unknown_account" });
      continue;
    }

    for (const event of entry.messaging ?? []) {
      if (event.delivery) {
        out.push({ kind: "delivery", deliveredMids: event.delivery.mids ?? [] });
        continue;
      }
      if (event.read) {
        out.push({ kind: "read" });
        continue;
      }
      const message = event.message;
      if (!message) {
        out.push({ kind: "ignored", reason: "unsupported_event" });
        continue;
      }
      if (message.is_deleted === true) {
        out.push({ kind: "ignored", reason: "deleted_message" });
        continue;
      }

      const isEcho = message.is_echo === true;
      const senderId = event.sender?.id ?? null;
      const recipientId = event.recipient?.id ?? null;
      // Rozmowa jest identyfikowana przez KLIENTA, nie przez naszą stronę:
      // w echu nadawcą jesteśmy my, więc druga strona jest w `recipient`.
      const counterpartId = isEcho ? recipientId : senderId;
      if (!counterpartId) {
        out.push({ kind: "ignored", reason: "missing_counterpart" });
        continue;
      }

      const key = { provider: account.provider, accountKey: account.accountKey };
      const text = message.text ?? "";
      const sourceCreatedAt =
        typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : null;

      out.push({
        kind: "message",
        message: {
          provider: account.provider,
          accountKey: account.accountKey,
          externalConversationId: counterpartId,
          externalMessageId: message.mid,
          caseId: deriveCaseId(key, counterpartId),
          direction: isEcho ? "outgoing" : "incoming",
          sourceCreatedAt,
          receivedAt: now,
          authorLabel: isEcho ? null : counterpartId,
          subject: null,
          body: text,
          bodyTruncated: false,
          attachments: (message.attachments ?? []).map((attachment, index) => ({
            // URL załącznika NIE jest przechowywany: wygasa, a do tego jest
            // bezpośrednim linkiem do pliku klienta.
            id: `${message.mid}#${index}`,
            fileName: null,
            mimeType: typeof attachment.type === "string" ? attachment.type : null,
            sizeBytes: null,
          })),
          rfcMessageId: null,
          rfcInReplyTo: null,
          rfcReferences: [],
          isEcho,
          // Meta nie ma nagłówków RFC; masowość rozpoznajemy tylko dla poczty.
          bulkHint: false,
          contentFingerprint: contentSha256(
            [message.mid, String(sourceCreatedAt ?? ""), text].join("\u0000"),
          ).slice(0, 32),
        },
      });
    }
  }

  return out;
}

/**
 * Okno wysyłki Meta.
 *
 * Standardowe okno to 24 godziny od ostatniej wiadomości klienta. Po jego
 * wygaśnięciu zwykła wysyłka jest odrzucana przez Meta, więc UI ma
 * zablokować przycisk i powiedzieć prawdę, zamiast pozwolić na próbę,
 * która skończy się błędem po stronie dostawcy.
 */
export const META_SEND_WINDOW_MS = 24 * 60 * 60_000;

export function metaSendWindow(
  lastIncomingAt: number | null,
  now: number,
): { readonly open: boolean; readonly expiresAt: number | null; readonly reason: string | null } {
  if (lastIncomingAt === null) {
    return { open: false, expiresAt: null, reason: "customer_never_wrote" };
  }
  const expiresAt = lastIncomingAt + META_SEND_WINDOW_MS;
  if (now >= expiresAt) return { open: false, expiresAt, reason: "window_expired" };
  return { open: true, expiresAt, reason: null };
}
