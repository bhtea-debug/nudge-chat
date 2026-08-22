import { describe, expect, it } from "vitest";
import { classifyCase } from "./classify.js";
import type { InboxMessage } from "./contract.js";

/**
 * Mierzalna jakość klasyfikatora.
 *
 * Testy jednostkowe mówią „ta reguła działa". Nie mówią, czy CAŁOŚĆ jest
 * użyteczna: klasyfikator, który wszystko oznacza jako wymagające reakcji,
 * przechodzi każdy test z osobna i jest bezwartościowy w praktyce.
 *
 * Zestaw jest zanonimizowany i syntetyczny — odwzorowuje kształt ruchu
 * (pytania, reklamacje, newslettery, automaty, poczta wewnętrzna), a nie
 * prawdziwą korespondencję klientów.
 *
 * Progi są celowo asymetryczne. Przeoczona reklamacja kosztuje klienta,
 * fałszywy alarm kosztuje jedno spojrzenie — więc recall musi być wyższy
 * od precision i tak są ustawione progi.
 */

const COMPANY = "brownhouseandtea.pl";
let clock = 1_700_000_000_000;

function message(partial: Partial<InboxMessage> & { body: string }): InboxMessage {
  clock += 60_000;
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv",
    externalMessageId: `m-${clock}`,
    caseId: "ic",
    direction: "incoming",
    sourceCreatedAt: clock,
    receivedAt: clock,
    authorLabel: "klient@example.com",
    subject: "Wiadomosc",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: `fp-${clock}`,
    ...partial,
  };
}

const ours = (body: string) =>
  message({ body, direction: "outgoing", authorLabel: `sklep@${COMPANY}` });

interface Sample {
  readonly name: string;
  /** true = sprawa klienta, która MUSI trafić do kolejki. */
  readonly actionable: boolean;
  readonly messages: InboxMessage[];
}

const SAMPLES: Sample[] = [
  // ── powinny trafić do kolejki ──────────────────────────────────────────
  {
    name: "pytanie przed zakupem",
    actionable: true,
    messages: [message({ body: "Czy matcha ceremonialna jest dostepna w 100 g?" })],
  },
  {
    name: "reklamacja",
    actionable: true,
    messages: [message({ body: "Puszka dotarla wgnieciona, prosze o wymiane." })],
  },
  {
    name: "problem platnosci",
    actionable: true,
    messages: [message({ body: "Zaplacilem dwa razy za zamowienie 4411, prosze o zwrot." })],
  },
  {
    name: "problem wysylki",
    actionable: true,
    messages: [message({ body: "Paczka nie dotarla, sledzenie stoi od tygodnia." })],
  },
  {
    name: "prosba o zmiane adresu",
    actionable: true,
    messages: [message({ body: "Prosze zmienic adres dostawy na inny, jeszcze przed wysylka." })],
  },
  {
    name: "prosba o fakture",
    actionable: true,
    messages: [message({ body: "Prosze o fakture do zamowienia 4411 na firme." })],
  },
  {
    name: "klient wraca po naszej odpowiedzi",
    actionable: true,
    messages: [
      message({ body: "Gdzie moja paczka?" }),
      ours("Nadana wczoraj, numer w mailu."),
      message({ body: "Numer nie dziala, co dalej?" }),
    ],
  },
  {
    name: "podziekowanie z doklejonym pytaniem",
    actionable: true,
    messages: [
      message({ body: "Kiedy zamowienie bedzie spakowane?" }),
      ours("Jest juz spakowane."),
      message({ body: "Dziekuje, a czy dorzucicie probki?" }),
    ],
  },
  {
    name: "pytanie hurtowe",
    actionable: true,
    messages: [message({ body: "Prosze o cennik hurtowy i warunki wspolpracy." })],
  },
  {
    name: "zapytanie z systemu mailingowego kontrahenta",
    actionable: true,
    messages: [message({ body: "Czy mozecie potwierdzic termin dostawy?", bulkHint: true })],
  },

  // ── NIE powinny alarmować ─────────────────────────────────────────────
  {
    name: "newsletter",
    actionable: false,
    messages: [message({ body: "Nowosci w naszej ofercie", subject: "Newsletter sierpien", bulkHint: true })],
  },
  {
    name: "marketing bez pytania",
    actionable: false,
    messages: [message({ body: "Rabat 20 procent tylko dzisiaj.", bulkHint: true })],
  },
  {
    name: "autoresponder",
    actionable: false,
    messages: [message({ body: "Jestem na urlopie do 30 sierpnia.", subject: "Automatyczna odpowiedz" })],
  },
  {
    name: "niedoreczenie",
    actionable: false,
    messages: [
      message({ subject: "Delivery Status Notification (Failure)", body: "Nie dostarczono do adresata." }),
    ],
  },
  {
    name: "poczta wewnetrzna",
    actionable: false,
    messages: [message({ body: "Kasia, dorzuc prosze etykiety.", authorLabel: `biuro@${COMPANY}` })],
  },
  {
    name: "poczta wewnetrzna z nowego adresu",
    actionable: false,
    messages: [message({ body: "Przekazuje zamowienie.", authorLabel: `nowa.osoba@${COMPANY}` })],
  },
  {
    name: "samo podziekowanie po odpowiedzi",
    actionable: false,
    messages: [
      message({ body: "Czy zamowienie jest spakowane?" }),
      ours("Tak, czeka na kuriera."),
      message({ body: "Dziekuje!" }),
    ],
  },
  {
    name: "sprawa zalatwiona, klient milczy",
    actionable: false,
    messages: [message({ body: "Gdzie moja paczka?" }), ours("Nadana wczoraj, numer w mailu.")],
  },
  {
    name: "obietnica wysylki i klient czeka",
    actionable: false,
    messages: [
      message({ body: "Gdzie moja paczka?" }),
      ours("Wysylamy zastepcza dzisiaj."),
      message({ body: "Czekam wiec" }),
    ],
  },
  {
    name: "raport automatyczny bez pytania",
    actionable: false,
    messages: [message({ body: "Raport dobowy w zalaczeniu.", bulkHint: true })],
  },
];

function evaluate() {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  const mistakes: string[] = [];

  for (const sample of SAMPLES) {
    const result = classifyCase({
      messages: sample.messages,
      sourceClosed: false,
      internalSenders: [`sklep@${COMPANY}`],
      companyDomains: [COMPANY],
    });
    const predicted = result.requiresResponse;
    if (predicted && sample.actionable) truePositive += 1;
    else if (predicted && !sample.actionable) {
      falsePositive += 1;
      mistakes.push(`fałszywy alarm: ${sample.name} (${result.reason})`);
    } else if (!predicted && sample.actionable) {
      falseNegative += 1;
      mistakes.push(`PRZEOCZONA SPRAWA: ${sample.name} (${result.reason})`);
    } else trueNegative += 1;
  }

  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return { precision, recall, truePositive, falsePositive, falseNegative, trueNegative, mistakes };
}

describe("jakosc klasyfikacji na zestawie kontrolnym", () => {
  it("nie przeocza ANI JEDNEJ sprawy klienta", () => {
    const result = evaluate();
    // Recall 1.0 jest warunkiem twardym: przeoczona reklamacja kosztuje klienta,
    // a tego nie odrabia żadna liczba poprawnie odsianych newsletterów.
    expect(result.mistakes.filter((entry) => entry.includes("PRZEOCZONA"))).toEqual([]);
    expect(result.recall).toBe(1);
  });

  it("odsiewa szum: precyzja powyzej progu", () => {
    const result = evaluate();
    // Próg niższy od recall i to jest świadome: wolimy fałszywy alarm
    // od ciszy. Poniżej 0,7 kolejka przestaje być użyteczna.
    expect(result.precision).toBeGreaterThanOrEqual(0.7);
  });

  it("wiekszosc szumu jest odrzucana, a nie tylko oznaczana", () => {
    const result = evaluate();
    const noise = SAMPLES.filter((sample) => !sample.actionable).length;
    expect(result.trueNegative / noise).toBeGreaterThanOrEqual(0.8);
  });

  it("niejednoznaczne trafiaja do kolejki OZNACZONE, nie wtopione w tlo", () => {
    const ambiguous = classifyCase({
      messages: [message({ body: "Czy mozecie potwierdzic termin dostawy?", bulkHint: true })],
      sourceClosed: false,
      companyDomains: [COMPANY],
    });
    expect(ambiguous.requiresResponse).toBe(true);
    expect(ambiguous.needsReview).toBe(true);
    expect(ambiguous.reason).toBe("needs_review");
  });

  it("klasyfikator NIE oznacza wszystkiego jako wymagajace reakcji", () => {
    const result = evaluate();
    // Sanity check calosci: klasyfikator, ktory zawsze mowi „tak", przeszedlby
    // kazdy test z osobna i byl bezuzyteczny.
    expect(result.trueNegative).toBeGreaterThan(0);
    expect(result.falsePositive).toBeLessThan(SAMPLES.filter((s) => !s.actionable).length);
  });
});
