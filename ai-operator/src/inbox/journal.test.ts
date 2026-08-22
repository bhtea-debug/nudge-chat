import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxMessage } from "./contract.js";
import { InboxStore } from "./store.js";

/**
 * Uszkodzony dziennik i DWA restarty.
 *
 * Scenariusz z przeglądu: proces ginie w połowie zapisu, zostaje niepełna
 * linia. Pierwszy restart ją pomija i wygląda poprawnie — ale następny append
 * dokleja się do uszkodzonego fragmentu. Przy drugim restarcie znikają OBIE
 * części, a kursor zapisany w międzyczasie stoi już za wiadomością, której
 * w dzienniku nie ma.
 *
 * Ten plik dowodzi, że po naprawie nic takiego się nie dzieje.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-journal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function message(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: id,
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW,
    receivedAt: NOW,
    authorLabel: "klient@example.com",
    subject: "Zamowienie",
    body: "Gdzie paczka?",
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: `${id}@example.com`,
    replyToAddress: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: `fp-${id}`,
    ...overrides,
  };
}

describe("naprawa uszkodzonego dziennika", () => {
  it("ucięta linia, nowy zapis i DRUGI restart nie gubią wiadomości ani kursora", () => {
    const dir = newDir();

    // 1. Normalna praca: dwie wiadomości i kursor.
    const first = new InboxStore({ dir });
    first.claimMessage(message("mid:a"));
    first.claimMessage(message("mid:b"));
    first.commitCursor({ provider: "email", accountKey: "sklep" }, "7:2");
    first.close();

    // 2. Proces ginie w połowie zapisu trzeciej wiadomości.
    appendFileSync(join(dir, "inbox.jsonl"), '{"t":"message","at":1,"messa', "utf8");

    // 3. Pierwszy restart: naprawa, alarm, uszkodzony fragment w kwarantannie.
    const second = new InboxStore({ dir });
    expect(second.allMessages()).toHaveLength(2);
    expect(second.damageReport()?.lines).toBe(1);
    expect(second.getHealth({ provider: "store", accountKey: "integrity" })?.state).toBe("error");

    // 4. Praca idzie dalej: nowa wiadomość i nowy kursor.
    second.claimMessage(message("mid:c"));
    second.commitCursor({ provider: "email", accountKey: "sklep" }, "7:3");
    second.close();

    // 5. DRUGI restart — moment, w którym stara implementacja gubiła obie części.
    const third = new InboxStore({ dir });
    expect(third.allMessages().map((entry) => entry.externalMessageId).sort()).toEqual([
      "mid:a",
      "mid:b",
      "mid:c",
    ]);
    expect(third.getCursor({ provider: "email", accountKey: "sklep" })).toBe("7:3");
    // Kursor NIE stoi przed wiadomością, której brakuje — bo nie brakuje żadnej.
    expect(third.hasMessage({ provider: "email", accountKey: "sklep" }, "mid:c")).toBe(true);
  });

  it("uszkodzenie w ŚRODKU pliku nie zabiera zdarzeń zapisanych po nim", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message("mid:a"));
    store.close();

    const path = join(dir, "inbox.jsonl");
    const original = readFileSync(path, "utf8").trimEnd();
    const good = JSON.stringify({
      t: "cursor",
      at: NOW,
      value: { sourceKey: "email:sklep", cursor: "9:5", committedAt: NOW },
    });
    // Uszkodzony wpis POMIĘDZY dwoma poprawnymi.
    writeLines(path, [original, "{ to nie jest json", good]);

    const repaired = new InboxStore({ dir });
    expect(repaired.allMessages()).toHaveLength(1);
    // Kursor zapisany PO uszkodzeniu przeżył: obcięcie pliku by go zabrało.
    expect(repaired.getCursor({ provider: "email", accountKey: "sklep" })).toBe("9:5");
    expect(repaired.damageReport()?.lines).toBe(1);
  });

  it("uszkodzone bajty trafiają do kwarantanny, a nie do kosza", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message("mid:a"));
    store.close();
    appendFileSync(join(dir, "inbox.jsonl"), '{"t":"message","at":1,"nieskonczone', "utf8");

    const repaired = new InboxStore({ dir });
    const quarantine = repaired.damageReport()?.quarantinePath;
    expect(quarantine).toBeTruthy();
    expect(existsSync(quarantine!)).toBe(true);
    expect(readFileSync(quarantine!, "utf8")).toContain("nieskonczone");
    // Dziennik roboczy jest już czysty.
    expect(readdirSync(dir).filter((name) => name.startsWith("inbox.jsonl.damaged"))).toHaveLength(1);
  });

  it("ogon bez znaku końca linii jest uznany za niedokończony, nawet gdy parsuje się poprawnie", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message("mid:a"));
    store.close();

    // Poprawny JSON, ale BEZ znaku nowej linii: nie wiemy, czy to cały rekord.
    const partial = JSON.stringify({
      t: "cursor",
      at: NOW,
      value: { sourceKey: "email:sklep", cursor: "1:1", committedAt: NOW },
    });
    appendFileSync(join(dir, "inbox.jsonl"), partial, "utf8");

    const repaired = new InboxStore({ dir });
    expect(repaired.damageReport()?.lines).toBe(1);
    // Kursor z niedokończonego zapisu NIE został przyjęty.
    expect(repaired.getCursor({ provider: "email", accountKey: "sklep" })).toBeNull();
  });

  it("alarm integralności zdejmuje wyłącznie świadoma decyzja", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message("mid:a"));
    store.close();
    appendFileSync(join(dir, "inbox.jsonl"), "{ismiec", "utf8");

    const repaired = new InboxStore({ dir });
    expect(repaired.getHealth({ provider: "store", accountKey: "integrity" })?.active).toBe(true);
    expect(repaired.acknowledgeIntegrityAlarm(NOW)).toBe(true);
    repaired.close();

    const after = new InboxStore({ dir });
    const health = after.getHealth({ provider: "store", accountKey: "integrity" });
    expect(health?.state).toBe("ok");
    expect(health?.active).toBe(false);
  });

  it("zdrowy dziennik nie zgłasza uszkodzenia", () => {
    const dir = newDir();
    const store = new InboxStore({ dir });
    store.claimMessage(message("mid:a"));
    store.close();

    const reopened = new InboxStore({ dir });
    expect(reopened.damageReport()).toBeNull();
    expect(reopened.getHealth({ provider: "store", accountKey: "integrity" })).toBeNull();
  });
});

function writeLines(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}
