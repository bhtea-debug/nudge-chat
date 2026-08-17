# Connecteam jako źródło spraw — co sprawdziłem i co z tego wynika

**17.08.2026.** Dokument powstał PRZED napisaniem integracji, zgodnie z wymaganiem
„nie zakładaj możliwości API, sprawdź aktualną oficjalną dokumentację".

---

## 1. Wynik w jednym zdaniu

**Publiczna dokumentacja Connecteam opisuje w sekcji Chat WYSYŁANIE wiadomości
i listę konwersacji. Nie opisuje odczytu treści wiadomości ani webhooka na nową
wiadomość.** To odwraca założenie z zadania (`chat.read`, Chat Webhooks Beta,
`message_created`) i dlatego jest tu opisane osobno, zamiast po cichu wpisane
w kod.

Zastrzeżenie, które muszę postawić z góry: **to jest ustalenie z dokumentacji, nie
z konta firmy.** Bety bywają włączane per firma i nie muszą być publicznie
udokumentowane. Rozstrzyga dopiero konto właściciela — do tego jest
`npm run check:connecteam`.

---

## 2. Co dokładnie sprawdziłem

Pięć niezależnych zapytań do wyszukiwarki po indeksie dokumentacji dostawcy
i po jego changelogu. **Domeny `developer.connecteam.com` nie mogłem otworzyć
bezpośrednio — polityka egress tej sesji ją blokuje** (`EGRESS_BLOCKED`), a README
proxy zabrania obchodzenia takich blokad. Pracowałem więc na tytułach stron,
identyfikatorach operacji w adresach referencji i wpisach changelogu, które
wyszukiwarka zwróciła.

### Potwierdzone fakty

| Fakt | Skąd |
| --- | --- |
| Baza API: `https://api.connecteam.com` | dokumentacja „Authentication" |
| Uwierzytelnienie: nagłówek `X-API-KEY` | tamże |
| Pierwsze wywołanie kontrolne: `GET /me` | „Getting started" |
| Klucz z panelu: Settings → API Keys → Add API key | „API access" |
| **Wymagany plan Expert lub wyższy** | „API access" |
| Chat: metoda wysyłania wiadomości do czatu/kanału | changelog „Send message in team/channel API release" |
| Chat: `POST /chat/v1/conversations/privatemessage/{userId}` — wysyłanie DM z załącznikami | referencja `send_message_to_private_conversation_…` |
| Chat: „Get conversations" zwraca **informacje o czatach**, dodana **żeby wspierać metodę wysyłania** | changelog |
| Webhooki: `POST/GET /settings/v1/webhooks` — zarządzanie webhookami | referencje `create_webhook_settings_…`, `get_webhook_settings_…` |
| Udokumentowane rodziny zdarzeń webhooków: **scheduler, tasks, users** | strony „Scheduler webhook", „Tasks webhook", changelog „Users webhooks" |
| Zdarzenia users: created, updated, deleted, archived, restored, promoted, demoted | changelog |
| Kształt ładunku webhooka: `eventType`, `eventTimestamp`, `company`, `data` | dokumentacja webhooków |

### Czego NIE znalazłem

- endpointu zwracającego **treść wiadomości** z konwersacji,
- strony dokumentacji **webhooka czatu**,
- zdarzenia **`message_created`**,
- zakresu uprawnień **`chat.read`**.

Brak w indeksie nie jest dowodem nieistnienia. Jest natomiast dostatecznym
powodem, żeby **nie budować produktu na założeniu, że to istnieje**.

---

## 3. Czego z tej strony rozstrzygnąć NIE MOGĘ

Osiem pytań z zadania rozdziela się na dwie grupy. To rozdzielenie jest ważniejsze
niż same odpowiedzi, bo pokazuje, gdzie kończy się moja robota.

| Pytanie | Kto odpowiada |
| --- | --- |
| Czy konto ma dostęp do API | **konto** — `npm run check:connecteam` |
| Jaki plan Communications Hub jest aktywny | **panel Connecteam** — widzi to tylko właściciel |
| Czy istnieje klucz API | **panel** — Settings → API Keys |
| Czy dostępny jest `chat.read` | **konto** — sonda pokazuje, co realnie odpowiada |
| Czy Chat Webhooks Beta są włączone dla tej firmy | **Connecteam** — trzeba zapytać wsparcie |
| Jakie konwersacje możemy odczytać | **konto** — sonda liczy je i mówi wprost |
| Czy webhook `message_created` jest dostępny | **konto/Connecteam** |
| Jaki payload faktycznie dostajemy | **pierwszy prawdziwy webhook**, nie dokumentacja |

`npm run check:connecteam` odpowiada na te, na które da się odpowiedzieć
programowo, i **nazywa te, na które nie da się** — zamiast zostawiać puste pole,
które wygląda jak „nie".

Narzędzie **niczego nie zapisuje** w Connecteam: nie tworzy webhooka, nie wysyła
wiadomości, nie zmienia ustawień. Świadomie nie próbuję nawet utworzyć webhooka
z typem czatowym, choć to najpewniejszy sposób poznania listy dopuszczalnych
typów — bo tworzyłoby to konfigurację w koncie właściciela bez jego zgody.

---

## 4. Decyzja: jak to zbudowałem

**Connecteam jest źródłem pierwszej klasy w kodzie i „niepodłączonym" w praktyce,
dopóki konto nie powie inaczej.** Konkretnie:

1. **Schemat spraw zna Connecteam.** `SourceRef` jest sumą rozłączną `mail |
   connecteam`, więc jedna sprawa może mieć oba źródła — i to jest przetestowane
   na przykładzie z §14 (klient mailem, produkcja na czacie, stan z TeaBrew).
2. **Wejście jest webhookiem**, nie odpytywaniem (§11): `POST /webhook/connecteam`,
   idempotentne po `ct:<konwersacja>:<wiadomość>`, z weryfikacją podpisu HMAC-SHA256,
   gdy `CONNECTEAM_WEBHOOK_SECRET` jest ustawiony. Bez sekretu endpoint przyjmuje,
   ale **za każdym razem** krzyczy o tym na stderr — inaczej „tymczasowo bez
   podpisu" zostaje na zawsze.
3. **Odpytywanie jest gotowe, ale nie włączone.** `ConnecteamClient.messagesSince`
   istnieje i zwraca `null`, gdy odczyt jest niedostępny. `null` NIE znaczy „brak
   nowych" i wywołujący musi te dwie rzeczy rozróżnić — gdyby je zlał, produkt
   raportowałby „nikt nic nie napisał" w sytuacji „nie mam jak zobaczyć".
4. **UI mówi prawdę o zakresie.** Stopka wypisuje źródła policzone z DANYCH, nie
   z konfiguracji. Pierwsza wersja brała to z obecności klucza API i kłamała
   w obie strony: pisała „Connecteam" przy kluczu bez ani jednej wiadomości
   i milczała o Connecteam, gdy wiadomości wpadały webhookiem bez klucza.

Czego **nie** zrobiłem i bez osobnej zgody nie zrobię (§12): scrapingu,
automatyzacji przeglądarki, odtwarzania prywatnego API. Powód nie jest
formalny — taka integracja psuje się przy każdej zmianie u dostawcy, i psuje się
w sposób **nieodróżnialny od „nikt nic nie napisał"**. To najgroźniejszy tryb
awarii, jaki ten produkt może mieć.

---

## 5. Ograniczenie, o którym trzeba wiedzieć niezależnie od Bety

Nawet przy działającym odczycie **rozmowy prywatne normalnie nie pojawiają się na
liście konwersacji** — oficjalne API operuje na czatach zespołowych i kanałach.
Jeśli spora część ustaleń w firmie idzie prywatnymi wiadomościami, Copilot ich
nie zobaczy i **nie wolno pisać, że „czytamy Connecteam"**.

Zakres do wpisania po uruchomieniu sondy na prawdziwym koncie:

```
Czaty zespołowe i kanały:  … (liczba z sondy)
Rozmowy prywatne:          NIE
Treść wiadomości:          … (tak/nie z sondy)
Webhook nowej wiadomości:  … (tak/nie z sondy)
```

Dopóki te pola są puste, w dokumentacji i w UI obowiązuje sformułowanie
„Connecteam: niepodłączony".

---

## 6. Jedna czynność dla właściciela

W panelu Connecteam: **Settings → API Keys → Add API key.** Potem wklej klucz do
`.env` na serwerze — **nie w rozmowie i nie do kodu**:

```
CONNECTEAM_API_KEY=…
```

i uruchom `npm run check:connecteam`. Wynik tej jednej komendy rozstrzyga
wszystko powyżej.

Jeśli sonda powie, że nie ma ani odczytu, ani webhooka czatu — jedyna znana mi
droga prowadzi przez pytanie do wsparcia Connecteam, czy dla tej firmy da się
włączyć webhooki czatu.
