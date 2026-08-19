# BHT — BUSINESS POLICY REGRESSION

Wygenerowano: **2026-08-18T20:22:52.148Z**
Prompt: **classifier-v1**
Tryb: **regresja po analizie błędów**, nie niezależny benchmark. Polityka: **rossmann-new-order-always-a-v1**.
Zakres: wyłącznie rola **classify**, zamrożone 50 wiadomości, Claude API (Anthropic).

## FINAL VERDICT

# CONDITIONAL GO

Pojedynczy przebieg wykrył wszystkie alarmy przy akceptowalnej liczbie false positives, ale stabilność tego modelu nie została zmierzona. Potrzebne są powtórzenia przed automatycznymi alertami.

**Zwycięzca classify: Claude Sonnet 5 (claude-sonnet-5).**

| Model | Recall A | Precision A | FN | FP | Stabilność | 100 msg | 100 msg/dzień/mies. | Werdykt |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Claude Haiku 4.5 | 50.0% | 40.0% | 2 | 3 | 7/50 zmieniło klasę; A pominięte w ≥1 przebiegu: 2; max FP: 3 | $0.1009 | $3.0257 | NO-GO |
| Claude Sonnet 5 | 100.0% | 50.0% | 0 | 4 | 1 przebieg (nie mierzono) | $0.2501 | $7.5031 | CONDITIONAL GO |
| Claude Opus 5 | 75.0% | 60.0% | 1 | 2 | 1 przebieg (nie mierzono) | $0.6331 | $18.9918 | CONDITIONAL GO |

## Baseline

Obecny system deterministyczny: **TP A=0, FN A=4, FP A=3, recall A=0%, precision A=0%, accuracy 3-klasowa=68%**.

Niezależny benchmark v1: **NO-GO**. Sonnet 5: TP A=2, FN A=2, FP A=2, recall A=50%, precision A=50%.

## Jawna polityka biznesowa

- każde znormalizowane nowe zamówienie Rossmann → **A**,
- decyzja właściciela: **rossmann-new-order-always-a-v1**,
- polityka rozstrzygnęła **2/50** wiadomości przed modelem w każdym przebiegu,
- dopasowanie wymaga kanonicznego customerId, eventType i numeru zamówienia; samo słowo „Rossmann” nie wystarcza,
- produkcyjny monitor nie został zmieniony ani przełączony.

## Dataset

- zamrożone rekordy: **50**; bez pobierania nowych maili,
- gold labels właściciela: **A=4, B=18, C=28**,
- SHA-256 zbior.json: `3c4cc5cd65f939cde7b1ec86157ddcde8132af43026713a0723bb3ad599b960a`,
- SHA-256 etykiety.json: `0e2411a61b3115c18fc34f015899fd16dc8b084a6169bf2460b7034aa095aa19`,
- skrypt odmawia startu, jeśli którykolwiek hash różni się od zatwierdzonego, zamrożonego pliku,
- model otrzymał wyłącznie 48 wiadomości nierozstrzygniętych przez politykę: nadawcę, temat, podgląd i datę,
- gold labels i pola starego systemu nie były dołączane do żądań API,
- raport nie zawiera surowych tematów, nadawców, podglądów ani uzasadnień modelu; błędy mają tylko anonimowe ID.

## Modele i ceny

Cennik sprawdzony **2026-08-18** w oficjalnej dokumentacji Anthropic. Dostępność każdego ID została potwierdzona przez Models API bez wysyłania treści wiadomości.

| Model | Rola w benchmarku | ID Claude API | Input / MTok | Output / MTok | Cache read / MTok |
| --- | --- | --- | ---: | ---: | ---: |
| Claude Haiku 4.5 | tani | `claude-haiku-4-5-20251001` | $1.00 | $5.00 | $0.10 |
| Claude Sonnet 5 | średni | `claude-sonnet-5` | $2.00 | $10.00 | $0.20 |
| Claude Opus 5 | referencyjny | `claude-opus-5` | $5.00 | $25.00 | $0.50 |

Źródła: [modele](https://platform.claude.com/docs/en/about-claude/models/overview), [cennik](https://platform.claude.com/docs/en/about-claude/pricing), [Models API](https://platform.claude.com/docs/en/api/models/list), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Uwaga: dla Claude Sonnet 5 oficjalna cena promocyjna $2/$10 za MTok obowiązuje do 31.08.2026; od 01.09.2026 skrypt liczy $3/$15.

## Prompt classifier-v1

```text
Jesteś klasyfikatorem nowej wiadomości firmowej dla właściciela firmy.

Przypisz dokładnie jedną klasę:
A — ALARM NATYCHMIAST: wiadomość ma przerwać właścicielowi obecną pracę. To realny problem wymagający szybkiej reakcji, istotne ryzyko dla klienta, produkcji albo sprzedaży, termin wymagający działania teraz, ważna eskalacja lub bezpośrednia pilna prośba o decyzję.
B — PODSUMOWANIE: właściciel powinien o tym wiedzieć, ale wiadomość nie powinna przerywać mu bieżącej pracy.
C — NIEISTOTNE: wiadomość nie powinna trafić ani do alarmu, ani do istotnego podsumowania.

Najważniejsza zasada: klasy A używaj oszczędnie, ale nie przeocz prawdziwego alarmu. Oceniaj wyłącznie przekazane pola wiadomości. Nie korzystaj z zewnętrznej wiedzy i nie dopowiadaj brakujących faktów. Confidence ma oznaczać pewność przypisania tej klasy. Reason ma być jednym krótkim zdaniem po polsku, bez toku rozumowania.
```

Każdy model dostał identyczny prompt i ten sam JSON Schema. Parametry próbkowania pozostawiono domyślne, ponieważ Sonnet 5 i Opus 5 odrzucają wartości inne niż domyślne; ich adaptacyjne myślenie wyłączono dla krótkiej klasyfikacji.

## Wyniki

### Claude Haiku 4.5

TP A: **2** · FN A: **2** · FP A: **3** · recall A: **50.0%** · precision A: **40.0%** · F1 A: **44.4%** · accuracy: **62.0%**

| Gold \ Predykcja | A | B | C |
| --- | ---: | ---: | ---: |
| A | 2 | 2 | 0 |
| B | 3 | 7 | 8 |
| C | 0 | 6 | 22 |

#### False negatives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| fbb1acf87c69 | A | B | 0.75 |
| 7ffa33a20d88 | A | B | 0.85 |

#### False positives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| 1cdf3a140f42 | B | A | 0.92 |
| 664161bc052b | B | A | 0.85 |
| 807209e0ff74 | B | A | 0.92 |

### Claude Sonnet 5

TP A: **4** · FN A: **0** · FP A: **4** · recall A: **100.0%** · precision A: **50.0%** · F1 A: **66.7%** · accuracy: **72.0%**

| Gold \ Predykcja | A | B | C |
| --- | ---: | ---: | ---: |
| A | 4 | 0 | 0 |
| B | 3 | 6 | 9 |
| C | 1 | 1 | 26 |

#### False negatives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| — | — | Brak | — |

#### False positives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| 1cdf3a140f42 | B | A | 0.90 |
| 0217a0b1ebea | C | A | 0.72 |
| 664161bc052b | B | A | 0.75 |
| e42623f6242b | B | A | 0.85 |

### Claude Opus 5

TP A: **3** · FN A: **1** · FP A: **2** · recall A: **75.0%** · precision A: **60.0%** · F1 A: **66.7%** · accuracy: **76.0%**

| Gold \ Predykcja | A | B | C |
| --- | ---: | ---: | ---: |
| A | 3 | 1 | 0 |
| B | 2 | 10 | 6 |
| C | 0 | 3 | 25 |

#### False negatives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| 7ffa33a20d88 | A | B | 0.72 |

#### False positives A

| Anonimowy ID | Gold | Predykcja | Confidence |
| --- | --- | --- | ---: |
| 1cdf3a140f42 | B | A | 0.75 |
| 807209e0ff74 | B | A | 0.72 |

## Stabilność taniego kandydata

Model: **Claude Haiku 4.5**. Trzy pełne przebiegi po 50 wiadomości.

- wiadomości, które zmieniły klasę między przebiegami: **7/50**,
- zmienione przypisania względem pierwszego przebiegu: **9/100**,
- gold A pominięte co najmniej raz: **2/4**,
- najgorszy recall A w trzech przebiegach: **50.0%**,
- najgorsza precision A w trzech przebiegach: **40.0%**,
- największa liczba false positives w przebiegu: **3**,
- średni rozrzut confidence: **0.019**,
- maksymalny rozrzut confidence: **0.100**.

## Koszt classify — realne tokeny API

| Model / przebieg | Input | Cache write | Cache read | Output | Koszt przebiegu | Średnio / msg | 100 msg | 100 msg/dzień × 30 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Haiku 4.5 #1 | 35529 | 0 | 0 | 2980 | $0.050429 | $0.001009 | $0.1009 | $3.0257 |
| Claude Sonnet 5 #1 | 46196 | 0 | 0 | 3266 | $0.125052 | $0.002501 | $0.2501 | $7.5031 |
| Claude Opus 5 #1 | 46196 | 0 | 0 | 3422 | $0.316530 | $0.006331 | $0.6331 | $18.9918 |
| Claude Haiku 4.5 #2 | 35529 | 0 | 0 | 2936 | $0.050209 | $0.001004 | $0.1004 | $3.0125 |
| Claude Haiku 4.5 #3 | 35529 | 0 | 0 | 2910 | $0.050079 | $0.001002 | $0.1002 | $3.0047 |

**Cały benchmark, wraz z dwoma dodatkowymi przebiegami stabilności: $0.592299.**

Koszt docelowy oznacza: jedna nowa wiadomość → jedna klasyfikacja. Nie obejmuje ponownego skanowania skrzynki ani TeaBrew.

## Rekomendacja

**CONDITIONAL GO: Claude Sonnet 5** jest najlepszym kandydatem według kolejności: werdykt, najgorszy zmierzony recall A, precision A, F1 A, a następnie koszt.

Pojedynczy przebieg wykrył wszystkie alarmy przy akceptowalnej liczbie false positives, ale stabilność tego modelu nie została zmierzona. Potrzebne są powtórzenia przed automatycznymi alertami.

Progi: GO wymaga TP A=4, FP A≤4 oraz trzech stabilnych przebiegów bez pominięcia A i bez przekroczenia FP. CONDITIONAL GO wymaga TP A≥3 i FP A≤8; model bez testu stabilności nie może otrzymać GO.

Ponieważ politykę ustalono po obejrzeniu false negatives, ten raport może dać najwyżej CONDITIONAL GO. Następna bramka to świeży, prospektywny holdout.

Benchmark nie przełączył produkcyjnego classifiera, nie wysłał pushy i nie zmienił BHT Copilot, TeaBrew, Railway ani Czat Firmowy.
