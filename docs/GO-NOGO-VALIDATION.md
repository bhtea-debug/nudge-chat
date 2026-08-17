# BHT Copilot — GO / NO-GO VALIDATION

**17–18.08.2026.** Trzy testy na prawdziwym środowisku, w kolejności narzuconej
przez zadanie. Bez fixture'ów, bez emulatorów, bez „dokumentacja mówi, że powinno".

---

## FINAL VERDICT

| Obszar | Wynik | Jednozdaniowe uzasadnienie |
| --- | --- | --- |
| **Connecteam** | **FAIL** | Klucz działa i konto widzi 10 konwersacji, ale żadna ścieżka odczytu treści nie odpowiada (404/405) i nie ma webhooka na nową wiadomość — API tej firmy nie udostępnia dziś wiadomości, których potrzebujemy. |
| **Push iPhone** | _w toku_ | — |
| **Quality** | _w toku_ | — |

**Decyzja architektoniczna:** _do uzupełnienia po trzech testach._

---

## Connecteam — FAIL

### Co faktycznie pobraliśmy

Sonda `npm run check:connecteam` uruchomiona na koncie **Brown House & Tea**
kluczem wygenerowanym przez właściciela w panelu (Settings → API Keys):

| Sprawdzenie | Wynik |
| --- | --- |
| Klucz API działa | **✓** — konto rozpoznane po nazwie |
| Lista czatów zespołowych i kanałów | **✓** — 10 konwersacji |
| **Odczyt treści wiadomości** | **✗** — trzy ścieżki, trzy odmowy |
| API webhooków | **✓** — odpowiada |
| Webhook na nową wiadomość czatu | **✗** |

Ścieżki odczytu i odpowiedzi, dosłownie:

```
/chat/v1/conversations/{c}/messages   → 404
/chat/v1/conversations/{c}            → 405
/chat/v1/messages?conversationId={c}  → 404
```

Wymagane minimum z zadania — źródło, autor, timestamp, treść lub preview,
stabilny identyfikator — **nie zostało spełnione w żadnym punkcie poza źródłem.**
Znamy nazwy konwersacji i nic więcej.

### Dlaczego FAIL, a nie BLOCKED

Test **został wykonany**, na prawdziwym koncie, kluczem o wystarczających
uprawnieniach (klucz w ogóle dał się utworzyć, co znaczy plan Expert lub wyższy).
Odpowiedź jest jednoznaczna i zgodna z tym, co ustaliliśmy z dokumentacji
**przed** napisaniem kodu (`docs/DECYZJA-CONNECTEAM.md`): sekcja Chat opisuje
**wysyłanie** wiadomości i listę konwersacji — ta ostatnia dodana, jak mówi
changelog dostawcy, **żeby wspierać wysyłanie**. Odczytu nie opisuje.

To jest dokładnie kryterium FAIL z zadania: „API rzeczywiście nie udostępnia
potrzebnych wiadomości".

### Jedna droga niewyczerpana — i wymaga dostawcy, nie nas

Konto ma API webhooków, ale **nie ma skonfigurowanego ani jednego webhooka**,
więc lista dopuszczalnych typów zdarzeń jest pusta. Jedynym sposobem jej poznania
byłaby próba utworzenia webhooka z typem czatowym — **czego nie zrobiłem**, bo
tworzy to konfigurację w koncie właściciela bez jego zgody.

Gdyby Connecteam włączył dla tej firmy webhooki czatu (bety bywają włączane per
firma i nie muszą być publicznie udokumentowane), wejście po naszej stronie
**jest gotowe**: `POST /webhook/connecteam`, idempotentne po
`ct:<konwersacja>:<wiadomość>`, z weryfikacją podpisu HMAC-SHA256. Nie trzeba by
niczego budować — tylko podać adres.

**To jest jedyna znana droga.** Scrapingu ani odtwarzania prywatnego API nie
zrobię bez wyraźnej zgody: taka integracja psuje się przy każdej zmianie
u dostawcy i psuje się w sposób **nieodróżnialny od „nikt nic nie napisał"**,
czyli najgorszy możliwy w produkcie, który ma pilnować spraw.

### Co to znaczy dla produktu

Connecteam zostaje w schemacie jako źródło pierwszej klasy (`SourceRef` jest sumą
rozłączną `mail | connecteam`), ale **nie zasila spraw treścią** i produkt musi to
mówić wprost. Pusta sekcja czatu nie może wyglądać jak „nic nie napisano".

---

## Push iPhone — _w toku_

---

## Quality — _w toku_
