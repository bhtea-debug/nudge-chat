export type AlertClass = "A" | "B" | "C";

export interface BusinessEvent {
  readonly source: "mail" | "chat" | "system";
  readonly eventType: "new_order" | "message";
  /** Kanoniczny identyfikator klienta, nadany przed warstwą polityk. */
  readonly customerId: string | null;
  readonly externalRef: string | null;
}

export interface BusinessPolicyDecision {
  readonly policyId: string;
  readonly classification: AlertClass;
  readonly reason: string;
}

export const ROSSMANN_NEW_ORDER_POLICY_ID = "rossmann-new-order-always-a-v1";

/**
 * Jawne decyzje właściciela firmy, a nie heurystyki ważności.
 *
 * Model nie ma zgadywać, że strategiczny klient jest strategiczny. Warstwa
 * wejściowa najpierw normalizuje zdarzenie do customerId/eventType, a dopiero
 * ten moduł stosuje zatwierdzoną politykę. Brak decyzji oznacza: oceń modelem.
 */
export function classifyByBusinessPolicy(
  event: BusinessEvent,
): BusinessPolicyDecision | null {
  if (
    event.source === "mail" &&
    event.eventType === "new_order" &&
    event.customerId === "rossmann" &&
    event.externalRef
  ) {
    return {
      policyId: ROSSMANN_NEW_ORDER_POLICY_ID,
      classification: "A",
      reason: "nowe zamówienie Rossmann jest alarmem A zgodnie z decyzją właściciela",
    };
  }

  return null;
}

