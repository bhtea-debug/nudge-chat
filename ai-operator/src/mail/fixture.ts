import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  GetThreadOptions,
  ListRecentOptions,
  MailMessage,
  MailMessageFull,
  MailProvider,
  MailThread,
  SearchOptions,
} from "./types.js";
import { assignThreadIds, baseSubject, normalizeReferences } from "./thread.js";
import { AUTO, planFolders, type FolderPlan, type MailboxInfo } from "./folders.js";
import { makeSnippet, stripQuotedHistory, toPlainText, truncateBody } from "./text.js";

/**
 * Dostawca na fikstury. Istnieje z dwóch powodów, oba praktyczne:
 *  1. testy i demo działają end-to-end bez dostępu do skrzynki właściciela,
 *  2. dowód, że warstwa poczty jest naprawdę niezależna od dostawcy —
 *     narzędzia AI są identyczne dla IMAP-a i dla plików JSON.
 */

const FixtureMessage = z.object({
  id: z.string(),
  subject: z.string(),
  from: z.object({ name: z.string().nullable().default(null), address: z.string() }),
  to: z.array(z.object({ name: z.string().nullable().default(null), address: z.string() })).default([]),
  cc: z.array(z.object({ name: z.string().nullable().default(null), address: z.string() })).default([]),
  date: z.string(),
  folder: z.string().default("INBOX"),
  seen: z.boolean().default(false),
  answered: z.boolean().default(false),
  inReplyTo: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  attachments: z
    .array(
      z.object({
        filename: z.string().nullable().default(null),
        contentType: z.string().nullable().default(null),
        sizeBytes: z.number().int().nonnegative().nullable().default(null),
      }),
    )
    .default([]),
  text: z.string().default(""),
  html: z.string().nullable().default(null),
});

/**
 * Foldery deklarowane JAWNIE, dokładnie tak, jak serwer IMAP deklaruje je
 * atrybutem SPECIAL-USE. Nie ma tu zgadywania po nazwie — gdyby fikstura
 * pozwalała rozpoznać folder wysłanych po tym, że nazywa się „Sent",
 * testowałaby coś innego niż zachowanie produkcyjne.
 */
const FixtureFolder = z.object({
  path: z.string(),
  specialUse: z.string().nullable().default(null),
});

const FixtureFile = z.object({
  folders: z.array(FixtureFolder).default([{ path: "INBOX", specialUse: null }]),
  messages: z.array(FixtureMessage),
});

/**
 * Fikstury zapisują datę względnie: "{{-2h}}", "{{-1d}}", "{{-45m}}".
 * Bez tego wiadomość „z dzisiaj" wypadałaby z okna `sinceDays` dzień po
 * napisaniu testu, a filtr czasu przestałby być testowany.
 */
const RELATIVE_DATE = /^\{\{-(\d+)([mhd])\}\}$/;

export function resolveFixtureDate(value: string, now: number = Date.now()): string {
  const m = RELATIVE_DATE.exec(value.trim());
  if (!m) return new Date(value).toISOString();
  const amount = Number(m[1]);
  const unitMs = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(now - amount * unitMs).toISOString();
}

export type FixtureMessageInput = z.input<typeof FixtureMessage>;

export class FixtureMailProvider implements MailProvider {
  readonly id = "fixture";
  readonly features = {
    serverSideSearch: false,
    fullTextSearch: true,
    threads: true,
  } as const;

  private readonly records: { message: MailMessage; body: string }[];
  private readonly folders: readonly MailboxInfo[];
  private readonly requestedThreadFolders: readonly string[];

  constructor(input: {
    filePath?: string;
    messages?: readonly FixtureMessageInput[];
    threadFolders?: readonly string[];
  }) {
    const file = input.filePath
      ? FixtureFile.parse(JSON.parse(readFileSync(input.filePath, "utf8")))
      : FixtureFile.parse({ messages: input.messages ?? [] });
    const raw = file.messages;

    this.folders = file.folders.map((f) => ({
      path: f.path,
      name: f.path.split(/[./]/).pop() ?? f.path,
      specialUse: f.specialUse ?? undefined,
      specialUseSource: f.specialUse ? "extension" : undefined,
      subscribed: true,
    }));
    this.requestedThreadFolders = input.threadFolders ?? [AUTO];

    const parsed = raw.map((m) => {
      const body = toPlainText(m.text, m.html);
      const message: MailMessage = {
        id: m.id,
        providerRef: `fixture:${m.folder}:${m.id}`,
        threadId: m.id,
        subject: m.subject.trim() || "(brak tematu)",
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: resolveFixtureDate(m.date),
        folder: m.folder,
        seen: m.seen,
        answered: m.answered,
        inReplyTo: m.inReplyTo,
        references: normalizeReferences(m.references, m.inReplyTo),
        attachments: m.attachments,
        snippet: makeSnippet(stripQuotedHistory(body)),
      };
      return { message, body };
    });

    const threadIds = assignThreadIds(parsed.map((p) => p.message));
    this.records = parsed.map((p) => ({
      ...p,
      message: { ...p.message, threadId: threadIds.get(p.message.id) ?? p.message.id },
    }));
  }

  async close(): Promise<void> {}

  /** Ta sama diagnostyka co w adapterze IMAP — patrz folders.ts. */
  async listMailboxes(): Promise<MailboxInfo[]> {
    return [...this.folders];
  }

  async resolveFolders(): Promise<FolderPlan> {
    return planFolders(this.folders, this.requestedThreadFolders, "INBOX");
  }

  async listRecent(opts: ListRecentOptions): Promise<MailMessage[]> {
    const folder = opts.folder ?? "INBOX";
    return this.records
      .filter((r) => r.message.folder === folder)
      .filter((r) => new Date(r.message.date) >= opts.since)
      .filter((r) => (opts.unreadOnly ? !r.message.seen : true))
      .map((r) => r.message)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, opts.limit);
  }

  async search(opts: SearchOptions): Promise<MailMessage[]> {
    const needle = opts.query.toLowerCase().trim();
    if (!needle) return [];
    return this.records
      .filter((r) => (opts.folder ? r.message.folder === opts.folder : true))
      .filter((r) => (opts.since ? new Date(r.message.date) >= opts.since : true))
      .filter((r) => {
        const haystack = [
          r.message.subject,
          r.message.from?.name ?? "",
          r.message.from?.address ?? "",
          r.body,
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .map((r) => r.message)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, opts.limit);
  }

  async getThread(opts: GetThreadOptions): Promise<MailThread | null> {
    const seed = this.records.find((r) => r.message.id === opts.messageId);
    if (!seed) return null;
    const threadId = seed.message.threadId;
    const members = this.records
      .filter((r) => r.message.threadId === threadId)
      .sort((a, b) => a.message.date.localeCompare(b.message.date))
      .slice(0, opts.maxMessages);

    const messages: MailMessageFull[] = members.map((r) => {
      const { body, truncated } = truncateBody(stripQuotedHistory(r.body));
      return { ...r.message, body, bodyTruncated: truncated };
    });

    return {
      threadId,
      subject: baseSubject(members[0]?.message.subject ?? seed.message.subject),
      messageCount: messages.length,
      messages,
    };
  }
}
