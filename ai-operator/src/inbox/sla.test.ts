import { describe, expect, it } from "vitest";
import { businessElapsedMs, evaluateSla } from "./sla.js";

/**
 * Zegar odpowiedzi.
 *
 * Progi są te same, co w pilocie Allegro. Jedna kolejka z dwiema definicjami
 * „pilne" byłaby gorsza od braku priorytetu: zespół nie wiedziałby, którą
 * wersję właśnie czyta.
 */

const HOUR = 60 * 60_000;
// Środa, 20 sierpnia 2026, 09:00 czasu warszawskiego.
const WEDNESDAY = Date.parse("2026-08-19T07:00:00Z");
// Piątek, 21 sierpnia 2026, 16:00 czasu warszawskiego.
const FRIDAY_AFTERNOON = Date.parse("2026-08-21T14:00:00Z");

describe("czas roboczy", () => {
  it("weekend nie liczy sie do zegara odpowiedzi", () => {
    // Od piątku 16:00 do poniedziałku 16:00 mijają trzy doby zegarowe,
    // ale tylko 24 godziny robocze.
    const monday = FRIDAY_AFTERNOON + 3 * 24 * HOUR;
    const worked = businessElapsedMs(FRIDAY_AFTERNOON, monday);
    expect(Math.round(worked / HOUR)).toBe(24);
  });

  it("dzien roboczy liczy sie normalnie", () => {
    expect(Math.round(businessElapsedMs(WEDNESDAY, WEDNESDAY + 5 * HOUR) / HOUR)).toBe(5);
  });

  it("czas wstecz nie jest ujemny", () => {
    expect(businessElapsedMs(WEDNESDAY + HOUR, WEDNESDAY)).toBe(0);
  });
});

describe("stan zegara i priorytet", () => {
  const base = { requiresResponse: true, pendingAction: false } as const;

  it("swieza sprawa jest spokojna", () => {
    const result = evaluateSla({ ...base, waitingSince: WEDNESDAY, now: WEDNESDAY + HOUR });
    expect(result.state).toBe("ok");
    expect(result.priority).toBe("P2");
  });

  it("po 12 h roboczych robi sie zolto", () => {
    const result = evaluateSla({ ...base, waitingSince: WEDNESDAY, now: WEDNESDAY + 13 * HOUR });
    expect(result.state).toBe("yellow");
    expect(result.priority).toBe("P1");
  });

  it("po 20 h roboczych robi sie czerwono i P0", () => {
    const result = evaluateSla({ ...base, waitingSince: WEDNESDAY, now: WEDNESDAY + 21 * HOUR });
    expect(result.state).toBe("red");
    expect(result.priority).toBe("P0");
  });

  it("na dwie godziny przed terminem jest krytycznie", () => {
    const result = evaluateSla({ ...base, waitingSince: WEDNESDAY, now: WEDNESDAY + 23 * HOUR });
    expect(result.state).toBe("critical");
    expect(result.priority).toBe("P0");
  });

  it("po terminie jest przekroczenie", () => {
    const result = evaluateSla({ ...base, waitingSince: WEDNESDAY, now: WEDNESDAY + 30 * HOUR });
    expect(result.state).toBe("overdue");
    expect(result.priority).toBe("P0");
  });

  it("sprawa z piatku po poludniu NIE jest przeterminowana w niedziele", () => {
    const sundayMorning = FRIDAY_AFTERNOON + 2 * 24 * HOUR - 6 * HOUR;
    const result = evaluateSla({ ...base, waitingSince: FRIDAY_AFTERNOON, now: sundayMorning });
    // Nikt wtedy nie pracuje; czerwony alarm w poniedziałek uczy zespół
    // ignorować kolor.
    expect(result.state).toBe("ok");
  });

  it("sprawa bez wymaganej odpowiedzi nie ma zegara", () => {
    const result = evaluateSla({
      waitingSince: WEDNESDAY,
      requiresResponse: false,
      pendingAction: false,
      now: WEDNESDAY + 40 * HOUR,
    });
    expect(result.state).toBeNull();
    expect(result.responseDueAt).toBeNull();
  });

  it("czekanie na realizacje nie zapala alarmu odpowiedzi", () => {
    const result = evaluateSla({
      waitingSince: WEDNESDAY,
      requiresResponse: false,
      pendingAction: true,
      now: WEDNESDAY + 40 * HOUR,
    });
    expect(result.state).toBeNull();
    // Sprawa zostaje widoczna, ale nie jako pilna: paczka jedzie.
    expect(result.priority).toBe("P2");
  });

  it("sprawa do weryfikacji nie dostaje P0 na zapas", () => {
    const result = evaluateSla({
      ...base,
      waitingSince: WEDNESDAY,
      now: WEDNESDAY + 30 * HOUR,
      needsReview: true,
    });
    expect(result.state).toBe("overdue");
    // Niepewna klasyfikacja nie ma prawa krzyczeć najgłośniej w kolejce.
    expect(result.priority).toBe("P1");
  });

  it("twarde maksimum liczy sie czasem ciaglym, bez pauzy weekendowej", () => {
    const result = evaluateSla({ ...base, waitingSince: FRIDAY_AFTERNOON, now: FRIDAY_AFTERNOON + HOUR });
    expect(result.serviceMaxAt).toBe(FRIDAY_AFTERNOON + 12 * HOUR);
  });
});
