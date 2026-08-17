import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CopilotStore } from "../src/state/store.js";
import { extractOrderRefs, matchIssue } from "../src/state/correlate.js";
import { classifyNoise, splitNoise } from "../src/state/noise.js";
import { createIssueCapabilities, presentedIds } from "../src/state/capabilities.js";
import { MemoryAuditSink, newCorrelationId } from "../src/capability/audit.js";
import { CapabilityRegistry } from "../src/capability/registry.js";
import { AGENT_SCOPES } from "../src/index.js";
import type { Issue, SourceRef } from "../src/state/types.js";
import type { MailMessage } from "../src/mail/types.js";

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
