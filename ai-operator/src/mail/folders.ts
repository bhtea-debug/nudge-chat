/**
 * Wykrywanie folderów skrzynki.
 *
 * Nazwy folderu wysłanych NIE WOLNO zgadywać. W praktyce spotyka się „Sent",
 * „Sent Items", „Sent Messages", „INBOX.Sent", „Elementy wysłane" i wersje
 * zlokalizowane u każdego dostawcy inaczej.
 *
 * IMAP rozwiązuje to atrybutem SPECIAL-USE (`\Sent`), a ImapFlow dodatkowo
 * dopasowuje znane nazwy zlokalizowane i podaje w `specialUseSource`, skąd
 * wziął wynik. Korzystamy z tego zamiast z listy zgadywanych nazw.
 *
 * Znaczenie ma to nie kosmetyczne: bez folderu wysłanych agent nie widzi
 * naszych własnych odpowiedzi i może uznać, że klientowi nikt nie odpisał.
 */

export interface MailboxInfo {
  readonly path: string;
  readonly name: string;
  /** Np. "\\Sent", "\\Drafts", "\\Trash" — albo undefined. */
  readonly specialUse?: string | undefined;
  readonly specialUseSource?: string | undefined;
  readonly subscribed: boolean;
}

export interface FolderPlan {
  readonly inbox: string;
  /** Ścieżka folderu wysłanych albo null, jeśli serwer go nie wskazał. */
  readonly sent: string | null;
  /** Skąd wzięliśmy `sent` — do pokazania człowiekowi, nie do logiki. */
  readonly sentSource: string | null;
  /** Finalna lista folderów do rekonstrukcji wątku. */
  readonly threadFolders: readonly string[];
  /** Ostrzeżenia dla człowieka. Puste = wszystko wskazane jednoznacznie. */
  readonly warnings: readonly string[];
}

/** Wartość MAIL_THREAD_FOLDERS oznaczająca „wykryj sam". */
export const AUTO = "auto";

export function findInbox(boxes: readonly MailboxInfo[]): string {
  const exact = boxes.find((b) => b.path.toUpperCase() === "INBOX");
  return exact?.path ?? boxes[0]?.path ?? "INBOX";
}

export function findSent(boxes: readonly MailboxInfo[]): MailboxInfo | null {
  return boxes.find((b) => b.specialUse === "\\Sent") ?? null;
}

/**
 * Buduje listę folderów do rekonstrukcji wątku.
 *
 * `requested` pochodzi z MAIL_THREAD_FOLDERS. Wartość "auto" (albo jej brak)
 * znaczy: skrzynka odbiorcza plus wykryty folder wysłanych. Jawna lista nazw
 * jest respektowana bez zmian — jeśli ktoś wpisał nazwy ręcznie, wie lepiej.
 */
export function planFolders(
  boxes: readonly MailboxInfo[],
  requested: readonly string[],
  configuredInbox?: string,
): FolderPlan {
  const warnings: string[] = [];
  const inbox = configuredInbox ?? findInbox(boxes);
  const sentBox = findSent(boxes);

  const wantsAuto =
    requested.length === 0 ||
    requested.some((f) => f.trim().toLowerCase() === AUTO);

  let threadFolders: string[];

  if (wantsAuto) {
    threadFolders = [inbox];
    if (sentBox) {
      threadFolders.push(sentBox.path);
    } else {
      warnings.push(
        "Serwer nie wskazał folderu wysłanych (brak atrybutu \\Sent). Agent nie " +
          "zobaczy naszych odpowiedzi i może uznać, że klientowi nikt nie odpisał. " +
          "Wpisz właściwą nazwę ręcznie w MAIL_THREAD_FOLDERS.",
      );
    }
  } else {
    threadFolders = requested.map((f) => f.trim()).filter(Boolean);

    // Jawna lista, ale ktoś podał nazwę, której na serwerze nie ma.
    const known = new Set(boxes.map((b) => b.path));
    for (const f of threadFolders) {
      if (boxes.length > 0 && !known.has(f)) {
        warnings.push(
          `MAIL_THREAD_FOLDERS wskazuje folder "${f}", którego nie ma na serwerze. ` +
            "Będzie po cichu pomijany przy rekonstrukcji wątku.",
        );
      }
    }
    if (sentBox && !threadFolders.includes(sentBox.path)) {
      warnings.push(
        `Serwer wskazuje folder wysłanych "${sentBox.path}", ale nie ma go w ` +
          "MAIL_THREAD_FOLDERS. Agent nie zobaczy naszych odpowiedzi.",
      );
    }
  }

  return {
    inbox,
    sent: sentBox?.path ?? null,
    sentSource: sentBox?.specialUseSource ?? null,
    threadFolders: [...new Set(threadFolders)],
    warnings,
  };
}
