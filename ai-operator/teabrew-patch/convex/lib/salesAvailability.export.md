# Jedna zmiana w `convex/lib/salesAvailability.ts`

Do zastosowania razem z resztą łatki.

## Co zmienić

W `convex/lib/salesAvailability.ts` (obecnie linia 90) dodaj słowo `export`:

```diff
-function buildMaterialIndex(materials: any[]) {
+export function buildMaterialIndex(materials: any[]) {
```

Nic więcej. Ciało funkcji zostaje bez zmian.

## Dlaczego to jest konieczne

`stockByCodes` musi opisać ilość **tym samym materiałem**, dla którego ta ilość
została policzona. Dwa różne materiały mogą mieć ten sam `code`: herbata z
tagiem `sku` oraz akcesorium przeniesione z woocommerce. `buildMaterialIndex`
rozstrzyga to jednoznacznie — preferuje materiał z tagiem `sku`, a dopiero
potem bierze dowolny o tym kodzie.

Bez tego eksportu trzeba by tę regułę **przepisać** w `queries/aiOperator.ts`.
Wtedy `onHand` opisywałby jeden materiał, a `name`, `uom` i `minStock` w tej
samej pozycji — drugi. Agent podawałby liczbę o czymś innym, niż mówi nazwa
obok niej. Dokładnie ten rodzaj cichej rozbieżności stoi za incydentami
opisanymi w `docs/ARCHITEKTURA-AI-2026.md`.

## Dlaczego to jest bezpieczne

Dodanie `export` do funkcji prywatnej w module jest zmianą **wyłącznie
dodającą**:

- żadne istniejące wywołanie się nie zmienia — oba miejsca w tym pliku
  (`salesAvailability`, `salesAvailabilityByCode`) wołają ją dalej lokalnie,
- nie zmienia się ani sygnatura, ani ciało, ani zachowanie,
- nie powstaje nowa ścieżka zapisu — funkcja tylko buduje mapę w pamięci.

Alternatywą było przepisanie logiki u konsumenta. Odrzucona: duplikat reguły
domenowej rozjeżdża się w czasie, a rozjazd jest tu niewidoczny — liczba nadal
wygląda poprawnie.
