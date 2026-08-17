import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CopilotStore } from "../src/state/store.js";
import { extractOrderRefs, findOrderRefs, isOwnOrderShape, matchIssue } from "../src/state/correlate.js";
import { classifyNoise, splitNoise } from "../src/state/noise.js";
import { createIssueCapabilities, presentedIds } from "../src/state/capabilities.js";
import { MemoryAuditSink, newCorrelationId } from "../src/capability/audit.js";
import { CapabilityRegistry } from "../src/capability/registry.js";
import { AGENT_SCOPES } from "../src/index.js";
import type { Issue, SourceRef } from "../src/state/types.js";
import type { MailMessage } from "../src/mail/types.js";
import { judge } from "../src/mail/folder-verdict.js";
import type { FolderStat } from "../src/mail/imap.js";
import { explainModelError } from "../src/model/errors.js";

const fresh = (): string => mkdtempSync(join(tmpdir(), "bht-state-"));

const ref = (over: Partial<SourceRef> = {}): SourceRef => ({
  kind: "mail",
  messageId: "<a@klient.example>",
  threadId: null,
  folder: "INBOX",
  date: "2026-08-18T09:00:00.000Z",
  subject: "Zamówienie 2307029",
  from: "zakupy@klient.example",
  ...over,
});

const seedIssue = (store: CopilotStore, over: Partial<Parameters<CopilotStore["createIssue"]>[0]> = {}): Issue =>
  store.createIssue({
    title: "Rossmann pyta o 2307029",
    summary: "Klient prosi o potwierdzenie terminu.",
    category: "reply",
    priority: "normal",
    status: "new",
    ref: ref(),
    relatedOrderRefs: ["2307029"],
    ...over,
  });

describe("pamięć Copilota — trwałość i odtwarzanie", () => {
  let dir: string;
  beforeEach(() => {
    dir = fresh();
  });

  it("przeżywa restart procesu — stan jest w dzienniku, nie w pamięci", () => {
    const a = new CopilotStore({ dir, actor: "copilot" });
    const issue = seedIssue(a);
    a.patchIssue(issue.id, { status: "waiting_for_owner" }, "status: czeka na decyzję");

    const b = new CopilotStore({ dir, actor: "copilot" });
    const reloaded = b.get(issue.id);
    expect(reloaded?.status).toBe("waiting_for_owner");
    expect(reloaded?.history.length).toBe(2);
  });

  it("uszkodzona linia dziennika nie zabiera reszty historii, ale jest widoczna", () => {
    const a = new CopilotStore({ dir, actor: "copilot" });
    const issue = seedIssue(a);
    appendFileSync(join(dir, "events.jsonl"), "{to nie jest json\n", "utf8");
    a.patchIssue(issue.id, { priority: "high" }, "status: podniesiony priorytet");

    const b = new CopilotStore({ dir, actor: "copilot" });
    expect(b.get(issue.id)?.priority).toBe("high");
    // Cicha utrata stanu byłaby gorsza niż widoczna.
    expect(b.integrityWarning()).toContain("nieczytelnych");
  });

  it("w dzienniku nie ma treści maila — tylko referencje", () => {
    const a = new CopilotStore({ dir, actor: "copilot" });
    seedIssue(a, { summary: "Klient prosi o potwierdzenie terminu." });
    const log = readFileSync(join(dir, "events.jsonl"), "utf8");
    // Streszczenie tak, cała treść nie — sprawdzamy, że nie ma pola body/text.
    expect(log).toContain("2307029");
    expect(log).not.toContain('"body"');
    expect(log).not.toContain('"text"');
  });
});

describe("model nie zamyka spraw definitywnie", () => {
  it("copilot chcący ustawić resolved dostaje probably_resolved", () => {
    const dir = fresh();
    const store = new CopilotStore({ dir, actor: "copilot" });
    const issue = seedIssue(store);
    store.patchIssue(issue.id, { status: "resolved" }, "status: wygląda na załatwione");
    // Wymuszone w kodzie, nie w promptcie — prompt można obejść przypadkiem.
    expect(store.get(issue.id)?.status).toBe("probably_resolved");
  });

  it("właściciel może zamknąć sprawę", () => {
    const dir = fresh();
    const store = new CopilotStore({ dir, actor: "wlasciciel" });
    const issue = seedIssue(store);
    expect(store.ownerResolve(issue.id, "dogadane telefonicznie")).toBe(true);
    expect(store.get(issue.id)?.status).toBe("resolved");
    expect(store.openIssues()).toHaveLength(0);
  });
});

describe("delta — nie pokazuj tego samego dwa razy", () => {
  let dir: string;
  beforeEach(() => {
    dir = fresh();
  });

  it("sprawa pokazana i niezmieniona nie wraca w delcie", () => {
    const store = new CopilotStore({ dir, actor: "copilot" });
    const t0 = "2026-08-18T08:00:00.000Z";
    const issue = seedIssue(store, { at: "2026-08-18T09:00:00.000Z" });

    expect(store.changesSince(t0, "2026-08-18T10:00:00.000Z").newIssues).toHaveLength(1);

    store.markPresented([issue.id], "claude", "2026-08-18T09:30:00.000Z");
    const after = store.changesSince("2026-08-18T09:15:00.000Z", "2026-08-18T10:00:00.000Z");
    expect(after.newIssues).toHaveLength(0);
    expect(after.updatedIssues).toHaveLength(0);
    expect(after.nothingNew).toBe(true);
  });

  it("pokazanie sprawy nie liczy się jako jej zmiana", () => {
    const store = new CopilotStore({ dir, actor: "copilot" });
    const issue = seedIssue(store, { at: "2026-08-18T09:00:00.000Z" });
    store.markPresented([issue.id], "claude", "2026-08-18T09:30:00.000Z");
    // Gdyby pokazanie ruszało updatedAt, sprawa wracałaby w każdej kolejnej
    // delcie na zawsze — dokładnie ten błąd, którego mamy uniknąć.
    expect(store.get(issue.id)?.updatedAt).toBe("2026-08-18T09:00:00.000Z");
    expect(store.get(issue.id)?.history).toHaveLength(1);
  });

  it("ale zmieniona sprawa wraca, nawet jeśli była już pokazana", () => {
    const store = new CopilotStore({ dir, actor: "copilot" });
    const issue = seedIssue(store, { at: "2026-08-18T09:00:00.000Z" });
    store.markPresented([issue.id], "claude", "2026-08-18T09:30:00.000Z");
    store.patchIssue(issue.id, { category: "urgent" }, "status: klient ponagla", "2026-08-18T09:45:00.000Z");

    const d = store.changesSince("2026-08-18T09:35:00.000Z", "2026-08-18T10:00:00.000Z");
    expect(d.updatedIssues.map((i) => i.id)).toEqual([issue.id]);
  });

  it("„brak zmian” bez udanego skanu mówi wprost, że to nie znaczy „nic nie przyszło”", () => {
    const store = new CopilotStore({ dir, actor: "copilot" });
    const d = store.changesSince("2026-08-18T09:00:00.000Z", "2026-08-18T10:00:00.000Z");
    expect(d.nothingNew).toBe(true);
    expect(d.staleNote).toContain("NIE znaczy");
  });

  it("stary skan też jest zgłaszany jako podejrzany", () => {
    const store = new CopilotStore({ dir, actor: "copilot" });
    store.saveCheckpoint({
      folder: "INBOX",
      processedThrough: "2026-08-18T06:00:00.000Z",
      lastScanAt: "2026-08-18T06:00:00.000Z",
      lastOkScanAt: "2026-08-18T06:00:00.000Z",
      lastError: null,
      messagesSeen: 3,
    });
    const d = store.changesSince("2026-08-18T09:00:00.000Z", "2026-08-18T10:00:00.000Z");
    expect(d.staleNote).toContain("niedziałającego monitora");
  });
});

describe("korelacja — duplikat jest mniej groźny niż scalenie dwóch spraw", () => {
  const base = (over: Partial<Issue> = {}): Issue => ({
    id: "spr_1",
    createdAt: "2026-08-18T09:00:00.000Z",
    updatedAt: "2026-08-18T09:00:00.000Z",
    source: "mail",
    sourceRefs: [ref()],
    title: "t",
    summary: "s",
    category: "reply",
    priority: "normal",
    status: "new",
    classifier: "deterministic",
    whyListed: "nadawca znany, brak odpowiedzi z naszej strony",
    likelyIrrelevant: false,
    relatedOrderRefs: ["2307029"],
    relatedProductRefs: [],
    lastEvidenceAt: null,
    lastErpSummary: null,
    waitingFor: null,
    lastPresentedAt: null,
    notificationCandidate: false,
    notificationReason: null,
    history: [],
    ...over,
  });

  it("odpowiedź w tym samym wątku to ta sama sprawa", () => {
    const m = matchIssue([base()], {
      ref: ref({ messageId: "<b@klient.example>" }),
      parentIds: ["<a@klient.example>"],
      orderRefs: [],
    });
    expect(m.confidence).toBe("high");
    expect(m.issue?.id).toBe("spr_1");
  });

  it("ten sam numer i ten sam nadawca — scalamy", () => {
    const m = matchIssue([base()], {
      ref: ref({ messageId: "<c@klient.example>", from: "ksiegowosc@klient.example" }),
      parentIds: [],
      orderRefs: ["2307029"],
    });
    expect(m.confidence).toBe("high");
  });

  it("ten sam numer, INNY nadawca — nie scalamy, ale mówimy o podobieństwie", () => {
    const m = matchIssue([base()], {
      ref: ref({ messageId: "<d@inny.example>", from: "biuro@inny.example" }),
      parentIds: [],
      orderRefs: ["2307029"],
    });
    expect(m.confidence).toBe("medium");
    expect(m.issue).toBeNull();
    expect(m.nearMisses).toHaveLength(1);
  });

  it("dwa null-owe threadId nie są dowodem na wspólny wątek", () => {
    const m = matchIssue([base({ relatedOrderRefs: [] })], {
      ref: ref({ messageId: "<e@obcy.example>", threadId: null, from: "kto@obcy.example" }),
      parentIds: [],
      orderRefs: [],
    });
    expect(m.confidence).toBe("none");
  });

  it("odpowiedź do zamkniętej sprawy ją odnajduje, nie zakłada nowej", () => {
    const m = matchIssue([base({ status: "resolved" })], {
      ref: ref({ messageId: "<f@klient.example>" }),
      parentIds: ["<a@klient.example>"],
      orderRefs: [],
    });
    expect(m.issue?.id).toBe("spr_1");
  });

  it("wyciąga numery zamówień z tekstu", () => {
    expect(extractOrderRefs("Zamówienie 2307029 oraz ZP/06/2026/00016")).toContain("2307029");
    expect(extractOrderRefs("nic tu nie ma")).toEqual([]);
  });
});

describe("filtr przed modelem", () => {
  const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
    id: "<x@y>",
    providerRef: "imap:INBOX:1",
    threadId: "<x@y>",
    subject: "Zapytanie",
    from: { name: null, address: "kto@klient.example" },
    to: [],
    cc: [],
    date: "2026-08-18T09:00:00.000Z",
    folder: "INBOX",
    seen: false,
    answered: false,
    inReplyTo: null,
    references: [],
    attachments: [],
    bulk: false,
    snippet: "dzień dobry",
    ...over,
  });

  it("odrzuca po nagłówku masowym", () => {
    expect(classifyNoise(msg({ bulk: true })).noise).toBe(true);
  });

  it("odrzuca odbicia", () => {
    expect(classifyNoise(msg({ from: { name: null, address: "MAILER-DAEMON@zenbox.pl" } })).noise).toBe(true);
  });

  it("NIE odrzuca po samym noreply — tak przychodzą potwierdzenia zamówień", () => {
    // Ta decyzja jest świadoma: odrzucenie prawdziwej wiadomości od klienta
    // jest gorsze niż zapłacenie za sklasyfikowanie jednego automatu.
    expect(classifyNoise(msg({ from: { name: null, address: "noreply@rossmann.example" } })).noise).toBe(false);
  });

  it("dzieli paczkę i podaje powody", () => {
    const { keep, dropped } = splitNoise([msg(), msg({ id: "<z@y>", bulk: true })]);
    expect(keep).toHaveLength(1);
    expect(dropped[0]?.why).toContain("masowy");
  });
});

describe("capability spraw", () => {
  let dir: string;
  let store: CopilotStore;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    dir = fresh();
    store = new CopilotStore({ dir, actor: "copilot" });
    registry = new CapabilityRegistry().registerAll(createIssueCapabilities(() => store));
  });

  const call = async (name: string, input: unknown): Promise<any> =>
    registry.invoke(name, input, {
      agent: "test",
      correlationId: newCorrelationId(),
      scopes: AGENT_SCOPES,
      audit: new MemoryAuditSink(),
    });

  it("wszystkie są wyłącznie do czytania", () => {
    for (const cap of createIssueCapabilities(() => store)) {
      expect(cap.effectClass).toBe("read");
    }
  });

  it("get_open_issues podaje obraz całości, nie tylko listę", async () => {
    seedIssue(store, { category: "urgent", priority: "high" });
    seedIssue(store, { ref: ref({ messageId: "<b@x>" }), category: "reply" });
    const out = await call("copilot_get_open_issues", {});
    expect(out.count).toBe(2);
    expect(out.byCategory).toEqual({ urgent: 1, reply: 1 });
    // Pilne na górze — właściciel czyta pierwszą linię.
    expect(out.issues[0].category).toBe("urgent");
  });

  it("get_issue dla nieistniejącej sprawy mówi wprost, że jej nie ma", async () => {
    const out = await call("copilot_get_issue", { id: "spr_nie_ma" });
    expect(out.found).toBe(false);
    expect(out.nextStep).toContain("NIE MA");
    expect(out.nextStep).toContain("Nie zgaduj");
  });

  it("get_issue zwraca wskaźniki do wiadomości, nie ich treść", async () => {
    const issue = seedIssue(store);
    const out = await call("copilot_get_issue", { id: issue.id });
    expect(out.messages[0].messageId).toBe("<a@klient.example>");
    expect(out.messages[0]).not.toHaveProperty("body");
  });

  it("search_issues z pustym wynikiem nie twierdzi, że nic takiego nie było", async () => {
    const cap = createIssueCapabilities(() => store).find((c) => c.name === "copilot_search_issues");
    expect(cap?.description).toContain("nie mam takiej");
    expect(cap?.description).toContain("mail_search");
  });

  it("adapter wie, które sprawy zostały pokazane", async () => {
    const issue = seedIssue(store);
    const out = await call("copilot_get_open_issues", {});
    expect(presentedIds("copilot_get_open_issues", out)).toEqual([issue.id]);
    const changes = await call("copilot_get_changes_since", { since: "2026-01-01T00:00:00.000Z" });
    expect(presentedIds("copilot_get_changes_since", changes)).toContain(issue.id);
    expect(presentedIds("mail_list_recent", { messages: [] })).toEqual([]);
  });
});

describe("ocena folderów poczty", () => {
  const f = (over: Partial<FolderStat> = {}): FolderStat => ({
    path: "Coś",
    specialUse: null,
    subscribed: true,
    messages: 100,
    unseen: 5,
    newestAt: new Date().toISOString(),
    error: null,
    ...over,
  });

  it("brak liczników to NIE pusty folder", () => {
    // Realny przypadek: INBOX.WHITE LABEL zwrócił „?" bez błędu, a narzędzie
    // ogłosiło „pusty". To ta sama pomyłka, którą tępimy w capability —
    // „nie wiem" nie jest wartością zero.
    const v = judge(f({ path: "INBOX.WHITE LABEL", messages: null, unseen: null, newestAt: null }));
    expect(v.verdict).toBe("rozważ");
    expect(v.why).toContain("NIE zakładam");
    // Powód CELOWO mówi słowo „pusty" — w zdaniu „nie zakładam, że jest pusty".
    // Istotne jest, że nie dostał oceny „pomiń", którą dostaje folder naprawdę pusty.
    expect(judge(f({ messages: 0, unseen: 0, newestAt: null })).verdict).toBe("pomiń");
  });

  it("naprawdę pusty folder jest pusty", () => {
    expect(judge(f({ messages: 0, unseen: 0, newestAt: null })).verdict).toBe("pomiń");
  });

  it("zbiornik z prawie samymi nieprzeczytanymi nie idzie do monitorowania", () => {
    // Folder „Blocked": 985 z 1157 nieprzeczytanych, wpada dzisiaj. Pierwsza
    // wersja heurystyki uznała go za „aktywny, monitoruj".
    const v = judge(f({ path: "Blocked", messages: 1157, unseen: 985 }));
    expect(v.verdict).toBe("rozważ");
    expect(v.why).toContain("zbiornik");
  });

  it("skrzynka odbiorcza z normalnym udziałem nieprzeczytanych — monitoruj", () => {
    const v = judge(f({ path: "INBOX", messages: 3369, unseen: 889 }));
    expect(v.verdict).toBe("monitoruj");
  });

  it("folder porzucony przed latami — pomiń", () => {
    const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
    const v = judge(f({ path: "ROSSMANN", messages: 99, unseen: 0, newestAt: old }));
    expect(v.verdict).toBe("pomiń");
    expect(v.why).toContain("martwy");
  });

  it("wysłane pomijamy, ale z właściwego powodu", () => {
    const v = judge(f({ path: "Sent", specialUse: "\\Sent", messages: 14296, unseen: 4 }));
    expect(v.verdict).toBe("pomiń");
    expect(v.why).toContain("wątków");
  });

  it("folder, którego nie dało się odczytać, mówi o błędzie", () => {
    const v = judge(f({ error: "NO Mailbox doesn't exist" }));
    expect(v.verdict).toBe("pomiń");
    expect(v.why).toContain("nie udało się odczytać");
  });
});

describe("błędy API modelu tłumaczone na komunikat dla człowieka", () => {
  it("brak kredytów mówi, że kod jest w porządku i nic nie zginęło", () => {
    const e = explainModelError(
      new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
    );
    expect(e.kind).toBe("brak_kredytow");
    expect(e.advice).toContain("NIE jest usterka kodu");
    expect(e.advice).toContain("checkpoint");
    // Powtarzanie tego nie naprawi.
    expect(e.transient).toBe(false);
  });

  it("brak klucza wyjaśnia, że rozmowa przez MCP go nie potrzebuje", () => {
    const e = explainModelError(new Error("brak ANTHROPIC_API_KEY — jest wymagany tylko dla ask i triage"));
    expect(e.kind).toBe("brak_klucza");
    expect(e.advice).toContain("MCP");
  });

  it("limit szybkości i przeciążenie są przejściowe", () => {
    expect(explainModelError(new Error("429 rate_limit_error")).transient).toBe(true);
    expect(explainModelError(new Error("529 overloaded_error")).transient).toBe(true);
  });

  it("nieznanego błędu nie udaje, że rozumie", () => {
    const e = explainModelError(new Error("coś zupełnie innego"));
    expect(e.kind).toBe("inny");
    expect(e.plain).toContain("coś zupełnie innego");
  });

  it("nie gubi treści przy błędzie, który nie jest Error", () => {
    expect(explainModelError("socket hang up").plain).toContain("socket hang up");
  });
});

describe("rozpoznawanie numerów zamówień w surowym tekście", () => {
  const refs = (text: string): string[] => findOrderRefs(text).map((f) => f.ref);

  it("bierze numer po słowie kluczowym", () => {
    expect(refs("Pilne - status zamówienia 99999")).toEqual(["99999"]);
    expect(refs("faktura 12345 do korekty")).toEqual(["12345"]);
  });

  it("bierze numer z prefiksem literowym", () => {
    expect(refs("ZP/06/2026/00016 gotowe")).toEqual(["ZP/06/2026/00016"]);
    expect(refs("nasz nr RB-2026-118")).toContain("RB-2026-118");
  });

  it("bierze długi numer bez kontekstu", () => {
    expect(refs("Zamówienie 2307029 - prosimy o potwierdzenie")).toContain("2307029");
  });

  it("NIE bierze roku", () => {
    // Realny fałszywy alarm: „Ostatnie dni rejestracji na targi opakowań!"
    // dawało numer 2026, który potem trafiał do TeaBrew i wracał jako brak.
    expect(refs("spotkanie w 2026 roku")).toEqual([]);
    expect(refs("Ostatnie dni rejestracji na targi opakowań w 2026")).toEqual([]);
  });

  it("NIE bierze tonażu ani procentów", () => {
    expect(refs("Warunki na Q4 - prośba o rabat 12%, planujemy 1800 kg")).toEqual([]);
  });

  it("krótkie słowo kluczowe musi być całym wyrazem", () => {
    // „po" wewnątrz „Potwierdzenie" wyciągało rok jako numer zamówienia.
    // To był realny błąd na fiksturach.
    expect(refs("Potwierdzenie wysyłki - rooibos 200 kg z 2026")).toEqual([]);
  });

  it("nie sięga w ŚRODEK numeru kontrahenta", () => {
    // Realny tekst z fikstury: „partia dostawcy RB-2026-118". Słowo „partia"
    // uruchamiało regułę, a przechwytywanie nie było przywiązane do granicy
    // tokenu — więc wyciągało 2026 ze środka numeru dostawcy. Sam \b nie
    // wystarcza: między „-" i „2" granica wyrazu istnieje.
    const found = refs("potwierdzamy wysyłkę 200 kg rooibos, partia dostawcy RB-2026-118.");
    expect(found).toEqual(["RB-2026-118"]);
    expect(found).not.toContain("2026");
  });

  it("NIP i REGON nie są numerami zamówień", () => {
    // Realny temat ze skrzynki: „NIP: 8842745578 / 5210000143581…". NIP ma
    // dziesięć cyfr, więc przechodził jako „długi numer", trafiał do TeaBrew,
    // wracał jako brak i sprawa dostawała WYSOKI priorytet z alarmem.
    // Kontekst rozstrzyga to pewniej niż długość: numer zamówienia może mieć
    // dziesięć cyfr, ale nigdy nie stoi po słowie „NIP".
    expect(refs("NIP: 8842745578 / 521000014358100142097412")).not.toContain("8842745578");
    expect(refs("REGON 380806690 do faktury")).toEqual([]);
    expect(refs("nr rachunku 12345678901234567890")).not.toContain("12345678901234567890".slice(0, 10));
  });

  it("numer przesyłki z tego samego tematu zostaje jako wskaźnik", () => {
    // Odrzucamy z ALARMOWANIA, nie z pamięci.
    const found = refs("NIP: 8842745578 / 521000014358100142097412");
    expect(found).toContain("521000014358100142097412");
    expect(isOwnOrderShape("521000014358100142097412")).toBe(false);
  });

  it("odróżnia numer o naszym kształcie od obcego", () => {
    expect(isOwnOrderShape("2307029")).toBe(true);
    expect(isOwnOrderShape("99999")).toBe(true);
    // Numeracja kontrahenta — brak w TeaBrew jest oczekiwany.
    expect(isOwnOrderShape("RB-2026-118")).toBe(false);
    // Numer przesyłki InPost — sprawdzanie w TeaBrew to gwarantowany fałszywy alarm.
    expect(isOwnOrderShape("521000014358100142097412")).toBe(false);
  });

  it("numer przesyłki nadal jest zapamiętany jako wskaźnik", () => {
    // Odrzucamy go z alarmowania, nie z pamięci — po numerze przesyłki
    // właściciel może chcieć szukać.
    expect(refs("przesyłka 521000014358100142097412 uszkodzona")).toContain(
      "521000014358100142097412",
    );
  });
});

describe("wykrywanie poczty masowej po nagłówkach RFC", () => {
  const mail = (extra: readonly string[]): Buffer =>
    Buffer.from(
      ["From: a@b.c", "To: d@e.f", "Subject: x", "Message-ID: <z@b.c>", ...extra, "", "treść"].join(
        "\r\n",
      ),
    );

  /**
   * Ten test istnieje z powodu realnej wpadki: sprawdzałem
   * `headers.has("list-unsubscribe")`, a mailparser grupuje wszystkie nagłówki
   * List-* pod kluczem `list`. Filtr NIE ODSIAŁ NICZEGO na prawdziwej skrzynce —
   * 16 wiadomości, w tym TikTok i Booking.com, przeszło jako korespondencja.
   */
  it("List-Unsubscribe jest widziany, choć mailparser trzyma go pod kluczem `list`", async () => {
    const { simpleParser } = await import("mailparser");
    const p = await simpleParser(mail(["List-Unsubscribe: <https://x.pl/unsub>"]));
    // To jest dokładnie to, co pierwsza wersja sprawdzała — i dlatego nie działała.
    expect(p.headers.has("list-unsubscribe")).toBe(false);
    expect(p.headers.get("list")).toHaveProperty("unsubscribe");
  });

  it("rozpoznaje wszystkie cztery kształty poczty masowej", async () => {
    const { simpleParser } = await import("mailparser");
    const cases: [string, readonly string[], boolean][] = [
      ["List-Unsubscribe", ["List-Unsubscribe: <https://x.pl/u>"], true],
      ["List-Id", ["List-Id: <news.x.pl>"], true],
      ["Precedence", ["Precedence: bulk"], true],
      ["Auto-Submitted", ["Auto-Submitted: auto-generated"], true],
      ["Auto-Submitted: no", ["Auto-Submitted: no"], false],
      ["zwykły mail od człowieka", [], false],
    ];
    for (const [name, hdrs, expected] of cases) {
      const p = await simpleParser(mail(hdrs));
      const list = p.headers.get("list") as Record<string, unknown> | undefined;
      const auto = String(p.headers.get("auto-submitted") ?? "").toLowerCase();
      const precedence = String(p.headers.get("precedence") ?? "").toLowerCase().trim();
      const bulk =
        (list !== undefined && ("unsubscribe" in list || "id" in list)) ||
        ["bulk", "list", "junk"].includes(precedence) ||
        (auto.trim() !== "" && !auto.includes("no"));
      expect(bulk, name).toBe(expected);
    }
  });

  it("kod logowania nie jest numerem zamówienia", () => {
    // „348819 to Twój kod logowania" trafiał do TeaBrew i wracał jako brak.
    // Próg podniesiony do siedmiu cyfr — tyle mają prawdziwe numery tej firmy.
    expect(findOrderRefs("348819 to Twój kod logowania").map((f) => f.ref)).toEqual([]);
    expect(findOrderRefs("Rossmann Order 2307348").map((f) => f.ref)).toContain("2307348");
  });
});
