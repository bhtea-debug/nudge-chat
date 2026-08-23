import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSIFIER_VERSION } from "./contract.js";
import { MODEL_SCREEN_REASON, screenCases, type ScreenModel } from "./model-screen.js";
import { InboxStore, type StoredCase } from "./store.js";

/**
 * Sito modelowe: reguły zawężają, model wybiera, nic nie znika.
 *
 * Testy chodzą na PRAWDZIWYM magazynie (dziennik na dysku) i atrapie modelu,
 * bo trzy gwarancje sita — nic nie znika, awaria zostawia kolejkę w spokoju,
 * nowa wiadomość klienta unieważnia werdykt — są dokładnie tym, co odróżnia
 * filtr od cichego kasowania poczty.
 */

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshStore(): { store: InboxStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "model-screen-"));
  dirs.push(dir);
  return { store: new InboxStore({ dir }), dir };
}

let licznikWiadomosci = 0;

function seedCase(
  store: InboxStore,
  caseId: string,
  overrides: Partial<StoredCase> = {},
  body = "Dzien dobry, czy moge prosic o fakture do zamowienia?",
): StoredCase {
  licznikWiadomosci += 1;
  const messageId = `mid:${caseId}:${licznikWiadomosci}`;
  store.claimMessage({
    provider: "email",
    accountKey: "biuro",
    externalMessageId: messageId,
    externalConversationId: caseId,
    caseId,
    direction: "incoming",
    authorLabel: "ktos@example.com",
    subject: "Pytanie",
    body,
    bodyTruncated: false,
    sourceCreatedAt: Date.now(),
    receivedAt: Date.now(),
    rfcMessageId: `${messageId}@example.com`,
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: `fp-${messageId}`,
    attachments: [],
  });
  const record: StoredCase = {
    caseId,
    provider: "email",
    accountKey: "biuro",
    externalConversationId: caseId,
    subject: "Pytanie",
    participantLabel: "ktos@example.com",
    orderRef: null,
    firstSeenAt: Date.now(),
    lastMessageAt: Date.now(),
    lastIncomingMessageId: messageId,
    lastIncomingAt: Date.now(),
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

function modelStub(
  odpowiedz: string | ((prompt: string) => string),
): { model: ScreenModel; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    model: {
      complete: vi.fn(async ({ prompt }: { prompt: string }) => {
        calls.push(prompt);
        return typeof odpowiedz === "function" ? odpowiedz(prompt) : odpowiedz;
      }),
    },
  };
}

const NIE_KLIENT = '{"werdykt":"nie_klient","etykieta":"faktura"}';
const KLIENT = '{"werdykt":"klient","etykieta":"pytanie o zamowienie"}';

describe("sito modelowe", () => {
  it("odkłada nie-klienta z kolejki, ale sprawa NIE znika", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_faktura");
    const { model } = modelStub(NIE_KLIENT);

    const report = await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(report).toMatchObject({ candidates: 1, screened: 1, filtered: 1, errors: 0 });
    const po = store.getCase("przypadek_faktura")!;
    expect(po.requiresResponse).toBe(false);
    expect(po.classificationReason).toBe(MODEL_SCREEN_REASON);
    // Sprawa dalej istnieje w magazynie — sito nie ma prawa niczego usunąć.
    expect(store.listCases().map((c) => c.caseId)).toContain("przypadek_faktura");
  });

  it("klienta zostawia w kolejce i NIE pyta modelu drugi raz (werdykt w cache)", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_klient");
    const { model, calls } = modelStub(KLIENT);

    await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });
    const drugi = await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(store.getCase("przypadek_klient")!.requiresResponse).toBe(true);
    expect(calls).toHaveLength(1);
    expect(drugi.screened).toBe(0);
  });

  it("awaria modelu zostawia sprawę w kolejce i nie zapisuje werdyktu", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_awaria");
    const zly: ScreenModel = { complete: vi.fn(async () => Promise.reject(new Error("timeout"))) };

    const report = await screenCases({ store, model: zly, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(report.errors).toBe(1);
    expect(store.getCase("przypadek_awaria")!.requiresResponse).toBe(true);
    // Brak cache: następny przebieg próbuje ponownie.
    const { model, calls } = modelStub(NIE_KLIENT);
    await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });
    expect(calls).toHaveLength(1);
  });

  it("nieparsowalna odpowiedź modelu to awaria oceny, nie decyzja", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_belkot");
    const { model } = modelStub("moim zdaniem to chyba nie klient");

    const report = await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(report.errors).toBe(1);
    expect(store.getCase("przypadek_belkot")!.requiresResponse).toBe(true);
  });

  it("po trzech błędach z rzędu przebieg się poddaje do następnego ticku", async () => {
    const { store, dir } = freshStore();
    for (let i = 0; i < 5; i += 1) seedCase(store, `awaria_${i}`);
    const zly: ScreenModel = { complete: vi.fn(async () => Promise.reject(new Error("500"))) };

    const report = await screenCases({ store, model: zly, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(report.errors).toBe(3);
    expect((zly.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("budżet na tick jest twardy, a reszta czeka na kolejny przebieg", async () => {
    const { store, dir } = freshStore();
    for (let i = 0; i < 4; i += 1) seedCase(store, `partia_${i}`);
    const { model, calls } = modelStub(NIE_KLIENT);

    const pierwszy = await screenCases({ store, model, stateDir: dir, maxPerTick: 2, now: Date.now() });
    expect(pierwszy).toMatchObject({ screened: 2, skippedBudget: 2 });
    expect(calls).toHaveLength(2);

    const drugi = await screenCases({ store, model, stateDir: dir, maxPerTick: 2, now: Date.now() });
    expect(drugi.screened).toBe(2);
    expect(store.listCases().every((c) => c.requiresResponse === false)).toBe(true);
  });

  it("NOWA wiadomość klienta unieważnia werdykt i sprawa wraca do oceny", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_wraca");
    const pierwszy = modelStub(NIE_KLIENT);
    await screenCases({ store, model: pierwszy.model, stateDir: dir, maxPerTick: 10, now: Date.now() });
    expect(store.getCase("przypadek_wraca")!.requiresResponse).toBe(false);

    // Klient dopisuje: reprojekcja przywraca regułowy wynik i nowy messageId.
    seedCase(store, "przypadek_wraca", {}, "Halo, czy jest tu ktos? Czekam na odpowiedz o moje zamowienie!");

    const drugi = modelStub(KLIENT);
    await screenCases({ store, model: drugi.model, stateDir: dir, maxPerTick: 10, now: Date.now() });
    expect(drugi.calls).toHaveLength(1);
    expect(store.getCase("przypadek_wraca")!.requiresResponse).toBe(true);
  });

  it("werdykt nie_klient nakłada się PONOWNIE po reprojekcji bez pytania modelu", async () => {
    const { store, dir } = freshStore();
    const rekord = seedCase(store, "przypadek_reprojekcja");
    const pierwszy = modelStub(NIE_KLIENT);
    await screenCases({ store, model: pierwszy.model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    // Reprojekcja (ta sama ostatnia wiadomość) przywraca wynik regułowy.
    store.upsertCase({ ...store.getCase("przypadek_reprojekcja")!, requiresResponse: true, classificationReason: "customer_message", lastIncomingMessageId: rekord.lastIncomingMessageId });

    const drugi = modelStub(KLIENT);
    const report = await screenCases({ store, model: drugi.model, stateDir: dir, maxPerTick: 10, now: Date.now() });
    expect(drugi.calls).toHaveLength(0);
    expect(report.filtered).toBe(1);
    expect(store.getCase("przypadek_reprojekcja")!.requiresResponse).toBe(false);
  });

  it("nie dotyka spraw, które reguły już rozstrzygnęły, ani spraw do przeglądu", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "juz_odlozona", { requiresResponse: false, classificationReason: "bulk_or_marketing" });
    seedCase(store, "do_przegladu", { needsReview: true, classificationReason: "needs_review" });
    seedCase(store, "nie_email", { provider: "instagram" });
    const { model, calls } = modelStub(NIE_KLIENT);

    const report = await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(calls).toHaveLength(0);
    expect(report.candidates).toBe(0);
    expect(store.getCase("do_przegladu")!.needsReview).toBe(true);
    expect(store.getCase("nie_email")!.requiresResponse).toBe(true);
  });

  it("treść wiadomości trafia do modelu przycięta, z nadawcą i tematem", async () => {
    const { store, dir } = freshStore();
    seedCase(store, "przypadek_prompt", {}, "x".repeat(5000));
    const { model, calls } = modelStub(KLIENT);

    await screenCases({ store, model, stateDir: dir, maxPerTick: 10, now: Date.now() });

    expect(calls[0]).toContain("ktos@example.com");
    expect(calls[0]).toContain("Pytanie");
    expect(calls[0]!.length).toBeLessThan(2000);
  });
});
