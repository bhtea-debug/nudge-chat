import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryState } from "./ledger.js";

/**
 * Webhooki statusu Resend (Svix).
 *
 * Podpis liczony jest z `svix-id.svix-timestamp.body`, sekretem zakodowanym
 * base64 po prefiksie `whsec_`. Nagłówek podpisu może zawierać KILKA wersji
 * rozdzielonych spacją — obsługa tylko pierwszej łamie się cicho w dniu rotacji
 * sekretu, więc sprawdzamy każdą.
 *
 * Dokumentacja: https://resend.com/docs/webhooks/introduction
 */

const TOLERANCE_MS = 5 * 60_000;

export interface ResendWebhookVerification {
  readonly rawBody: string;
  readonly svixId: string | null | undefined;
  readonly svixTimestamp: string | null | undefined;
  readonly svixSignature: string | null | undefined;
  readonly secret: string;
  readonly now: number;
}

export function verifyResendWebhook(input: ResendWebhookVerification): boolean {
  const { svixId, svixTimestamp, svixSignature, secret } = input;
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  // Ochrona przed powtórzeniem: podpis sprzed godziny jest poprawny
  // kryptograficznie i bezwartościowy operacyjnie.
  if (Math.abs(input.now - timestampSeconds * 1_000) > TOLERANCE_MS) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (secretBytes.length === 0) return false;

  const signed = `${svixId}.${svixTimestamp}.${input.rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signed, "utf8").digest();

  for (const part of svixSignature.split(" ")) {
    const [, value] = part.split(",");
    if (!value) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

/** Mapowanie typu zdarzenia Resend na stan dostarczenia w ledgerze. */
export function resendDeliveryState(eventType: string): DeliveryState | null {
  switch (eventType) {
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.delivery_delayed":
    case "email.sent":
      return null;
    case "email.failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Deduplikacja zdarzeń webhooka po `svix-id`.
 *
 * Svix ponawia doręczenie, więc to samo zdarzenie przychodzi kilka razy.
 * Bez deduplikacji każde powtórzenie wykonywałoby efekt uboczny ponownie.
 */
export class WebhookDedup {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 24 * 60 * 60_000) {}

  /** true = zdarzenie nowe i wolno je przetworzyć. */
  accept(id: string, now: number): boolean {
    this.evict(now);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }

  private evict(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(id);
    }
  }
}
