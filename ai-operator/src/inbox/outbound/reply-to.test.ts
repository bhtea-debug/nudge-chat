import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { CLASSIFIER_VERSION, type InboxMessage } from "../contract.js";
import { InboxStore, type StoredCase } from "../store.js";
import { resolveRecipient } from "./recipient.js";

/**
 * `Reply-To` ma pierwszeństwo przed `From`.
 *
 * Formularze kontaktowe i systemy zgłoszeniowe wysyłają z `From: no-reply@…`,
 * a prawdziwy adres klienta wkładają w `Reply-To`. Odpowiedź na `From`
 * trafiłaby w skrzynkę, której nikt nie czyta — a my zapisalibyśmy ją jako
 * dostarczoną i zamknęli sprawę.
 */

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-replyto-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: InboxStore, message: Partial<InboxMessage>): StoredCase {
  store.claimMessage({
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    externalMessageId: "mid:1",
    caseId: "ic_sprawa",
    direction: "incoming",
    sourceCreatedAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
    authorLabel: "no-reply@formularz.example",
    subject: "Zapytanie ze strony",
    body: "Czy macie matche w puszce?",
    bodyTruncated: false,
    attachments: [],
    replyToAddress: null,
    rfcMessageId: "form-1@formularz.example",
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: "fp1",
    ...message,
  });

  const record: StoredCase = {
    caseId: "ic_sprawa",
    provider: "email",
    accountKey: "sklep",
    externalConversationId: "conv-1",
    subject: "Zapytanie ze strony",
    participantLabel: "no-reply@formularz.example",
    orderRef: null,
    firstSeenAt: NOW - 10_000,
    lastMessageAt: NOW - 5_000,
    lastIncomingMessageId: "mid:1",
    lastIncomingAt: NOW - 5_000,
    messageCount: 1,
    requiresResponse: true,
    pendingAction: false,
    classifierVersion: CLASSIFIER_VERSION,
    classificationReason: "customer_message",
    needsReview: false,
    sourceClosed: false,
    hasAttachments: false,
  };
  store.upsertCase(record);
  return record;
}

describe("wybor adresu odpowiedzi", () => {
  it("odpowiedz idzie do Reply-To, a NIE do From: no-reply", () => {
    const store = freshStore();
    const record = seed(store, { replyToAddress: "klient@example.com" });

    const resolved = resolveRecipient(store, record);
    expect(resolved).toMatchObject({ ok: true, recipient: "klient@example.com" });
    // Interfejs musi móc pokazać, że odpowiedź poleci gdzie indziej.
    expect(resolved.ok && resolved.differsFromSender).toBe(true);
  });

  it("bez Reply-To zostaje From", () => {
    const store = freshStore();
    const record = seed(store, { authorLabel: "klient@example.com", replyToAddress: null });
    const resolved = resolveRecipient(store, record);
    expect(resolved).toMatchObject({ ok: true, recipient: "klient@example.com" });
    expect(resolved.ok && resolved.differsFromSender).toBe(false);
  });

  it("nieprawidlowy Reply-To jest ignorowany na rzecz From", () => {
    const store = freshStore();
    const record = seed(store, {
      authorLabel: "klient@example.com",
      // Adres bez domeny: przyjecie go znaczyloby wyslanie w prozne.
      replyToAddress: "to-nie-jest-adres",
    });
    expect(resolveRecipient(store, record)).toMatchObject({
      ok: true,
      recipient: "klient@example.com",
    });
  });

  it("gdy oba adresy sa niepoprawne, nie ma do kogo pisac", () => {
    const store = freshStore();
    const record = seed(store, { authorLabel: "no-reply", replyToAddress: "tez-nie-adres" });
    expect(resolveRecipient(store, record)).toMatchObject({
      ok: false,
      code: "recipient_unknown",
    });
  });

  it("Reply-To z NOWSZEJ wiadomosci wygrywa ze starszym", () => {
    const store = freshStore();
    const record = seed(store, { replyToAddress: "stary@example.com" });
    store.claimMessage({
      provider: "email",
      accountKey: "sklep",
      externalConversationId: "conv-1",
      externalMessageId: "mid:2",
      caseId: "ic_sprawa",
      direction: "incoming",
      sourceCreatedAt: NOW - 1_000,
      receivedAt: NOW - 1_000,
      authorLabel: "no-reply@formularz.example",
      subject: "Zapytanie ze strony",
      body: "Dopisuje jeszcze jedno pytanie.",
      bodyTruncated: false,
      attachments: [],
      replyToAddress: "nowy@example.com",
      rfcMessageId: "form-2@formularz.example",
      rfcInReplyTo: null,
      rfcReferences: [],
      isEcho: false,
      bulkHint: false,
      contentFingerprint: "fp2",
    });
    expect(resolveRecipient(store, record)).toMatchObject({
      ok: true,
      recipient: "nowy@example.com",
    });
  });
});

describe("parser naglowka Reply-To", () => {
  async function parseReplyTo(raw: string): Promise<string | null> {
    const parsed = await simpleParser(Buffer.from(raw, "utf8"));
    const value = parsed.replyTo;
    if (!value || Array.isArray(value)) return null;
    const values = value.value ?? [];
    // Kontrakt: JEDEN adres albo nic. Wybor jednego z wielu bylby zgadywaniem.
    if (values.length !== 1) return null;
    return values[0]?.address?.toLowerCase() ?? null;
  }

  it("pojedynczy adres jest przyjmowany", async () => {
    const raw = [
      "From: Formularz <no-reply@formularz.example>",
      "Reply-To: Klient <klient@example.com>",
      "Subject: Zapytanie",
      "",
      "Tresc",
    ].join("\r\n");
    expect(await parseReplyTo(raw)).toBe("klient@example.com");
  });

  it("DWA adresy w Reply-To sa odrzucane", async () => {
    const raw = [
      "From: Formularz <no-reply@formularz.example>",
      "Reply-To: jeden@example.com, dwa@example.com",
      "Subject: Zapytanie",
      "",
      "Tresc",
    ].join("\r\n");
    // Wybor jednego z dwoch bylby zgadywaniem, do kogo klient chce odpowiedzi.
    expect(await parseReplyTo(raw)).toBeNull();
  });

  it("brak naglowka daje null", async () => {
    const raw = ["From: klient@example.com", "Subject: Zapytanie", "", "Tresc"].join("\r\n");
    expect(await parseReplyTo(raw)).toBeNull();
  });
});
