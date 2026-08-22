import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRESHNESS_POLICY, overallFreshness, type SourceHealth } from "./contract.js";
import {
  backoffDelay,
  channelFreshness,
  mayReportEmptyQueue,
  recordFailure,
  recordSuccess,
  sanitizeMessage,
} from "./health.js";
import { InboxStore } from "./store.js";

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

function freshStore(): InboxStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-health-"));
  dirs.push(dir);
  return new InboxStore({ dir });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const source = (partial: Partial<SourceHealth>): SourceHealth => ({
  provider: "email",
  accountKey: "sklep",
  label: "E-mail sklep",
  state: "ok",
  active: true,
  lastSuccessfulSyncAt: NOW - 60_000,
  lastAttemptAt: NOW - 60_000,
  nextAttemptAt: null,
  consecutiveFailures: 0,
  message: null,
  ...partial,
});

describe("swiezosc kanalu", () => {
  it("ogolny czas bierze NAJSTARSZY sukces aktywnego zrodla", () => {
    const result = overallFreshness(
      [
        source({ accountKey: "sklep", lastSuccessfulSyncAt: NOW - 30_000 }),
        source({ accountKey: "biuro", lastSuccessfulSyncAt: NOW - 9 * 60_000 }),
        source({ accountKey: "hurt", lastSuccessfulSyncAt: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(result.oldestSuccessAt).toBe(NOW - 9 * 60_000);
    expect(result.ageMs).toBe(9 * 60_000);
    expect(result.state).toBe("yellow");
  });

  it("jedno martwe zrodlo nie daje zielonego statusu", () => {
    const result = overallFreshness(
      [
        source({ accountKey: "sklep", lastSuccessfulSyncAt: NOW - 10_000 }),
        source({
          provider: "instagram",
          accountKey: "ig-1",
          state: "reconnect_required",
          lastSuccessfulSyncAt: NOW - 20_000,
        }),
      ],
      NOW,
    );
    expect(result.state).toBe("red");
    expect(result.degradedSources).toContain("instagram:ig-1");
  });

  it("zrodlo bez ani jednego sukcesu jest czerwone", () => {
    const result = overallFreshness([source({ lastSuccessfulSyncAt: null })], NOW);
    expect(result.state).toBe("red");
    expect(result.oldestSuccessAt).toBeNull();
  });

  it("nieaktywne zrodlo nie psuje ogolnego stanu", () => {
    const result = overallFreshness(
      [
        source({ lastSuccessfulSyncAt: NOW - 10_000 }),
        source({ provider: "facebook", accountKey: "fb-1", active: false, lastSuccessfulSyncAt: null }),
      ],
      NOW,
    );
    expect(result.state).toBe("green");
  });

  it("stale przelacza sie z uplywem czasu bez kolejnego zapisu serwera", () => {
    const sources = [source({ lastSuccessfulSyncAt: NOW })];
    expect(overallFreshness(sources, NOW + 60_000).state).toBe("green");
    expect(overallFreshness(sources, NOW + FRESHNESS_POLICY.okMs + 1).state).toBe("yellow");
    expect(overallFreshness(sources, NOW + FRESHNESS_POLICY.alarmMs + 1).state).toBe("red");
  });

  it("blad z pusta lista nie pozwala pokazac braku spraw", () => {
    const store = freshStore();
    recordSuccess(store, { key: { provider: "email", accountKey: "sklep" }, label: "sklep", active: true }, NOW);
    recordFailure(
      store,
      { key: { provider: "email", accountKey: "biuro" }, label: "biuro", active: true },
      "error",
      "polaczenie odrzucone",
      NOW,
    );

    const freshness = channelFreshness(store, NOW);
    expect(freshness.state).toBe("red");
    expect(mayReportEmptyQueue(freshness)).toBe(false);
  });

  it("po odzyskaniu zrodla stan wraca do zielonego i licznik bledow zeruje sie", () => {
    const store = freshStore();
    const key = { provider: "email", accountKey: "hurt" };
    recordFailure(store, { key, label: "hurt", active: true }, "error", "timeout", NOW);
    recordFailure(store, { key, label: "hurt", active: true }, "error", "timeout", NOW + 1_000);
    expect(store.getHealth(key)?.consecutiveFailures).toBe(2);
    expect(store.getHealth(key)?.state).toBe("backoff");

    recordSuccess(store, { key, label: "hurt", active: true }, NOW + 5_000);
    const health = store.getHealth(key)!;
    expect(health.state).toBe("ok");
    expect(health.consecutiveFailures).toBe(0);
    expect(mayReportEmptyQueue(channelFreshness(store, NOW + 5_000))).toBe(true);
  });

  it("awaria nie nadpisuje czasu ostatniego sukcesu", () => {
    const store = freshStore();
    const key = { provider: "email", accountKey: "sklep" };
    recordSuccess(store, { key, label: "sklep", active: true }, NOW);
    recordFailure(store, { key, label: "sklep", active: true }, "error", "zerwane polaczenie", NOW + 60_000);
    const health = store.getHealth(key)!;
    expect(health.lastSuccessfulSyncAt).toBe(NOW);
    expect(health.lastAttemptAt).toBe(NOW + 60_000);
  });

  it("backoff rosnie wykladniczo i ma sufit", () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(1)).toBe(60_000);
    expect(backoffDelay(2)).toBe(120_000);
    expect(backoffDelay(20)).toBe(15 * 60_000);
  });

  it("brak scope zostaje widoczny mimo kolejnych prob", () => {
    const store = freshStore();
    const key = { provider: "instagram", accountKey: "ig-1" };
    recordFailure(store, { key, label: "Instagram", active: true }, "missing_scope", "brak uprawnien", NOW);
    recordFailure(store, { key, label: "Instagram", active: true }, "missing_scope", "brak uprawnien", NOW + 1);
    expect(store.getHealth(key)?.state).toBe("missing_scope");
  });

  it("komunikat nie przecieka adresow, tokenow ani URLi", () => {
    expect(sanitizeMessage("blad dla klient@example.com")).toBe("blad dla [adres]");
    expect(sanitizeMessage("Bearer abc123 nie dziala")).toContain("[sekret]");
    expect(sanitizeMessage("zobacz https://api.example.com/x?token=1")).toBe("zobacz [adres]");
    expect(sanitizeMessage("x".repeat(500))).toHaveLength(200);
  });
});
