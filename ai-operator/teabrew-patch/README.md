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

## Jak założyć

Repozytorium `teabrew-v2` ma własny kontrakt pracy w `AGENTS.md`. Przeczytaj go
przed zmianą i wykonaj wymagane tam kroki (`git remote -v`, `git fetch origin main`,
świeży worktree z `origin/main`). **Nie uruchamiaj `convex deploy`, `convex dev`
ani `convex codegen`, dopóki środowisko wskazuje na wdrożenie live** — wdrożenie
idzie wyłącznie przez opisane tam guardy.

1. **Skopiuj plik z zapytaniami**

   ```
   convex/queries/aiOperator.ts
   ```

   Zawiera cztery `internalQuery`: `orderByRef`, `stockByCodes`, `findProduct`,
   `productionStatus`. Żadnej mutacji.

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

   9 sprawdzeń: kształt każdej odpowiedzi plus przypadki negatywne — brak
   tokenu, zły token, brak wymaganego parametru, nieistniejący numer,
   nieistniejący kod, zły profil. Negatywne są tu ważniejsze od pozytywnych:
   wyłapują endpoint, który zwraca dane bez autoryzacji.

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
