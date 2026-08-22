import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedRecord } from "../mail/imap.js";
import type { InboxConfig } from "./config.js";
import { handleMetaWebhook } from "./http.js";
import { createRuntime } from "./runtime.js";
import { InboxStore } from "./store.js";
import type { EmailAccount } from "./providers/email/normalize.js";
import { syncSentFolder, type ImapReader } from "./providers/email/sync.js";

/**
 * Dwie obietnice, które muszą być prawdziwe co do bajta.
 *
 *  1. Tryb `preview` jest CAŁKOWICIE bezskutkowy — także przy skonfigurowanym
 *     folderze wysłanych. Dowód: identyczny snapshot pliku stanu przed i po.
 *  2. Webhook Meta nie dostaje 200, zanim wiadomość nie jest na dysku. Dowód:
 *     odczyt pliku dziennika przez DRUGI, niezależny store natychmiast po
 *     odpowiedzi — czyli symulacja odczytu po nagłej utracie procesu.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;
const APP_SECRET = "sekret-aplikacji-meta";

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-preview-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const account: EmailAccount = {
  accountKey: "sklep",
  address: "sklep@brownhouseandtea.pl",
  label: "E-mail sklep",
  folder: "INBOX",
  // KLUCZOWE dla tego testu: folder wysłanych JEST skonfigurowany.
  sentFolder: "Sent",
};

function config(overrides: Partial<InboxConfig> = {}): InboxConfig {
  return {
    enabled: true,
    stateDir: "state",
    email: [
      {
        ...account,
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "sklep",
        pass: "x",
      },
    ],
    meta: [{ provider: "facebook", accountKey: "page-1", pageId: "page-1", label: "Facebook", accessToken: "t" }],
    allegroEnabled: false,
    outbound: {
      resendApiKey: null,
      resendWebhookSecret: null,
      metaAppSecret: APP_SECRET,
      metaVerifyToken: "verify",
    },
    backfillDays: 30,
    tickFirstDelayMs: 100,
    tickIntervalMs: 1_000,
    backfillMode: "preview",
    companyDomains: ["brownhouseandtea.pl"],
    ...overrides,
  };
}

function record(uid: number, folder: string): ParsedRecord {
  const id = `mid-${folder}-${uid}@example.com`;
  return {
    message: {
      id,
      providerRef: `imap:${folder}:${uid}`,
      threadId: id,
      subject: `Sprawa ${uid}`,
      from: { name: null, address: folder === "Sent" ? account.address : `klient${uid}@example.com` },
      to: [{ name: null, address: folder === "Sent" ? `klient${uid}@example.com` : account.address }],
      cc: [],
      replyTo: null,
      date: new Date(NOW - uid * 60_000).toISOString(),
      folder,
      seen: false,
      answered: false,
      inReplyTo: null,
      references: [],
      bulk: false,
      attachments: [],
      snippet: "tresc",
    },
    body: "Czy macie matche w puszce?",
  };
}

/** Czytnik z niepustą skrzynką ORAZ niepustym folderem wysłanych. */
class BothFoldersReader implements ImapReader {
  calls: string[] = [];

  async uidsSince(_since: Date, folder?: string): Promise<number[]> {
    this.calls.push(`uidsSince:${folder}`);
    return [1, 2, 3];
  }

  async mailboxState(folder?: string) {
    return { path: folder ?? "INBOX", uidValidity: 4, uidNext: 10, messages: 3 };
  }

  async fetchRange(range: string, folder?: string) {
    this.calls.push(`fetch:${folder}:${range}`);
    const uids = range.includes(":") ? [1, 2, 3] : range.split(",").map(Number);
    return { records: uids.map((uid) => record(uid, folder ?? "INBOX")), problems: [] };
  }
}

/** Pełny odcisk pliku stanu: rozmiar i zawartość, nie tylko liczba rekordów. */
function snapshot(dir: string): { size: number; content: string } {
  const path = join(dir, "inbox.jsonl");
  try {
    return { size: statSync(path).size, content: readFileSync(path, "utf8") };
  } catch {
    return { size: 0, content: "" };
  }
}

describe("tryb podgladu jest bezskutkowy", () => {
  it("snapshot store jest IDENTYCZNY przed i po, takze z folderem wyslanych", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const runtime = createRuntime(config(), store);
    const reader = new BothFoldersReader();
    // Podmieniamy czytnik na nasz: runtime buduje własny z konfiguracji.
    const before = snapshot(dir);

    // Wywołujemy dokładnie tę samą ścieżkę, którą idzie tick.
    const { syncEmailAccount } = await import("./providers/email/sync.js");
    const result = await syncEmailAccount({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "preview",
    });
    expect(result.previewOnly).toBe(true);

    // Folder wysłanych w trybie podglądu też nie ma prawa nic zapisać.
    const sent = await syncSentFolder({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "preview",
    });
    expect(sent).toBeNull();

    const after = snapshot(dir);
    expect(after.size).toBe(before.size);
    expect(after.content).toBe(before.content);
    expect(store.allMessages()).toHaveLength(0);
    expect(store.listCases()).toHaveLength(0);
    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
    expect(store.getCursor({ provider: "email", accountKey: "sklep#sent" })).toBeNull();
    expect(runtime.config.backfillMode).toBe("preview");
  });

  it("po jawnej aktywacji importu folder wyslanych JUZ zapisuje", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const reader = new BothFoldersReader();

    const sent = await syncSentFolder({
      account,
      store,
      reader,
      now: NOW,
      backfillDays: 30,
      backfillMode: "import",
    });
    expect(sent).not.toBeNull();
    expect(sent!.stored).toBeGreaterThan(0);
  });

  it("PELNY tick w trybie podgladu nie zapisuje ani wiadomosci, ani kursora", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const reader = new BothFoldersReader();
    // Czytnik wstrzykniety: test mierzy ZACHOWANIE petli, a nie cierpliwosc
    // czekania, az prawdziwe polaczenie IMAP padnie na timeoucie.
    const runtime = createRuntime(config({ meta: [] }), store, () => reader);
    const before = snapshot(dir);

    const report = await runtime.tick(NOW);

    expect(report.email[0]?.previewOnly).toBe(true);
    // Folder wyslanych NIE zostal nawet dotkniety.
    expect(reader.calls.some((call) => call.includes("Sent"))).toBe(false);

    const newLines = snapshot(dir).content.slice(before.content.length).trim().split("\n").filter(Boolean);
    for (const line of newLines) {
      const event = JSON.parse(line) as { t: string };
      // Dozwolone sa wylacznie wpisy zdrowia. Zadnych wiadomosci, spraw ani kursorow.
      expect(["health"], `nieoczekiwane zdarzenie ${event.t} w trybie podgladu`).toContain(event.t);
    }
    expect(store.allMessages()).toHaveLength(0);
    expect(store.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
    expect(store.getCursor({ provider: "email", accountKey: "sklep#sent" })).toBeNull();
  });

  it("PELNY tick po aktywacji importu dotyka OBU folderow", async () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const reader = new BothFoldersReader();
    // Meta wylaczona: ten test dotyczy WYLACZNIE folderow pocztowych i nie ma
    // wychodzic do sieci.
    const runtime = createRuntime(config({ backfillMode: "import", meta: [] }), store, () => reader);

    await runtime.tick(NOW);

    expect(reader.calls.some((call) => call.startsWith("fetch:INBOX"))).toBe(true);
    expect(reader.calls.some((call) => call.startsWith("fetch:Sent"))).toBe(true);
    expect(store.allMessages().length).toBeGreaterThan(0);
  });
});

describe("webhook Meta nie potwierdza przed trwalym zapisem", () => {
  function signedBody(mid: string): { body: string; signature: string } {
    const body = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "page-1",
          time: 1,
          messaging: [
            {
              sender: { id: "klient-77" },
              recipient: { id: "page-1" },
              timestamp: NOW,
              message: { mid, text: "Czy macie matche?" },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", APP_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
    return { body, signature };
  }

  it("po odpowiedzi 200 wiadomosc jest na dysku, nie tylko w pamieci", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const runtime = createRuntime(config(), store);
    const { body, signature } = signedBody("m_durable_1");

    const result = handleMetaWebhook({
      runtime,
      method: "POST",
      params: new URLSearchParams(),
      rawBody: body,
      signatureHeader: signature,
      now: NOW,
    });
    expect(result.status).toBe(200);

    /*
     * Symulacja nagłej utraty procesu TUŻ PO odpowiedzi: drugi store czyta
     * ten sam plik od zera. Gdyby zapis czekał w buforze, ta wiadomość by
     * tu nie istniała — a Meta, dostawszy 200, nigdy by jej nie ponowiła.
     */
    const afterCrash = new InboxStore({ dir });
    expect(afterCrash.hasMessage({ provider: "facebook", accountKey: "page-1" }, "m_durable_1")).toBe(true);
    expect(afterCrash.listCases()).toHaveLength(1);
  });

  it("sprawa wyliczona z wiadomosci tez przezywa restart w tym oknie", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const runtime = createRuntime(config(), store);
    const { body, signature } = signedBody("m_durable_2");

    handleMetaWebhook({
      runtime,
      method: "POST",
      params: new URLSearchParams(),
      rawBody: body,
      signatureHeader: signature,
      now: NOW,
    });

    const afterCrash = new InboxStore({ dir });
    const record = afterCrash.listCases()[0];
    expect(record).toBeDefined();
    // Bez trwałej projekcji wiadomość byłaby, a sprawa jej nie widziała.
    expect(record!.requiresResponse).toBe(true);
    expect(record!.lastIncomingMessageId).toBe("m_durable_2");
  });

  it("AWARIA ZAPISU nie konczy sie odpowiedzia 200", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const runtime = createRuntime(config(), store);
    const { body, signature } = signedBody("m_awaria_zapisu");

    /*
     * Odwrotna galaz trwalosci.
     *
     * Test obok dowodzi, ze po 200 wiadomosc JEST na dysku. Ten dowodzi
     * drugiej polowy tej samej zasady: jesli zapis sie nie uda, dostawca NIE
     * moze dostac 200. Meta po 200 nie ponowi wiadomosci nigdy, wiec cicha
     * porazka zapisu skasowalaby sprawe klienta bez zadnego sladu.
     */
    const awaria = new Error("dysk pelny");
    vi.spyOn(store, "claimMessageDurable").mockImplementation(() => {
      throw awaria;
    });

    expect(() =>
      handleMetaWebhook({
        runtime,
        method: "POST",
        params: new URLSearchParams(),
        rawBody: body,
        signatureHeader: signature,
        now: NOW,
      }),
    ).toThrow(awaria);

    // Serwer HTTP zamienia ten wyjatek na 500 (patrz `src/bin/mcp-http.ts`),
    // czyli na kod, po ktorym Meta ponawia. Kluczowe jest to, ze NIE ma tu
    // sciezki konczacej sie kodem 200.
    vi.restoreAllMocks();
    const afterCrash = new InboxStore({ dir });
    expect(
      afterCrash.hasMessage({ provider: "facebook", accountKey: "page-1" }, "m_awaria_zapisu"),
    ).toBe(false);
  });

  it("bledny podpis NIE zapisuje niczego i nie dostaje 200", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    const runtime = createRuntime(config(), store);
    const { body } = signedBody("m_obcy");

    const result = handleMetaWebhook({
      runtime,
      method: "POST",
      params: new URLSearchParams(),
      rawBody: body,
      signatureHeader: `sha256=${"0".repeat(64)}`,
      now: NOW,
    });
    expect(result.status).toBe(401);

    const afterCrash = new InboxStore({ dir });
    expect(afterCrash.allMessages()).toHaveLength(0);
  });
});
