import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, type InboxMessage } from "../contract.js";
import { projectCase } from "../project.js";
import { InboxStore, type StoredCase } from "../store.js";
import {
  outgoingHistoryComplete,
  outgoingMessageIdFor,
  outgoingMessagePresent,
  restoreOutgoingMessage,
} from "./record.js";
import { sendReply, type SendTransport } from "./send.js";
import { ingestMetaEvents } from "../providers/meta/ingest.js";

/**
 * Wysłana odpowiedź jako pełna część wątku.
 *
 * Powód istnienia: sukces u dostawcy aktualizował ledger i na tym się kończył.
 * Wątek nie miał naszej wiadomości, sprawa dalej „wymagała reakcji", a kolejny
 * odczyt wyglądał jak klient bez odpowiedzi. System pokazywał jako niezrobioną
 * pracę, którą właśnie wykonano.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-record-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: InboxStore, overrides: Partial<StoredCase> = {}): StoredCase {
  const incoming: InboxMessage = {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: "mid:klient-1",
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
    authorLabel: "klient@example.com",
    subject: "Zamowienie 4411",
    body: "Gdzie moja paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: "klient-1@example.com",
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: "fp-in",
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.accountKey ? { accountKey: overrides.accountKey } : {}),
    ...(overrides.caseId ? { caseId: overrides.caseId } : {}),
    ...(overrides.externalConversationId
      ? { externalConversationId: overrides.externalConversationId }
      : {}),
  };
  store.claimMessage(incoming);

  const record: StoredCase = {
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    subject: "Zamowienie 4411",
    participantLabel: "klient@example.com",
    orderRef: null,
    firstSeenAt: NOW - 10_000,
    lastMessageAt: NOW - 5_000,
    lastIncomingMessageId: "mid:klient-1",
    lastIncomingAt: NOW - 5_000,
    messageCount: 1,
    requiresResponse: true,
    pendingAction: false,
    classifierVersion: CLASSIFIER_VERSION,
    classificationReason: "customer_message",
    needsReview: false,
    sourceClosed: false,
    hasAttachments: false,
    ...overrides,
  };
  store.upsertCase(record);
  return record;
}

const transport = (result: Awaited<ReturnType<SendTransport["send"]>>): SendTransport => ({
  send: async () => result,
});

describe("odpowiedz w watku", () => {
  it("po wyslaniu wiadomosc jest w historii, a sprawa nie czeka juz na reakcje", async () => {
    const store = freshStore();
    seed(store);

    const result = await sendReply({
      store,
      requestId: "req-0000000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj, numer nadania w mailu.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-42" }),
      now: () => NOW,
    });

    expect(result.status).toBe("sent");
    const messages = store.messagesForCase("ic_sprawa");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.direction).toBe("outgoing");
    expect(messages[1]!.body).toContain("Paczka wyszla dzisiaj");
    // Kolejka przestaje pokazywać sprawę jako wymagającą reakcji.
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("kolejna wiadomosc klienta znow otwiera sprawe", async () => {
    const store = freshStore();
    seed(store);
    await sendReply({
      store,
      requestId: "req-0000000000000002",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-42" }),
      now: () => NOW,
    });
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(false);

    store.claimMessage({
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      externalMessageId: "mid:klient-2",
      caseId: "ic_sprawa",
      direction: "incoming",
      sourceCreatedAt: NOW + 60_000,
      receivedAt: NOW + 60_000,
      authorLabel: "klient@example.com",
      subject: "Re: Zamowienie 4411",
      body: "Numer nadania nie dziala, co dalej?",
      bodyTruncated: false,
      attachments: [],
      rfcMessageId: "klient-2@example.com",
      replyToAddress: null,
      rfcInReplyTo: "klient-1@example.com",
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp-in-2",
    });
    const projected = projectCase(store, "ic_sprawa", { internalSenders: ["sklep@brownhouseandtea.pl"] });
    store.upsertCase(projected!);

    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
    expect(store.getCase("ic_sprawa")!.lastIncomingMessageId).toBe("mid:klient-2");
  });

  it("echo Meta sklei sie z zapisana odpowiedzia zamiast ja podwoic", async () => {
    const store = freshStore();
    seed(store, {
      caseId: "ic_sprawa",
      provider: "facebook",
      accountKey: "page-123",
      externalConversationId: "klient-77",
    });

    await sendReply({
      store,
      requestId: "req-0000000000000003",
      caseId: "ic_sprawa",
      text: "Juz sprawdzam",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "m_out_1" }),
      now: () => NOW,
    });

    const before = store.messagesForCase("ic_sprawa").length;

    // Meta odsyła echo tej samej wiadomości z tym samym `mid`.
    const echo = ingestMetaEvents(store, [
      {
        kind: "message",
        message: {
          provider: "facebook",
          accountKey: "page-123",
          externalConversationId: "klient-77",
          externalMessageId: "m_out_1",
          caseId: "ic_sprawa",
          direction: "outgoing",
          sourceCreatedAt: NOW + 500,
          receivedAt: NOW + 500,
          authorLabel: null,
          subject: null,
          body: "Juz sprawdzam",
          bodyTruncated: false,
          attachments: [],
          rfcMessageId: null,
          replyToAddress: null,
          rfcInReplyTo: null,
          rfcReferences: [],
          isEcho: true,
          bulkHint: false,
          contentFingerprint: "fp-echo",
        },
      },
    ]);

    expect(echo.duplicates).toBe(1);
    expect(echo.stored).toBe(0);
    expect(store.messagesForCase("ic_sprawa")).toHaveLength(before);
  });

  it("brak identyfikatora od dostawcy nie gubi odpowiedzi z watku", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000004",
      caseId: "ic_sprawa",
      text: "Odpowiedz bez identyfikatora",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "" }),
      now: () => NOW,
    });

    const outgoing = store.messagesForCase("ic_sprawa").filter((m) => m.direction === "outgoing");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.externalMessageId).toContain("attempt:");
  });

  it("nieudana wysylka NIE dopisuje wiadomosci do watku", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000005",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "failed", code: "http_422", message: "odrzucone" }),
      now: () => NOW,
    });

    expect(store.messagesForCase("ic_sprawa")).toHaveLength(1);
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
  });

  it("stan niepewny tez nie dopisuje wiadomosci: nie wiemy, czy poszla", async () => {
    const store = freshStore();
    seed(store);

    await sendReply({
      store,
      requestId: "req-0000000000000006",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "uncertain", code: "timeout", message: "brak potwierdzenia" }),
      now: () => NOW,
    });

    expect(store.messagesForCase("ic_sprawa")).toHaveLength(1);
    // Sprawa zostaje otwarta: dopisanie odpowiedzi udawałoby wiedzę, której nie mamy.
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
  });

  it("crash po finishSent: powtorzenie NAPRAWIA historie bez drugiego POSTu", async () => {
    const store = freshStore();
    seed(store);
    const calls: string[] = [];

    // 1. Wysylka sie udaje u dostawcy.
    await sendReply({
      store,
      requestId: "req-crash-000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: {
        send: async (attempt) => {
          calls.push(attempt.requestId);
          return { status: "sent", externalMessageId: "resend-crash" };
        },
      },
      now: () => NOW,
    });
    expect(store.messagesForCase("ic_sprawa")).toHaveLength(2);

    // 2. Symulacja awarii ZAPISU historii: kasujemy wiadomosc wychodzaca
    //    z pamieci i z dziennika, zostawiajac ledger w stanie `sent`.
    const dir = dirs[dirs.length - 1]!;
    const path = join(dir, "inbox.jsonl");
    const kept = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.includes('"direction":"outgoing"'))
      .join("\n");
    writeFileSync(path, kept + "\n", "utf8");

    const afterCrash = new InboxStore({ dir });
    expect(afterCrash.getAttempt("req-crash-000000000001")?.status).toBe("sent");
    // Ledger mowi „wyslano", ale watek tego nie ma — dokladnie ten stan.
    expect(afterCrash.messagesForCase("ic_sprawa")).toHaveLength(1);
    expect(
      afterCrash.hasMessage({ provider: "email", accountKey: "sklep" }, "resend:resend-crash"),
    ).toBe(false);

    // 3. Powtorzenie TEGO SAMEGO zadania naprawia historie.
    const repeat = await sendReply({
      store: afterCrash,
      requestId: "req-crash-000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: {
        send: async (attempt) => {
          calls.push(attempt.requestId);
          return { status: "sent", externalMessageId: "resend-crash" };
        },
      },
      now: () => NOW + 60_000,
    });

    expect(repeat.status).toBe("sent");
    expect(repeat.status === "sent" && repeat.repairedHistory).toBe(true);
    // ZERO dodatkowych requestow do dostawcy: wiadomosc u klienta juz jest.
    expect(calls).toEqual(["req-crash-000000000001"]);
    // Watek ma odpowiedz, a sprawa nie czeka juz na reakcje.
    expect(afterCrash.messagesForCase("ic_sprawa")).toHaveLength(2);
    expect(
      afterCrash.hasMessage({ provider: "email", accountKey: "sklep" }, "resend:resend-crash"),
    ).toBe(true);
    expect(afterCrash.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("odtworzona wiadomosc nie udaje, ze zna tresc", async () => {
    const store = freshStore();
    seed(store);
    await sendReply({
      store,
      requestId: "req-crash-000000000002",
      caseId: "ic_sprawa",
      text: "Tajna tresc odpowiedzi",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-x" }),
      now: () => NOW,
    });

    const dir = dirs[dirs.length - 1]!;
    const path = join(dir, "inbox.jsonl");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() && !line.includes('"direction":"outgoing"'))
        .join("\n") + "\n",
      "utf8",
    );

    const afterCrash = new InboxStore({ dir });
    await sendReply({
      store: afterCrash,
      requestId: "req-crash-000000000002",
      caseId: "ic_sprawa",
      text: "Tajna tresc odpowiedzi",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-x" }),
      now: () => NOW + 60_000,
    });

    const outgoing = afterCrash
      .messagesForCase("ic_sprawa")
      .find((message) => message.direction === "outgoing")!;
    // Ledger trzyma hash, nie tekst — odtworzony wpis mowi to wprost.
    expect(outgoing.body).not.toContain("Tajna tresc");
    expect(outgoing.body).toContain("odtworzona z ledgera");
  });

  it("gdy historia jest kompletna, powtorzenie nie zmienia niczego", async () => {
    const store = freshStore();
    seed(store);
    await sendReply({
      store,
      requestId: "req-crash-000000000003",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-y" }),
      now: () => NOW,
    });
    const before = store.messagesForCase("ic_sprawa").length;

    const repeat = await sendReply({
      store,
      requestId: "req-crash-000000000003",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-y" }),
      now: () => NOW + 1_000,
    });
    expect(repeat.status === "sent" && repeat.repairedHistory).toBe(false);
    expect(store.messagesForCase("ic_sprawa")).toHaveLength(before);
  });
});

/**
 * Macierz awarii między `finishSent` a zapisem wiadomości w wątku.
 *
 * To okno zostawia stan najgroźniejszy ze wszystkich: ledger mówi „wysłano",
 * a wątek nie pokazuje odpowiedzi, więc sprawa dalej wygląda na wymagającą
 * reakcji i kolejna osoba pisze do klienta drugi raz. Duplikat u klienta
 * produkuje wtedy człowiek, nie kod — i żadna bramka idempotencji go nie łapie.
 *
 * Rozpoznanie braku musi iść po TEJ próbie, a nie po tym, czy w sprawie jest
 * jakakolwiek wiadomość wychodząca: starsza odpowiedź daje wtedy fałszywe
 * „historia kompletna" i brakujący wpis nie powstaje już nigdy.
 */

/** Kasuje z dziennika linie pasujące do wzorca. Awaria zapisu, nie „symulacja". */
function usunLinie(dir: string, pasuje: (linia: string) => boolean): number {
  const path = join(dir, "inbox.jsonl");
  const linie = readFileSync(path, "utf8")
    .split("\n")
    .filter((linia) => linia.trim().length > 0);
  const zostaje = linie.filter((linia) => !pasuje(linia));
  writeFileSync(path, zostaje.join("\n") + "\n", "utf8");
  return linie.length - zostaje.length;
}

/** Kasuje OSTATNI zapis sprawy: awaria między zapisem wiadomości a projekcją. */
function usunOstatniZapisSprawy(dir: string): void {
  const path = join(dir, "inbox.jsonl");
  const linie = readFileSync(path, "utf8")
    .split("\n")
    .filter((linia) => linia.trim().length > 0);
  for (let i = linie.length - 1; i >= 0; i -= 1) {
    if (linie[i]!.includes('"t":"case"')) {
      linie.splice(i, 1);
      break;
    }
  }
  writeFileSync(path, linie.join("\n") + "\n", "utf8");
}

function wiadomoscKlienta(id: string, at: number, body: string): InboxMessage {
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: id,
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: at,
    receivedAt: at,
    authorLabel: "klient@example.com",
    subject: "Re: Zamowienie 4411",
    body,
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: `${id}@example.com`,
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: `fp-${id}`,
  };
}

describe("awaria miedzy ledgerem `sent` a wpisem w historii", () => {
  it("bez starszej odpowiedzi: powtorzenie odtwarza wpis, dostawca dostaje 1 zadanie", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    const zadania: string[] = [];
    const dostawca: SendTransport = {
      send: async (attempt) => {
        zadania.push(attempt.requestId);
        return { status: "sent", externalMessageId: "resend-1" };
      },
    };

    await sendReply({
      store,
      requestId: "req-luka-0000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: dostawca,
      now: () => NOW,
    });
    store.close();

    // Awaria DOKLADNIE w oknie: ledger `sent` zostaje, wpis w historii i zapis
    // sprawy, ktory po nim nastepowal, znikaja z dziennika.
    expect(usunLinie(dir, (linia) => linia.includes('"resend:resend-1"'))).toBe(1);
    usunOstatniZapisSprawy(dir);

    const poAwarii = new InboxStore({ dir });
    expect(poAwarii.getAttempt("req-luka-0000000000001")?.status).toBe("sent");
    expect(poAwarii.messagesForCase("ic_sprawa")).toHaveLength(1);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(true);

    const powtorka = await sendReply({
      store: poAwarii,
      requestId: "req-luka-0000000000001",
      caseId: "ic_sprawa",
      text: "Paczka wyszla dzisiaj.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: dostawca,
      now: () => NOW + 60_000,
    });

    expect(powtorka.status === "sent" && powtorka.repairedHistory).toBe(true);
    // Do dostawcy poszlo dokladnie jedno zadanie: wiadomosc u klienta juz jest.
    expect(zadania).toEqual(["req-luka-0000000000001"]);
    expect(
      poAwarii.hasMessage({ provider: "email", accountKey: "sklep" }, "resend:resend-1"),
    ).toBe(true);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("ze starsza odpowiedzia: naprawa odtwarza WLASCIWY brakujacy wpis", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    const zadania: string[] = [];
    const dostawca = (externalMessageId: string): SendTransport => ({
      send: async (attempt) => {
        zadania.push(attempt.requestId);
        return { status: "sent", externalMessageId };
      },
    });

    // Starsza odpowiedz w tej samej sprawie — zamknieta, kompletna.
    await sendReply({
      store,
      requestId: "req-stara-000000000001",
      caseId: "ic_sprawa",
      text: "Sprawdzam status paczki.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: dostawca("resend-stara"),
      now: () => NOW,
    });

    // Klient pisze ponownie, sprawa znow czeka na reakcje.
    store.claimMessage(wiadomoscKlienta("mid:klient-2", NOW + 60_000, "Nadal nie mam paczki, co dalej?"));
    store.upsertCase(projectCase(store, "ic_sprawa")!);
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);

    // Druga odpowiedz idzie do klienta i ginie w oknie zapisu.
    await sendReply({
      store,
      requestId: "req-nowa-0000000000001",
      caseId: "ic_sprawa",
      text: "Paczka jest w drodze, numer nadania ponizej.",
      expectedLastIncomingMessageId: "mid:klient-2",
      transport: dostawca("resend-nowa"),
      now: () => NOW + 120_000,
    });
    store.close();

    expect(usunLinie(dir, (linia) => linia.includes('"resend:resend-nowa"'))).toBe(1);
    usunOstatniZapisSprawy(dir);

    const poAwarii = new InboxStore({ dir });
    const proba = poAwarii.getAttempt("req-nowa-0000000000001")!;
    expect(proba.status).toBe("sent");
    // Starsza odpowiedz W SPRAWIE JEST — i wlasnie ona myli ocene „po kierunku".
    expect(
      poAwarii.messagesForCase("ic_sprawa").some((m) => m.direction === "outgoing"),
    ).toBe(true);
    // Ocena po TEJ probie mowi prawde: brakujacego wpisu nie ma.
    expect(outgoingMessagePresent(poAwarii, proba)).toBe(false);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(true);

    const powtorka = await sendReply({
      store: poAwarii,
      requestId: "req-nowa-0000000000001",
      caseId: "ic_sprawa",
      text: "Paczka jest w drodze, numer nadania ponizej.",
      expectedLastIncomingMessageId: "mid:klient-2",
      transport: dostawca("resend-nowa"),
      now: () => NOW + 180_000,
    });

    expect(powtorka.status === "sent" && powtorka.repairedHistory).toBe(true);
    expect(zadania).toEqual(["req-stara-000000000001", "req-nowa-0000000000001"]);

    const wychodzace = poAwarii
      .messagesForCase("ic_sprawa")
      .filter((m) => m.direction === "outgoing");
    expect(wychodzace.map((m) => m.externalMessageId)).toEqual([
      "resend:resend-stara",
      "resend:resend-nowa",
    ]);
    // Starsza odpowiedz zostaje nietknieta: naprawa dotyczy JEDNEJ proby.
    expect(wychodzace[0]!.body).toContain("Sprawdzam status paczki");
    expect(outgoingMessagePresent(poAwarii, poAwarii.getAttempt("req-nowa-0000000000001")!)).toBe(true);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("druga naprawa jest bezczynna: nie dokłada trzeciej wiadomosci", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    await sendReply({
      store,
      requestId: "req-stara-000000000002",
      caseId: "ic_sprawa",
      text: "Sprawdzam status paczki.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-stara-2" }),
      now: () => NOW,
    });
    store.claimMessage(wiadomoscKlienta("mid:klient-2", NOW + 60_000, "I co dalej?"));
    store.upsertCase(projectCase(store, "ic_sprawa")!);
    await sendReply({
      store,
      requestId: "req-nowa-0000000000002",
      caseId: "ic_sprawa",
      text: "Paczka jest w drodze.",
      expectedLastIncomingMessageId: "mid:klient-2",
      transport: transport({ status: "sent", externalMessageId: "resend-nowa-2" }),
      now: () => NOW + 120_000,
    });
    store.close();

    usunLinie(dir, (linia) => linia.includes('"resend:resend-nowa-2"'));
    usunOstatniZapisSprawy(dir);
    const poAwarii = new InboxStore({ dir });
    const proba = poAwarii.getAttempt("req-nowa-0000000000002")!;

    const pierwsza = restoreOutgoingMessage(poAwarii, proba, NOW + 180_000);
    expect(pierwsza.restoredMessage).toBe(true);
    const poPierwszej = poAwarii.messagesForCase("ic_sprawa").length;
    expect(poPierwszej).toBe(4);

    const druga = restoreOutgoingMessage(poAwarii, proba, NOW + 240_000);
    expect(druga.restoredMessage).toBe(false);
    expect(druga.present).toBe(true);
    expect(poAwarii.messagesForCase("ic_sprawa")).toHaveLength(poPierwszej);
    expect(
      poAwarii.messagesForCase("ic_sprawa").filter((m) => m.direction === "outgoing"),
    ).toHaveLength(2);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("naprawa nie wykonuje ZADNEGO zadania do dostawcy", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    const zadania: string[] = [];
    await sendReply({
      store,
      requestId: "req-bez-wysylki-00001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: {
        send: async (attempt) => {
          zadania.push(attempt.requestId);
          return { status: "sent", externalMessageId: "resend-bez" };
        },
      },
      now: () => NOW,
    });
    expect(zadania).toHaveLength(1);
    store.close();

    usunLinie(dir, (linia) => linia.includes('"resend:resend-bez"'));
    usunOstatniZapisSprawy(dir);
    const poAwarii = new InboxStore({ dir });

    // Naprawa wolana WPROST, bez drogi wysylkowej: nie ma dokad wyslac.
    const wynik = restoreOutgoingMessage(
      poAwarii,
      poAwarii.getAttempt("req-bez-wysylki-00001")!,
      NOW + 60_000,
    );
    expect(wynik.restoredMessage).toBe(true);
    expect(zadania).toHaveLength(1);

    // Ta sama naprawa przez powtorzone zadanie: atrapa dostawcy wybucha,
    // gdyby ktokolwiek probowal wyslac drugi raz.
    const powtorka = await sendReply({
      store: poAwarii,
      requestId: "req-bez-wysylki-00001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: {
        send: async () => {
          throw new Error("zadne zadanie do dostawcy nie ma prawa tu polecieć");
        },
      },
      now: () => NOW + 120_000,
    });
    expect(powtorka.status).toBe("sent");
    expect(zadania).toHaveLength(1);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("bez identyfikatora dostawcy wpis jest szukany po deterministycznym kluczu z requestId", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    await sendReply({
      store,
      requestId: "req-bez-id-000000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz bez identyfikatora",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "" }),
      now: () => NOW,
    });
    store.close();

    usunLinie(dir, (linia) => linia.includes('"attempt:req-bez-id-000000001"'));
    usunOstatniZapisSprawy(dir);

    const poAwarii = new InboxStore({ dir });
    const proba = poAwarii.getAttempt("req-bez-id-000000001")!;
    expect(outgoingMessageIdFor(proba)).toBe("attempt:req-bez-id-000000001");
    expect(outgoingMessagePresent(poAwarii, proba)).toBe(false);

    expect(restoreOutgoingMessage(poAwarii, proba, NOW + 60_000).restoredMessage).toBe(true);
    expect(outgoingMessagePresent(poAwarii, poAwarii.getAttempt("req-bez-id-000000001")!)).toBe(true);
    expect(poAwarii.getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("`historia kompletna` mowi prawde takze przy starszej odpowiedzi", async () => {
    const store = freshStore();
    const dir = dirs[dirs.length - 1]!;
    seed(store);
    await sendReply({
      store,
      requestId: "req-stara-000000000003",
      caseId: "ic_sprawa",
      text: "Sprawdzam status paczki.",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: transport({ status: "sent", externalMessageId: "resend-stara-3" }),
      now: () => NOW,
    });
    store.claimMessage(wiadomoscKlienta("mid:klient-2", NOW + 60_000, "I co dalej?"));
    store.upsertCase(projectCase(store, "ic_sprawa")!);
    await sendReply({
      store,
      requestId: "req-nowa-0000000000003",
      caseId: "ic_sprawa",
      text: "Paczka jest w drodze.",
      expectedLastIncomingMessageId: "mid:klient-2",
      transport: transport({ status: "sent", externalMessageId: "resend-nowa-3" }),
      now: () => NOW + 120_000,
    });
    store.close();

    usunLinie(dir, (linia) => linia.includes('"resend:resend-nowa-3"'));
    usunOstatniZapisSprawy(dir);
    const poAwarii = new InboxStore({ dir });

    // Starsza proba: jej wpis w watku jest, wiec historia dla NIEJ jest spojna.
    expect(outgoingHistoryComplete(poAwarii, poAwarii.getAttempt("req-stara-000000000003")!)).toBe(
      true,
    );
    // Nowa proba: wpisu brak, mimo ze „jakas" wychodzaca w sprawie jest.
    expect(outgoingHistoryComplete(poAwarii, poAwarii.getAttempt("req-nowa-0000000000003")!)).toBe(
      false,
    );

    restoreOutgoingMessage(poAwarii, poAwarii.getAttempt("req-nowa-0000000000003")!, NOW + 180_000);
    expect(outgoingHistoryComplete(poAwarii, poAwarii.getAttempt("req-nowa-0000000000003")!)).toBe(
      true,
    );
  });

  it("proba, ktora nie jest `sent`, nie ma czego naprawiac", () => {
    const store = freshStore();
    seed(store);
    const proba = {
      requestId: "req-niewyslana-00001",
      caseId: "ic_sprawa",
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      contentSha256: "a".repeat(64),
      contentLength: 5,
      expectedLastIncomingMessageId: "mid:klient-1",
      expectedLastIncomingAt: NOW - 5_000,
      idempotencyKey: "k",
      status: "uncertain" as const,
      externalMessageId: null,
      postStartedAt: NOW,
      completedAt: null,
      failureCode: "timeout",
      createdAt: NOW,
      deliveryState: "unknown" as const,
    };
    const wynik = restoreOutgoingMessage(store, proba, NOW + 1_000);
    expect(wynik).toMatchObject({ present: false, restoredMessage: false, blockedBy: "not_sent" });
    // Sprawa zostaje otwarta: nie wiemy, czy cokolwiek poszlo do klienta.
    expect(store.getCase("ic_sprawa")!.requiresResponse).toBe(true);
    expect(store.messagesForCase("ic_sprawa")).toHaveLength(1);
  });
});
