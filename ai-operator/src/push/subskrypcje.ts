import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromPackageRoot } from "../paths.js";

/**
 * Gdzie mieszka zgoda właściciela na powiadomienia.
 *
 * Subskrypcja Web Push to trzy rzeczy: adres bramki push wystawiony przez Apple
 * dla TEGO urządzenia i dwa klucze, którymi szyfrujemy ładunek. Bez nich nie da
 * się wysłać powiadomienia, a mając je — da się wysłać dowolne. Traktujemy je
 * więc jak sekret: plik z prawami 600, nigdy w logu, nigdy w odpowiedzi HTTP.
 *
 * Trzymamy je w katalogu stanu Copilota, obok dziennika spraw, z jednego
 * praktycznego powodu: to ten sam katalog, który na serwerze ma być woluminem
 * trwałym. Gdyby subskrypcje poszły gdzie indziej, przeżywałyby restart w innym
 * rytmie niż sprawy i różnica wychodziłaby na jaw dopiero w awarii.
 *
 * **Bez woluminu subskrypcja ginie przy restarcie kontenera** i właściciel musi
 * włączyć powiadomienia ponownie. To jest znane ograniczenie, nie usterka —
 * opisane w docs/GO-NOGO-VALIDATION.md.
 */

export interface Subskrypcja {
  /** Adres bramki push. Unikalny dla urządzenia — służy też za identyfikator. */
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly dodanaO: string;
  /** Do czego to urządzenie należy. Wpisywane ręcznie, np. „iPhone Michała". */
  readonly opis: string;
}

const PLIK = "push-subskrypcje.json";

export class Subskrypcje {
  private readonly sciezka: string;
  private pamiec: Subskrypcja[] | null = null;

  constructor(stateDir: string) {
    this.sciezka = join(fromPackageRoot(stateDir), PLIK);
  }

  wszystkie(): Subskrypcja[] {
    if (this.pamiec) return this.pamiec;
    try {
      const surowe: unknown = JSON.parse(readFileSync(this.sciezka, "utf8"));
      this.pamiec = Array.isArray(surowe) ? surowe.filter(poprawna) : [];
    } catch {
      // Brak pliku to normalny stan przed pierwszą subskrypcją. Plik uszkodzony
      // traktujemy tak samo: lepiej poprosić o ponowne włączenie powiadomień
      // niż wywrócić serwer na pliku, który i tak jest odtwarzalny jednym
      // dotknięciem ekranu.
      this.pamiec = [];
    }
    return this.pamiec;
  }

  ile(): number {
    return this.wszystkie().length;
  }

  /** Idempotentne: ten sam endpoint nadpisuje wpis, nie dokłada drugiego. */
  dodaj(s: Subskrypcja): void {
    const bez = this.wszystkie().filter((x) => x.endpoint !== s.endpoint);
    this.zapisz([...bez, s]);
  }

  usun(endpoint: string): boolean {
    const przed = this.wszystkie().length;
    const po = this.wszystkie().filter((x) => x.endpoint !== endpoint);
    if (po.length === przed) return false;
    this.zapisz(po);
    return true;
  }

  private zapisz(lista: Subskrypcja[]): void {
    mkdirSync(dirname(this.sciezka), { recursive: true });
    // Zapis przez plik tymczasowy: przerwanie w połowie nie zostawia pliku
    // w połowie zapisanego, czyli takiego, po którym powiadomienia cicho
    // przestają działać.
    const tmp = `${this.sciezka}.tmp`;
    writeFileSync(tmp, JSON.stringify(lista, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.sciezka);
    this.pamiec = lista;
  }
}

function poprawna(x: unknown): x is Subskrypcja {
  const r = x as Partial<Subskrypcja> | null;
  return (
    !!r &&
    typeof r.endpoint === "string" &&
    r.endpoint.startsWith("https://") &&
    typeof r.keys?.p256dh === "string" &&
    typeof r.keys?.auth === "string"
  );
}
