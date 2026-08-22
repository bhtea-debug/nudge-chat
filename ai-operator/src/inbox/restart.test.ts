import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, type InboxMessage } from "./contract.js";
import type { InboxConfig } from "./config.js";
import { handleInboxReply } from "./http.js";
import { createRuntime } from "./runtime.js";
import { InboxStore, type OutboundAttempt, type StoredCase } from "./store.js";
import {
  PREPARED_TTL_MS,
  beginSending,
  expirePrepared,
  expirePreparedAttempts,
  markUncertain,
  prepareAttempt,
  resolveUncertain,
} from "./outbound/ledger.js";
import { sendReply } from "./outbound/send.js";
import { ingestMetaEvents } from "./providers/meta/ingest.js";

/**
 * Awarie w połowie operacji.
 *
 * Restart procesu w losowym momencie jest normalnym zdarzeniem na Railway
 * (deploy, OOM, restart platformy). Te testy sprawdzają, że każdy taki moment
 * zostawia stan, z którego da się wyjść bez utraty wiadomości i bez duplikatu.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

/** Minimalna konfiguracja: jedno konto e-mail, bez wysylki na zewnatrz. */
function config(): InboxConfig {
  return {
    enabled: true,
    stateDir: "state",
    email: [
      {
        accountKey: "sklep",
        label: "E-mail sklep",
        address: "sklep@brownhouseandtea.pl",
        folder: "INBOX",
        sentFolder: null,
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "sklep",
        pass: "x",
      },
    ],
    meta: [],
    allegroEnabled: false,
    outbound: {
      resendApiKey: null,
      resendWebhookSecret: null,
      metaAppSecret: null,
      metaVerifyToken: null,
    },
    backfillDays: 30,
    tickFirstDelayMs: 100,
    tickIntervalMs: 1_000,
    backfillMode: "preview",
    companyDomains: ["brownhouseandtea.pl"],
  };
}

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-restart-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function message(partial: Partial<InboxMessage> = {}): InboxMessage {
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: "mid:klient-1",
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
    authorLabel: "klient@example.com",
    subject: "Zamowienie",
    body: "Gdzie paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: "klient-1@example.com",
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: "fp1",
    ...partial,
  };
}

function seedCase(store: InboxStore, overrides: Partial<StoredCase> = {}): StoredCase {
  const record: StoredCase = {
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    subject: "Zamowienie",
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

describe("restart w polowie operacji", () => {
  it("restart po trwalym zapisie, przed zatwierdzeniem kursora, nie gubi wiadomosci", () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    before.claimMessage(message());
    // Kursor NIE zostal zatwierdzony: proces padl dokladnie tutaj.

    const after = new InboxStore({ dir });
    expect(after.allMessages()).toHaveLength(1);
    expect(after.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
    // Powtorzone pobranie tej samej partii jest deduplikowane.
    expect(after.claimMessage(message())).toBe(false);
    expect(after.allMessages()).toHaveLength(1);
  });

  it("restart po claimie wysylki, przed requestem, zostawia blokade", async () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    seedCase(before);
    const prepared = prepareAttempt({
      store: before,
      requestId: "req-0000000000000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    expect(prepared.ok).toBe(true);
    beginSending(before, "req-0000000000000001", NOW);
    // Proces pada przed wykonaniem requestu.

    const after = new InboxStore({ dir });
    const attempt = after.getAttempt("req-0000000000000001")!;
    expect(attempt.status).toBe("sending");
    expect(attempt.postStartedAt).toBe(NOW);

    // Inny requestId nie moze wystartowac: blokada przezyla restart.
    const second = await sendReply({
      store: after,
      requestId: "req-0000000000000002",
      caseId: "ic_sprawa",
      text: "Druga proba",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: { send: async () => ({ status: "sent", externalMessageId: "x" }) },
      now: () => NOW + 1_000,
    });
    expect(second).toMatchObject({ status: "rejected", code: "active_attempt_exists" });

    /*
     * Blokada MUSI miec wyjscie.
     *
     * Utrwalone `sending` bez drogi rozstrzygniecia zamykalo sprawe na zawsze:
     * anulowac nie wolno (request mogl polecieć), a rozstrzygac sie nie dalo.
     * Po odczekaniu czlowiek sprawdza u dostawcy i decyduje — bez drugiego POSTu.
     */
    const zapytania: string[] = [];
    const runtime = createRuntime(config(), after);
    const rozstrzygniecie = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 200_000,
      fetchImpl: (async (input: unknown) => {
        zapytania.push(String(input));
        throw new Error("zaden request nie ma prawa tu polecieć");
      }) as unknown as typeof fetch,
      body: {
        operation: "resolve_not_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_NOT_SENT",
        requestId: "req-0000000000000001",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });
    expect(rozstrzygniecie.status).toBe(200);
    expect(after.getAttempt("req-0000000000000001")?.status).toBe("failed");
    expect(zapytania).toHaveLength(0);

    // Sprawa jest odblokowana: kolejna proba przechodzi.
    expect(after.activeAttemptForCase("ic_sprawa")).toBeNull();
  });

  it("utrwalone `sending` nie da sie rozstrzygnac przed odczekaniem", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store);
    prepareAttempt({
      store,
      requestId: "req-sending-000000001",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-sending-000000001", NOW);

    // Odpowiedz dostawcy moze jeszcze przyjsc: przedwczesne rozstrzygniecie
    // bylaby zgadywanka, a nie sprawdzeniem.
    expect(resolveUncertain(store, "req-sending-000000001", "sent", NOW + 1_000)).toMatchObject({
      ok: false,
      code: "too_early",
    });
    expect(store.getAttempt("req-sending-000000001")?.status).toBe("sending");
  });

  it("restart po requescie, przed odczytem odpowiedzi, daje stan niepewny do rozstrzygniecia", () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    seedCase(before);
    prepareAttempt({
      store: before,
      requestId: "req-0000000000000003",
      caseId: "ic_sprawa",
      text: "Odpowiedz",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(before, "req-0000000000000003", NOW);
    markUncertain(before, "req-0000000000000003", "restart_before_response");

    const after = new InboxStore({ dir });
    expect(after.getAttempt("req-0000000000000003")?.status).toBe("uncertain");
    // Rozstrzygniecie recznie jest mozliwe dopiero po odczekaniu.
    expect(resolveUncertain(after, "req-0000000000000003", "sent", NOW + 1_000).ok).toBe(false);
    expect(resolveUncertain(after, "req-0000000000000003", "sent", NOW + 200_000)).toMatchObject({
      ok: true,
      changed: true,
    });
    // Ponowienie z tym samym wynikiem: sukces, ale bez ponownego zapisu.
    expect(resolveUncertain(after, "req-0000000000000003", "sent", NOW + 300_000)).toMatchObject({
      ok: true,
      changed: false,
    });
    // Wynik sprzeczny nie odwraca stanu koncowego.
    expect(resolveUncertain(after, "req-0000000000000003", "not_sent", NOW + 300_000)).toMatchObject({
      ok: false,
      code: "conflicting_resolution:sent",
    });
    expect(after.getAttempt("req-0000000000000003")?.completedAt).toBe(NOW + 200_000);
  });

  it("reczne `dostarczona` NAPRAWIA historie i nie wysyla niczego drugi raz", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store);
    prepareAttempt({
      store,
      requestId: "req-0000000000000009",
      caseId: "ic_sprawa",
      text: "Odpowiedz, ktorej los byl nieznany",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-0000000000000009", NOW);
    markUncertain(store, "req-0000000000000009", "restart_before_response");

    /*
     * Sam ledger nie wystarcza.
     *
     * Po recznym potwierdzeniu „u dostawcy jest" watek MUSI pokazac odpowiedz.
     * Inaczej sprawa dalej wyglada na bez odpowiedzi i kolejna osoba pisze do
     * klienta drugi raz — czyli reczne rozstrzygniecie samo produkuje duplikat,
     * przed ktorym mialo chronic.
     */
    const wysylki: string[] = [];
    const runtime = createRuntime(config(), store);
    const result = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 200_000,
      body: {
        operation: "resolve_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT",
        requestId: "req-0000000000000009",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { status: "sent", manuallyResolved: true, repairedHistory: true },
    });
    // ZERO wysylek do dostawcy: rozstrzygniecie jest zapisem, nie ponowieniem.
    expect(wysylki).toHaveLength(0);

    // Odpowiedz jest w watku, takze po restarcie procesu.
    const after = new InboxStore({ dir });
    const wychodzace = after
      .messagesForCase("ic_sprawa")
      .filter((message) => message.direction === "outgoing");
    expect(wychodzace).toHaveLength(1);
    // Tresci ledger nie przechowuje, wiec odtworzony wpis NIE moze jej udawac.
    expect(wychodzace[0]!.body).toContain("odtworzona z ledgera");

    /*
     * Powtorzenie ZGODNEGO rozstrzygniecia jest sukcesem, nie bledem.
     *
     * Ten scenariusz jest najczestszy ze wszystkich: zapis poszedl, odpowiedz
     * do czlowieka nie doszla, wiec klika drugi raz. Odbicie go bledem uczy,
     * ze przycisk „nie zadzialal", i pcha do szukania obejscia. Stan koncowy
     * zostaje ten sam, historia nie rosnie, do dostawcy nic nie leci.
     */
    const powtorka = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 300_000,
      fetchImpl: (async () => {
        throw new Error("zaden request nie ma prawa tu polecieć");
      }) as unknown as typeof fetch,
      body: {
        operation: "resolve_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT",
        requestId: "req-0000000000000009",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });
    expect(powtorka.status).toBe(200);
    // Nic nie zostalo naprawione po raz drugi ani zapisane od nowa.
    expect(powtorka.body).toMatchObject({ ok: true, data: { repairedHistory: false } });
    const attempt = store.getAttempt("req-0000000000000009")!;
    expect(attempt.status).toBe("sent");
    // Czas rozstrzygniecia zostaje ten pierwotny: powtorka niczego nie przepisuje.
    expect(attempt.completedAt).toBe(NOW + 200_000);
    expect(
      new InboxStore({ dir })
        .messagesForCase("ic_sprawa")
        .filter((message) => message.direction === "outgoing"),
    ).toHaveLength(1);

    /*
     * SPRZECZNE rozstrzygniecie jest odrzucane.
     *
     * Stan koncowy nie moze sie cofnac: wiadomosc u klienta juz jest, a wpis
     * „nie wyslano" zamienilby ja w niewidzialna i sprawa poszlaby drugi raz.
     */
    const sprzecznosc = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 400_000,
      body: {
        operation: "resolve_not_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_NOT_SENT",
        requestId: "req-0000000000000009",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });
    expect(sprzecznosc.status).toBe(409);
    expect(sprzecznosc.body).toMatchObject({ error: "conflicting_resolution:sent" });
    expect(store.getAttempt("req-0000000000000009")?.status).toBe("sent");
  });

  it("rozstrzygniecie `wyslano` ze stanu `sending` odtwarza wiadomosc DOKLADNIE raz", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store);
    prepareAttempt({
      store,
      requestId: "req-sending-000000002",
      caseId: "ic_sprawa",
      text: "Odpowiedz, ktora moze byla u dostawcy",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-sending-000000002", NOW);
    // Proces pada w oknie miedzy zapisem `sending` a POST-em. Czlowiek sprawdza
    // u dostawcy i widzi wiadomosc: rozstrzyga „wyslano".

    const runtime = createRuntime(config(), new InboxStore({ dir }));
    const wynik = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 200_000,
      body: {
        operation: "resolve_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT",
        requestId: "req-sending-000000002",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });
    expect(wynik.status).toBe(200);
    expect(wynik.body).toMatchObject({ data: { status: "sent", repairedHistory: true } });

    const wychodzace = () =>
      new InboxStore({ dir })
        .messagesForCase("ic_sprawa")
        .filter((message) => message.direction === "outgoing");
    expect(wychodzace()).toHaveLength(1);
    expect(wychodzace()[0]!.body).toContain("odtworzona z ledgera");

    // Druga naprawa nie dokłada blizniaczej wiadomosci do watku.
    const powtorka = await handleInboxReply({
      runtime,
      humanConfirmation: "confirmed",
      now: NOW + 300_000,
      body: {
        operation: "resolve_sent",
        confirmation: "CONFIRM_CUSTOMER_REPLY_WAS_SENT",
        requestId: "req-sending-000000002",
        caseId: "ic_sprawa",
        expectedLastIncomingMessageId: "mid:klient-1",
      },
    });
    expect(powtorka.status).toBe(200);
    expect(powtorka.body).toMatchObject({ data: { repairedHistory: false } });
    expect(wychodzace()).toHaveLength(1);
    // Sprawa przestaje czekac na reakcje: odpowiedz jest w watku.
    expect(new InboxStore({ dir }).getCase("ic_sprawa")!.requiresResponse).toBe(false);
  });

  it("wygasly `prepared` daje sie zterminalizowac i NIE blokuje kolejnej proby", async () => {
    const dir = newDir();
    const before = new InboxStore({ dir });
    seedCase(before);
    prepareAttempt({
      store: before,
      requestId: "req-prepared-00000001",
      caseId: "ic_sprawa",
      text: "Szkic, ktorego nikt nie potwierdzil",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    // Proces pada przed potwierdzeniem: do dostawcy NIC nie polecialo.

    const after = new InboxStore({ dir });
    expect(after.getAttempt("req-prepared-00000001")?.status).toBe("prepared");

    // Dopoki blokada zyje, kolejna proba w tej sprawie sie odbija.
    const zablokowana = await sendReply({
      store: after,
      requestId: "req-prepared-00000002",
      caseId: "ic_sprawa",
      text: "Druga proba",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: { send: async () => ({ status: "sent", externalMessageId: "x" }) },
      now: () => NOW + 1_000,
    });
    expect(zablokowana).toMatchObject({ status: "rejected", code: "active_attempt_exists" });

    // Przed uplywem czasu nie terminalizujemy: czlowiek moze wlasnie czytac szkic.
    expect(expirePrepared(after, "req-prepared-00000001", NOW + 1_000)).toMatchObject({
      ok: false,
      code: "too_early",
    });

    const wygasle = expirePreparedAttempts(after, NOW + PREPARED_TTL_MS + 1);
    expect(wygasle).toEqual(["req-prepared-00000001"]);
    const zterminalizowana = after.getAttempt("req-prepared-00000001")!;
    expect(zterminalizowana.status).toBe("failed");
    expect(zterminalizowana.failureCode).toBe("prepared_expired");
    expect(after.activeAttemptForCase("ic_sprawa")).toBeNull();

    // Kolejna proba przechodzi, a stan koncowy przezywa restart.
    const kolejna = await sendReply({
      store: after,
      requestId: "req-prepared-00000003",
      caseId: "ic_sprawa",
      text: "Druga proba",
      expectedLastIncomingMessageId: "mid:klient-1",
      transport: { send: async () => ({ status: "sent", externalMessageId: "resend-1" }) },
      now: () => NOW + PREPARED_TTL_MS + 2,
    });
    expect(kolejna.status).toBe("sent");
    expect(new InboxStore({ dir }).getAttempt("req-prepared-00000001")?.failureCode).toBe(
      "prepared_expired",
    );

    // Powtorzone sprzatanie nie ma juz czego zdejmowac.
    expect(expirePreparedAttempts(after, NOW + PREPARED_TTL_MS + 3)).toEqual([]);
  });

  it("sprzatanie wygaslych NIE rusza prob `sending` ani `uncertain`", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store);
    seedCase(store, { caseId: "ic_druga", externalConversationId: "conv-2" });

    prepareAttempt({
      store,
      requestId: "req-wlocie-0000000001",
      caseId: "ic_sprawa",
      text: "W locie",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-wlocie-0000000001", NOW);

    prepareAttempt({
      store,
      requestId: "req-niepewna-000000001",
      caseId: "ic_druga",
      text: "Niepewna",
      expectedLastIncomingMessageId: "mid:klient-1",
      now: NOW,
    });
    beginSending(store, "req-niepewna-000000001", NOW);
    markUncertain(store, "req-niepewna-000000001", "timeout");

    /*
     * Przy obu tych stanach request MOGL dotrzec do dostawcy. Zdjecie blokady
     * zegarem otwieraloby droge drugiej wiadomosci u klienta, a o tym, czy
     * pierwsza doszla, wie tylko czlowiek po sprawdzeniu.
     */
    expect(expirePreparedAttempts(store, NOW + PREPARED_TTL_MS * 10)).toEqual([]);
    expect(store.getAttempt("req-wlocie-0000000001")?.status).toBe("sending");
    expect(store.getAttempt("req-niepewna-000000001")?.status).toBe("uncertain");
    expect(expirePrepared(store, "req-wlocie-0000000001", NOW + PREPARED_TTL_MS * 10)).toMatchObject({
      ok: false,
      code: "not_expirable:sending",
    });
    expect(expirePrepared(store, "req-niepewna-000000001", NOW + PREPARED_TTL_MS * 10)).toMatchObject(
      { ok: false, code: "not_expirable:uncertain" },
    );
  });

  it("spozniony webhook po recznym rozstrzygnieciu nie tworzy nowej sprawy", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    seedCase(store, { caseId: "ic_meta", provider: "facebook", accountKey: "123" });

    const echo = message({
      provider: "facebook",
      accountKey: "123",
      caseId: "ic_meta",
      externalConversationId: "klient-77",
      externalMessageId: "m_echo",
      direction: "outgoing",
      isEcho: true,
      bulkHint: false,
      body: "Juz wysylamy",
      rfcMessageId: null,
      replyToAddress: null,
    });

    expect(ingestMetaEvents(store, [{ kind: "message", message: echo }]).stored).toBe(1);
    // Ten sam webhook przychodzi drugi raz, juz po tym, jak czlowiek
    // rozstrzygnal wynik recznie.
    const late = ingestMetaEvents(store, [{ kind: "message", message: echo }]);
    expect(late.stored).toBe(0);
    expect(late.duplicates).toBe(1);
    expect(store.listCases().filter((entry) => entry.provider === "facebook")).toHaveLength(1);
  });

  it("ucieta ostatnia linia dziennika nie kasuje historii", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message());
    store.claimMessage(message({ externalMessageId: "mid:klient-2", contentFingerprint: "fp2" }));

    // Proces zabity w trakcie zapisu: ostatnia linia jest niepelna.
    appendFileSync(join(dir, "inbox.jsonl"), '{"t":"message","at":1,"messa', "utf8");

    const after = new InboxStore({ dir });
    expect(after.allMessages()).toHaveLength(2);
    expect(after.damageReport()?.lines).toBe(1);
    // Alarm integralnosci jest TRWALY: przezywa restart jako rekord zdrowia.
    expect(after.getHealth({ provider: "store", accountKey: "integrity" })?.state).toBe("error");
  });

  it("stan przezywa kompakcje dziennika", () => {
    const dir = newDir();
    const store = new InboxStore({ dir, compactAbove: 10, allowCompaction: true });
    seedCase(store);
    for (let index = 0; index < 40; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:seq-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    const attempt: OutboundAttempt = {
      requestId: "req-000000000000ledger",
      caseId: "ic_sprawa",
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      contentSha256: "abc",
      contentLength: 3,
      expectedLastIncomingMessageId: "mid:klient-1",
      expectedLastIncomingAt: NOW,
      idempotencyKey: "key",
      status: "sent",
      externalMessageId: "resend-1",
      postStartedAt: NOW,
      completedAt: NOW,
      failureCode: null,
      createdAt: NOW,
      deliveryState: "delivered",
    };
    store.putAttempt(attempt);
    store.commitCursor({ provider: "email", accountKey: "sklep" }, "7:41");

    const after = new InboxStore({ dir });
    // Dziennik zostal skompaktowany do snapshotu, ale nic z niego nie zniknelo.
    expect(readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n").length).toBeLessThan(10);
    expect(after.allMessages()).toHaveLength(40);
    expect(after.getCase("ic_sprawa")).not.toBeNull();
    expect(after.getAttempt("req-000000000000ledger")?.deliveryState).toBe("delivered");
    expect(after.getCursor({ provider: "email", accountKey: "sklep" })).toBe("7:41");
  });

  it("store BEZ prawa do kompakcji nie przepisuje pliku pod nogami drugiego pisarza", () => {
    const dir = newDir();
    // Domyslnie kompakcja jest WYLACZONA: to bezpieczna wartosc dla procesu,
    // ktory tylko dopisuje. Przepisanie pliku nie jest atomowe wobec appendu,
    // wiec pisarz bez wyznaczenia odlinkowalby i-wezel drugiemu.
    const store = new InboxStore({ dir, compactAbove: 5 });
    for (let index = 0; index < 30; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:nowriter-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    store.close();

    const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n");
    // Plik NIE zostal skompaktowany: wszystkie zdarzenia sa nadal osobno.
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.some((line) => line.includes('"t":"snapshot"'))).toBe(false);

    const reopened = new InboxStore({ dir });
    expect(reopened.allMessages()).toHaveLength(30);
  });

  it("wyznaczony pisarz kompaktuje i nic nie ginie", () => {
    const dir = newDir();
    const store = new InboxStore({ dir, compactAbove: 5, allowCompaction: true });
    for (let index = 0; index < 30; index += 1) {
      store.claimMessage(
        message({ externalMessageId: `mid:writer-${index}`, contentFingerprint: `fp-${index}` }),
      );
    }
    store.close();

    const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(10);
    expect(new InboxStore({ dir }).allMessages()).toHaveLength(30);
  });
});
