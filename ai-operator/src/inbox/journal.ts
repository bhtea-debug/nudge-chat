import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Dziennik zdarzeń: zapis, odtwarzanie i naprawa uszkodzonego ogona.
 *
 * Wydzielone z `store.ts`, bo trwałość jest osobnym problemem od domeny —
 * i osobno się psuje.
 *
 * Awaria, której ten plik ma zapobiec, jest podstępna. Proces zabity w trakcie
 * `write` zostawia niepełną ostatnią linię. Odtwarzanie ją pomija i wygląda
 * poprawnie. Ale następny append DOKLEJA poprawne zdarzenie do uszkodzonego
 * fragmentu — powstaje jedna, nieparsowalna linia zawierająca prawdziwe
 * zdarzenie. Przy kolejnym restarcie znika już nie jeden ogon, tylko OBIE
 * części. Jeżeli w międzyczasie zapisał się kursor, stoi on za wiadomością,
 * której w dzienniku już nie ma. To jest dokładnie ta cicha utrata, której
 * zabrania kontrakt.
 */

export interface JournalDamage {
  /** Ile linii nie dało się odczytać. */
  readonly lines: number;
  /** Gdzie odłożono uszkodzone bajty. Do ręcznego obejrzenia, nie do kasowania. */
  readonly quarantinePath: string | null;
  readonly detectedAt: number;
}

export interface ReplayResult<T> {
  readonly events: T[];
  readonly damage: JournalDamage | null;
}

export class Journal {
  private fd: number | null = null;

  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  /**
   * Odtworzenie z naprawą.
   *
   * Uszkodzone linie trafiają do pliku kwarantanny, a dziennik jest
   * przepisywany ATOMOWO z samych poprawnych zdarzeń. Przepisanie zamiast
   * obcięcia jest ważne: uszkodzenie w ŚRODKU pliku obcięciem zabrałoby też
   * wszystkie prawdziwe zdarzenia po nim.
   */
  replay<T>(parse: (line: string) => T): ReplayResult<T> {
    if (!existsSync(this.path)) return { events: [], damage: null };

    const raw = readFileSync(this.path, "utf8");
    if (raw.length === 0) return { events: [], damage: null };

    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    // Ostatni element po splicie jest pusty dla pliku zakończonego znakiem
    // nowej linii. Jeżeli nie jest pusty, to jest niedokończony zapis.
    const tail = lines.pop() ?? "";

    const events: T[] = [];
    const valid: string[] = [];
    const damaged: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(parse(line));
        valid.push(line);
      } catch {
        damaged.push(line);
      }
    }

    if (tail.trim().length > 0) {
      // Ogon bez znaku końca linii jest niedokończonym zapisem NAWET wtedy,
      // gdy przypadkiem daje się sparsować: nie wiemy, czy to cały rekord.
      if (endsWithNewline) {
        try {
          events.push(parse(tail));
          valid.push(tail);
        } catch {
          damaged.push(tail);
        }
      } else {
        damaged.push(tail);
      }
    }

    if (damaged.length === 0) return { events, damage: null };

    const quarantinePath = `${this.path}.damaged-${valid.length}`;
    try {
      writeFileSync(quarantinePath, `${damaged.join("\n")}\n`, "utf8");
    } catch {
      // Kwarantanna jest dowodem do obejrzenia, nie warunkiem naprawy.
    }
    this.rewrite(valid);

    return {
      events,
      damage: { lines: damaged.length, quarantinePath, detectedAt: Date.now() },
    };
  }

  /** Atomowe przepisanie: zapis do pliku tymczasowego, fsync, rename. */
  rewrite(lines: readonly string[]): void {
    this.close();
    const tmp = `${this.path}.tmp`;
    const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }

  /**
   * Dopisanie jednego zdarzenia.
   *
   * `durable` wymusza `fsync`. NIE robimy tego po każdym zdarzeniu, bo to
   * kosztuje kilka milisekund na wpis, a partia pięciuset wiadomości zamienia
   * się w kilkusekundowy przestój.
   *
   * Wystarczy fsync w momencie, w którym stan przestaje być odtwarzalny:
   * przy zatwierdzeniu kursora i przy ledgerze wysyłki. `fsync` opróżnia CAŁY
   * bufor pliku, więc jedno wymuszenie przed przesunięciem kursora utrwala też
   * wszystkie wcześniejsze wiadomości tej partii. Zapisy, które przepadną
   * przed takim wymuszeniem, zostaną po prostu pobrane ponownie — kursor się
   * po nich nie przesunął.
   */
  append(line: string, durable = false): void {
    if (this.fd === null) this.fd = openSync(this.path, "a");
    writeSync(this.fd, `${line}\n`);
    if (durable) fsyncSync(this.fd);
  }

  /** Wymuszenie na dysk bez zapisu. Używane przed operacją nieodwracalną. */
  flush(): void {
    if (this.fd !== null) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}
