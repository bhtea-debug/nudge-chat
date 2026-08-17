import type { MailMessage } from "../mail/types.js";

/**
 * Filtr przed modelem — deterministyczny, bez AI.
 *
 * Sens jest kosztowy i jakościowy naraz: newsletter przepuszczony do modelu to
 * zapłacone tokeny za odpowiedź „to newsletter", a przy kilkunastu takich na
 * dzień to jedyny realny sposób na zmniejszenie rachunku bez utraty czegokolwiek.
 *
 * Reguła nadrzędna, której ten plik ma być posłuszny: **odrzucenie prawdziwej
 * wiadomości od klienta jest znacznie gorsze niż zapłacenie za sklasyfikowanie
 * newslettera.** Dlatego filtr działa TYLKO na sygnałach z nagłówków RFC oraz
 * na wąskiej liście adresów technicznych — nigdy na tym, że temat brzmi
 * marketingowo.
 *
 * Świadomie NIE odrzucamy po samym `noreply@`: potwierdzenia zamówień, awizo
 * kurierskie i powiadomienia z systemów klientów przychodzą właśnie z takich
 * adresów i mają znaczenie operacyjne.
 */

export interface NoiseVerdict {
  readonly noise: boolean;
  /** Powód — trafia do logu przebiegu, żeby dało się sprawdzić, co odsialiśmy. */
  readonly why: string;
}

const KEEP = { noise: false, why: "" } as const;

/**
 * Adresy czysto techniczne: odbicia i raporty dostarczenia. Nie ma tam treści
 * operacyjnej, a jest sporo ruchu.
 */
const TECHNICAL_LOCAL_PARTS = [
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
  "complaints",
  "abuse",
];

export function classifyNoise(msg: MailMessage): NoiseVerdict {
  const address = (msg.from?.address ?? "").toLowerCase();
  const localPart = address.split("@")[0] ?? "";

  // 1. Nagłówki RFC. Najmocniejszy i najtańszy sygnał, bo wstawia go system
  //    wysyłający, a nie my na podstawie wyglądu.
  if (msg.bulk) {
    return { noise: true, why: "nagłówek masowy/automatyczny (List-Unsubscribe / Precedence / Auto-Submitted)" };
  }

  // 2. Odbicia i raporty techniczne.
  if (TECHNICAL_LOCAL_PARTS.includes(localPart)) {
    return { noise: true, why: `adres techniczny (${localPart})` };
  }

  // 3. Brak nadawcy i brak tematu naraz. Pojedynczo każde bywa u prawdziwych
  //    wiadomości; razem to prawie zawsze artefakt.
  if (!msg.from && msg.subject === "(brak tematu)") {
    return { noise: true, why: "brak nadawcy i brak tematu" };
  }

  return KEEP;
}

/**
 * Podział paczki na to, co idzie do modelu, i to, co odrzucamy — z powodami.
 * Zwracamy oba, bo liczba odsianych wiadomości jest częścią rachunku kosztów,
 * a nie szczegółem implementacyjnym.
 */
export function splitNoise(messages: readonly MailMessage[]): {
  keep: MailMessage[];
  dropped: { message: MailMessage; why: string }[];
} {
  const keep: MailMessage[] = [];
  const dropped: { message: MailMessage; why: string }[] = [];
  for (const m of messages) {
    const v = classifyNoise(m);
    if (v.noise) dropped.push({ message: m, why: v.why });
    else keep.push(m);
  }
  return { keep, dropped };
}
