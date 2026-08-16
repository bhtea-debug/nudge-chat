# Łatka read-only dla TeaBrew v2

Te pliki dodają do TeaBrew v2 **pięć tras GET tylko do czytania**, z których
korzysta agent `inbox-operator`. Nie zmieniają istniejącego zachowania i nie
dodają ani jednej mutacji.

Leżą tutaj, a nie w `teabrew-v2`, z prostego powodu: to repozytorium ma do
`teabrew-v2` dostęp wyłącznie do odczytu. Łatkę zakłada człowiek z uprawnieniami
do tamtego repo.

## Co dokładnie dochodzi

| trasa | odpowiada na pytanie |
| --- | --- |
| `GET /ai-operator/health` | czy łatka jest założona i czy deklaruje read-only |
| `GET /ai-operator/order?ref=` | co z zamówieniem o tym numerze |
| `GET /ai-operator/stock?codes=&profile=` | czy mamy ten towar i ile jest dostępne |
| `GET /ai-operator/product-search?query=` | jak się nazywa i jaki kod ma to, o czym pisze klient |
| `GET /ai-operator/production?limit=&status=` | jak wygląda bieżąca produkcja |

Nazwy tras są nazwane po konsumencie — tak samo jak istniejące `/medusa/*`,
`/b2b/*` i `/budzeciek/*`.

> **Ta łatka jest już założona.** Kod znajduje się w PR
> [`bhtea-debug/teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27),
> gałąź `claude/ai-operator-read-only-endpoints`. Pliki poniżej zostają jako
> źródło kontraktu i jako referencja przy review — instrukcja „jak założyć"
> jest potrzebna tylko, gdyby trzeba było odtworzyć zmianę od zera.
>
> Do zrobienia po stronie człowieka: review i merge, ustawienie
> `AI_OPERATOR_API_TOKEN` w zmiennych Convex, wdrożenie przez guarded command.

## Stan weryfikacji tej łatki

Sprawdzona wobec `teabrew-v2` na `main` (`b777d4d`, „Eksport do Budzecika: ceny
sieci sa NETTO"):

- **Kompiluje się wobec prawdziwego schematu.** `queries/aiOperator.ts` plus
  zmiana z `lib/salesAvailability.export.md` przechodzą `tsc --noEmit` przy
  realnym `convex/_generated/dataModel.d.ts` i realnym `convex/schema.ts` —
  zero błędów. To potwierdza każdą nazwę pola, nazwę indeksu i sygnaturę helpera.
- **Bezpieczeństwo jest testowane, nie obiecane.** `tests/patch-security.test.ts`
  (12 testów) sprawdza: brak mutacji i akcji, wyłącznie `internalQuery`, brak
  `v.any()` i dynamicznych nazw tabel, zamknięta lista sześciu czytanych tabel,
  wyłącznie metody GET, autoryzacja przed jakimkolwiek zapytaniem, token tylko
  z nagłówka, porównanie w czasie stałym, fail-closed przy braku tokenu, brak
  żądania i tokenu w logach, brak danych kontaktowych klienta w odpowiedzi.

Cztery rozjazdy wobec pierwszej wersji łatki zostały **znalezione i naprawione**
przy tej weryfikacji:

| co było źle | dlaczego to miało znaczenie |
| --- | --- |
| `gramatura` czytana jako tekst | w schemacie to `v.optional(v.number())` — gramy liczbą. Każde wyszukanie produktu z ustawioną gramaturą łamałoby kontrakt |
| zapytanie o `productionRuns.status === "running"` | tego statusu **nie ma** w schemacie. Zapytanie zwracałoby zawsze zero wierszy, więc agent raportowałby „nic się nie produkuje" przy pracującej hali — cicho fałszywa odpowiedź |
| własne dopasowanie materiału po `code` | kalkulator dostępności preferuje materiał z tagiem `sku`. Naiwne „pierwszy o tym kodzie" opisywałoby ilość jednego materiału nazwą i jednostką drugiego |
| `ctx: { db: any }` | repo używa `QueryCtx` z `_generated/server` (patrz `queries/b2bStock.ts`) — `any` kasowało kontrolę typów dokładnie tam, gdzie jest najbardziej potrzebna |

## Jak założyć

Repozytorium `teabrew-v2` ma własny kontrakt pracy w `AGENTS.md`. Przeczytaj go
przed zmianą i wykonaj wymagane tam kroki (`git remote -v`, `git fetch origin main`,
świeży worktree z `origin/main`). **Nie uruchamiaj `convex deploy`, `convex dev`
ani `convex codegen`, dopóki środowisko wskazuje na wdrożenie live** — wdrożenie
idzie wyłącznie przez opisane tam guardy.

Przeczytaj też `AGENTS.md` i `docs/DEPLOYMENT_SAFETY.md` w `teabrew-v2` —
wdrożenie na żywe Convex idzie **wyłącznie** przez `npm run convex:live:check`
i `npm run convex:live:deploy -- --confirm=<nazwa-wdrożenia>`. To jest celowa
bramka dla człowieka; nie obchodź jej `convex deploy` ani `convex codegen`.

1. **Skopiuj plik z zapytaniami**

   ```
   convex/queries/aiOperator.ts
   ```

   Zawiera cztery `internalQuery`: `orderByRef`, `stockByCodes`, `findProduct`,
   `productionStatus`. Żadnej mutacji.

   `internalQuery`, a nie `query`, jest tu istotne: publiczne `query` byłoby
   wywoływalne przez **każdego**, kto zna adres wdrożenia, bez naszego tokenu.
   `internalQuery` jest osiągalne tylko przez `ctx.runQuery` z wnętrza wdrożenia,
   czyli wyłącznie przez autoryzowane trasy HTTP z punktu 2.

1a. **Zastosuj jedną zmianę w pliku współdzielonym**

   Patrz `convex/lib/salesAvailability.export.md` — dodanie słowa `export` do
   `buildMaterialIndex`. Zmiana wyłącznie dodająca, bez zmiany zachowania.
   Uzasadnienie i odrzucona alternatywa są w tym pliku.

2. **Wklej trasy do `convex/http.ts`**

   Z pliku `convex/http.additions.ts` przenieś do `convex/http.ts`:

   - funkcję `authorizeAiOperator`,
   - stałą `AI_OPERATOR_CONTRACT_VERSION` i funkcje `aiOperatorOk`, `intParam`,
   - pięć bloków `http.route({...})`.

   Wszystko **przed** `export default http;`.

   `http.additions.ts` nie jest samodzielnym modułem — korzysta z `httpAction`,
   `internal`, `jsonResponse` i `constantTimeTextEqual`, które już są w `http.ts`.
   Po wklejeniu skasuj go; nie jest częścią aplikacji.

3. **Ustaw zmienną środowiskową Convex**

   ```
   AI_OPERATOR_API_TOKEN=<losowy, min. 32 znaki>
   ```

   Osobny token dla jednego konsumenta — tak samo, jak npd-studio ma własny.
   Dzięki temu odebranie agentowi dostępu to usunięcie **jednej** zmiennej,
   a nie rotacja tokenów wszystkich aplikacji.

4. **Sprawdź kontrakt z drugiej strony**

   ```bash
   cd ai-operator
   TEABREW_BASE_URL=<baza HTTP actions> \
   TEABREW_AI_OPERATOR_TOKEN=<ten sam token> \
   npm run verify:teabrew
   ```

   16 sprawdzeń w czterech grupach:

   - **bezpieczeństwo** — brak tokenu na każdej z pięciu tras, zły token, token
     w query stringu (musi być bezsilny), brak metod zapisu (POST/PUT/PATCH/DELETE),
     brak nieudokumentowanych tras `/ai-operator/*`;
   - **kontrakt** — kształt każdej odpowiedzi wobec schematu zod, walidacja
     parametrów;
   - **brak danych** — nieistniejące zamówienie, kod i produkt muszą wracać
     jawnie, nigdy jako zero ani pusty prawidłowy rekord;
   - **prawdziwe dane** — pozytywne trafienia na realnych rekordach. Wartości
     do testu są **odkrywane z systemu** (endpoint produkcji zwraca prawdziwe
     numery zamówień i kody SKU), więc nie musisz niczego podawać. Nadpisanie:
     `-- --order <numer> --product <fraza>`.

   Grupa „bezpieczeństwo" jest tu ważniejsza od pozytywnych: wyłapuje endpoint,
   który zwraca dane bez autoryzacji, i potwierdza, że agent nie dostał niczego
   poza pięcioma trasami.

## Decyzje projektowe warte utrzymania

**Stan magazynowy liczy wspólny helper.** `stockByCodes` woła
`salesAvailabilityByCode` z `convex/lib/salesAvailability` — ten sam, którego
używa portal B2B i push do sklepu. Osobna arytmetyka dla AI oznaczałaby, że
agent podaje inne liczby niż portal, i że któraś z nich jest nieprawdziwa.

**Brak danych jest zwracany jawnie.** Nieznany numer zamówienia to
`matchedBy: "none"` i HTTP 200, nie 404 i nie pusty rekord. Nieznany kod
produktu wraca w `unknownCodes`, nie jako stan zero. Agent ma umieć powiedzieć
„nie znalazłem” i nie może mieć jak pomylić tego z „nie ma”.

**Numer zamówienia jest wieloznaczny i endpoint to przyznaje.** W TeaBrew nie
ma jednego „numeru zamówienia”: klient może podać `externalOrderId`,
`nexoZkNumber` albo numer zlecenia produkcyjnego. Endpoint próbuje po kolei
i **mówi w odpowiedzi, po którym polu dopasował**.

**Wynik przycięty limitem jest oznaczony.** Pole `truncated` istnieje, żeby
„nic więcej nie ma” nie było nieprawdą.

## Jak to odkręcić

Usuń `AI_OPERATOR_API_TOKEN` ze zmiennych Convex. Trasy zaczną zwracać 500
i agent straci dostęp natychmiast, bez wdrożenia. Pełne wycofanie to skasowanie
`convex/queries/aiOperator.ts` i pięciu bloków `http.route` — nic innego w
TeaBrew z nich nie korzysta.
