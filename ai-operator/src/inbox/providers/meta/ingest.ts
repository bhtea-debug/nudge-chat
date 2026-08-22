import type { InboxMessage, SourceKey } from "../../contract.js";
import { projectCase } from "../../project.js";
import type { InboxStore } from "../../store.js";
import type { MetaAccount, NormalizedMetaEvent } from "./webhook.js";

/**
 * Zapis zdarzeń Meta do trwałego stanu.
 *
 * Webhook jest szybką ścieżką, nie źródłem prawdy. Ten moduł ma dawać ten sam
 * wynik niezależnie od tego, ile razy i w jakiej kolejności zdarzenia dotrą,
 * bo Meta nie gwarantuje ani jednego, ani drugiego. Uzgodnienie przez Graph API
 * wchodzi tą samą drogą i dlatego nie może zrobić duplikatów.
 */

export interface IngestResult {
  readonly stored: number;
  readonly duplicates: number;
  readonly echoes: number;
  readonly ignored: number;
  readonly deliveries: string[];
  readonly touchedCaseIds: string[];
}

export function ingestMetaEvents(
  store: InboxStore,
  events: readonly NormalizedMetaEvent[],
  options: { readonly backfill?: boolean } = {},
): IngestResult {
  let stored = 0;
  let duplicates = 0;
  let echoes = 0;
  let ignored = 0;
  const deliveries: string[] = [];
  const touched = new Set<string>();

  for (const event of events) {
    if (event.kind === "delivery") {
      deliveries.push(...(event.deliveredMids ?? []));
      continue;
    }
    if (event.kind !== "message" || !event.message) {
      ignored += 1;
      continue;
    }

    const message = event.message;
    const key: SourceKey = { provider: message.provider, accountKey: message.accountKey };

    // Dedup po zewnętrznym identyfikatorze wiadomości. Powtórka webhooka,
    // ponowne doręczenie i uzgodnienie trafiają w ten sam klucz.
    if (store.hasMessage(key, message.externalMessageId)) {
      duplicates += 1;
      continue;
    }
    if (message.isEcho) echoes += 1;

    if (store.claimMessage(message)) {
      stored += 1;
      touched.add(message.caseId);
    } else {
      duplicates += 1;
    }
  }

  // Projekcja PO zapisie. Zdarzenia z odwróconą kolejnością dają ten sam stan,
  // bo sprawa jest wyliczana z posortowanego zbioru, a nie z ostatniego wpisu.
  for (const caseId of touched) {
    const projected = projectCase(store, caseId);
    if (projected) store.upsertCase(projected);
  }

  return {
    stored,
    duplicates,
    echoes,
    ignored,
    deliveries,
    touchedCaseIds: [...touched],
  };
}

/**
 * Uzgodnienie rozmów Meta.
 *
 * Wywoływane okresowo, niezależnie od webhooków, bo webhook potrafi nie
 * dojść: aplikacja bywa chwilowo niedostępna, subskrypcja bywa zerwana przy
 * zmianie uprawnień, a Meta ponawia doręczenie ograniczoną liczbę razy.
 * Bez tego kroku awaria webhooka jest równoznaczna z cichą utratą.
 */
export interface MetaConversationFetcher {
  listConversations(input: {
    readonly account: MetaAccount;
    readonly sinceMs: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly InboxMessage[]>;
}

export async function reconcileMetaAccount(input: {
  readonly store: InboxStore;
  readonly account: MetaAccount;
  readonly fetcher: MetaConversationFetcher;
  readonly sinceMs: number;
  readonly signal?: AbortSignal;
}): Promise<IngestResult> {
  const messages = await input.fetcher.listConversations({
    account: input.account,
    sinceMs: input.sinceMs,
    signal: input.signal,
  });
  return ingestMetaEvents(
    input.store,
    messages.map((message) => ({ kind: "message" as const, message })),
  );
}
