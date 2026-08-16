import { z } from "zod";
import {
  CapabilityError,
  type AnyCapability,
  type Capability,
} from "../capability/types.js";
import { MailMessage, MailThread, type MailProvider } from "./types.js";
import { hashShort, maskAddressesInText } from "./text.js";

/**
 * Capability poczty. Trzy, nie dziesięć: wypisz ostatnie, znajdź, pokaż wątek.
 * Metadane załączników są już częścią każdej wiadomości, więc osobna
 * capability na nie byłaby czwartym narzędziem bez nowej informacji.
 *
 * Żadna z nich nie zmienia stanu skrzynki. Nie ma tu wysyłki, nie ma
 * oznaczania jako przeczytane, nie ma przenoszenia i nie ma usuwania.
 */

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const ListRecentInput = z.object({
  sinceDays: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(1)
    .describe("Ile dni wstecz. 1 = dzisiaj i wczoraj."),
  limit: z.number().int().min(1).max(50).default(25).describe("Maksymalna liczba wiadomości."),
  unreadOnly: z.boolean().default(false).describe("Tylko nieprzeczytane."),
  folder: z.string().optional().describe('Folder, domyślnie skrzynka odbiorcza.'),
});

const ListRecentOutput = z.object({
  provider: z.string(),
  folder: z.string(),
  sinceIso: z.string(),
  count: z.number().int().nonnegative(),
  messages: z.array(MailMessage),
});

const SearchInput = z.object({
  query: z
    .string()
    .min(2)
    .max(100)
    .describe(
      "Fraza szukana w temacie, nadawcy i treści. Numer zamówienia, nazwisko, nazwa produktu.",
    ),
  sinceDays: z.number().int().min(1).max(365).optional().describe("Ogranicz do ostatnich N dni."),
  limit: z.number().int().min(1).max(50).default(20),
  folder: z.string().optional(),
});

const SearchOutput = z.object({
  provider: z.string(),
  query: z.string(),
  count: z.number().int().nonnegative(),
  /** Uczciwa informacja o jakości wyszukiwania danego dostawcy. */
  searchNote: z.string(),
  messages: z.array(MailMessage),
});

const GetThreadInput = z.object({
  messageId: z
    .string()
    .min(1)
    .describe(
      "Identyfikator wiadomości (pole id) zwrócony przez mail_list_recent albo mail_search.",
    ),
  maxMessages: z.number().int().min(1).max(20).default(10),
});

export function createMailCapabilities(
  getProvider: () => Promise<MailProvider>,
): AnyCapability[] {
  const listRecent: Capability<z.infer<typeof ListRecentInput>, z.infer<typeof ListRecentOutput>> = {
    name: "mail_list_recent",
    version: "1.0.0",
    description:
      "Wypisuje ostatnie wiadomości ze skrzynki odbiorczej wraz z tematem, nadawcą, datą, " +
      "flagami i krótkim podglądem treści. Użyj tego jako pierwszego kroku przy pytaniu " +
      "„co ważnego przyszło”. Zwraca podgląd, nie pełną treść — po pełną treść użyj mail_get_thread.",
    scope: "mail:read",
    effectClass: "read",
    input: ListRecentInput,
    output: ListRecentOutput,
    auditRefs: (input, output) => ({
      sinceDays: input.sinceDays,
      unreadOnly: input.unreadOnly,
      count: output?.count ?? 0,
    }),
    handler: async (input, ctx) => {
      const provider = await getProvider();
      const since = daysAgo(input.sinceDays);
      const messages = await provider.listRecent({
        limit: input.limit,
        since,
        unreadOnly: input.unreadOnly,
        ...(input.folder ? { folder: input.folder } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        provider: provider.id,
        folder: input.folder ?? "INBOX",
        sinceIso: since.toISOString(),
        count: messages.length,
        messages,
      };
    },
  };

  const search: Capability<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>> = {
    name: "mail_search",
    version: "1.0.0",
    description:
      "Szuka wiadomości po frazie w temacie, nadawcy i treści. Użyj, gdy szukasz konkretnego " +
      "numeru zamówienia, klienta, produktu albo sprawy. Pusty wynik znaczy „nie znalazłem” — " +
      "nie znaczy „nie ma”. W takim wypadku powiedz to wprost, nie domyślaj się treści.",
    scope: "mail:read",
    effectClass: "read",
    input: SearchInput,
    output: SearchOutput,
    auditRefs: (input, output) => ({
      // Zapytanie to działanie agenta, nie treść korespondencji — i dokładnie
      // ono odpowiada na pytanie "czego agent szukał, zanim odpowiedział".
      // Adresy maskujemy: model może szukać po adresie nadawcy, a adresy
      // nadawców do audytu nie trafiają.
      query: maskAddressesInText(input.query),
      count: output?.count ?? 0,
    }),
    handler: async (input, ctx) => {
      const provider = await getProvider();
      const messages = await provider.search({
        query: input.query,
        limit: input.limit,
        ...(input.sinceDays ? { since: daysAgo(input.sinceDays) } : {}),
        ...(input.folder ? { folder: input.folder } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        provider: provider.id,
        query: input.query,
        count: messages.length,
        searchNote: provider.features.fullTextSearch
          ? "Wyszukiwanie obejmuje temat, nadawcę i treść."
          : "Wyszukiwanie obejmuje wyłącznie temat i nadawcę — treść nie jest indeksowana.",
        messages,
      };
    },
  };

  const getThread: Capability<z.infer<typeof GetThreadInput>, MailThread> = {
    name: "mail_get_thread",
    version: "1.0.0",
    description:
      "Zwraca pełny wątek korespondencji dla wskazanej wiadomości, chronologicznie, z treścią " +
      "każdej wiadomości po odcięciu cytowanej historii. Użyj, gdy podgląd nie wystarcza, " +
      "żeby zrozumieć, o co pyta klient albo co już zostało ustalone.",
    scope: "mail:read",
    effectClass: "read",
    input: GetThreadInput,
    output: MailThread,
    auditRefs: (input, output) => ({
      messageIdHash: hashShort(input.messageId),
      messageCount: output?.messageCount ?? 0,
    }),
    handler: async (input, ctx) => {
      const provider = await getProvider();
      const thread = await provider.getThread({
        messageId: input.messageId,
        maxMessages: input.maxMessages,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!thread) {
        throw new CapabilityError(
          "not_found",
          `nie znaleziono wiadomości o id "${input.messageId}" w skonfigurowanych folderach`,
        );
      }
      return thread;
    },
  };

  return [listRecent, search, getThread];
}
