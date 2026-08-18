import { describe, expect, it } from "vitest";
import {
  ROSSMANN_NEW_ORDER_POLICY_ID,
  classifyByBusinessPolicy,
  type BusinessEvent,
} from "../src/classification/business-policy.js";

const event = (overrides: Partial<BusinessEvent> = {}): BusinessEvent => ({
  source: "mail",
  eventType: "new_order",
  customerId: "rossmann",
  externalRef: "2307348",
  ...overrides,
});

describe("jawne polityki biznesowe", () => {
  it("każde znormalizowane nowe zamówienie Rossmann klasyfikuje jako A", () => {
    expect(classifyByBusinessPolicy(event())).toEqual({
      policyId: ROSSMANN_NEW_ORDER_POLICY_ID,
      classification: "A",
      reason: "nowe zamówienie Rossmann jest alarmem A zgodnie z decyzją właściciela",
    });
  });

  it.each([
    event({ customerId: "inny-klient" }),
    event({ eventType: "message" }),
    event({ source: "chat" }),
    event({ externalRef: null }),
  ])("nie rozszerza decyzji na inne zdarzenia: %j", (input) => {
    expect(classifyByBusinessPolicy(input)).toBeNull();
  });

  it("nie reaguje na samo słowo Rossmann w treści — wymaga customerId", () => {
    expect(
      classifyByBusinessPolicy(
        event({ customerId: null, externalRef: "Rossmann Order 2307348" }),
      ),
    ).toBeNull();
  });
});
