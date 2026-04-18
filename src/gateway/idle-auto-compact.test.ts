import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  evaluateIdleAutoCompactEntry,
  resolveIdleAutoCompactPolicy,
  summarizeIdleAutoCompactDecisions,
} from "./idle-auto-compact.js";

const NOW = new Date("2026-04-18T06:00:00.000Z").getTime();

function policy(overrides: Record<string, number | boolean> = {}) {
  return {
    enabled: true,
    contextThresholdRatio: 0.8,
    idleMinutes: 10,
    cooldownMinutes: 30,
    maxQueueDepth: 0,
    scanEveryMinutes: 5,
    ...overrides,
  };
}

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: NOW - 11 * 60_000,
    totalTokens: 90,
    totalTokensFresh: true,
    contextTokens: 100,
    ...overrides,
  };
}

describe("idle auto compact policy", () => {
  it("resolves conservative defaults", () => {
    expect(resolveIdleAutoCompactPolicy({} as OpenClawConfig)).toEqual({
      enabled: false,
      contextThresholdRatio: 0.8,
      idleMinutes: 10,
      cooldownMinutes: 30,
      maxQueueDepth: 0,
      scanEveryMinutes: 5,
    });
  });
});

describe("evaluateIdleAutoCompactEntry", () => {
  it("marks an idle high-context session as eligible", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy(),
      now: NOW,
      queueDepth: 0,
      entry: entry(),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "eligible" });
  });

  it("skips when total token usage is below threshold", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy(),
      now: NOW,
      queueDepth: 0,
      entry: entry({ totalTokens: 79 }),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "below-threshold" });
  });

  it("skips when the session has not been idle long enough", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy(),
      now: NOW,
      queueDepth: 0,
      entry: entry({ updatedAt: NOW - 5 * 60_000 }),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "not-idle" });
  });

  it("skips when within cooldown after recent compaction", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy(),
      now: NOW,
      queueDepth: 0,
      entry: entry({
        updatedAt: NOW - 20 * 60_000,
        lastCompactedAt: NOW - 10 * 60_000,
      }),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "cooldown" });
  });

  it("skips when queue depth exceeds policy", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy({ maxQueueDepth: 0 }),
      now: NOW,
      queueDepth: 1,
      entry: entry({ updatedAt: NOW - 20 * 60_000 }),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "queue-depth" });
  });

  it("treats stale total tokens as not eligible", () => {
    const decision = evaluateIdleAutoCompactEntry({
      sessionKey: "telegram:direct:123",
      policy: policy(),
      now: NOW,
      queueDepth: 0,
      entry: entry({ updatedAt: NOW - 20 * 60_000, totalTokensFresh: false }),
    });
    expect(decision).toEqual({ sessionKey: "telegram:direct:123", reason: "stale-total-tokens" });
  });
});

describe("summarizeIdleAutoCompactDecisions", () => {
  it("aggregates decisions by reason", () => {
    expect(
      summarizeIdleAutoCompactDecisions([
        { sessionKey: "a", reason: "compacted" },
        { sessionKey: "b", reason: "below-threshold" },
        { sessionKey: "c", reason: "below-threshold" },
      ]),
    ).toEqual({ compacted: 1, "below-threshold": 2 });
  });
});
