import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { runIdleAutoCompactSweepDetailed } from "./idle-auto-compact.js";

const NOW = new Date("2026-04-18T07:00:00.000Z").getTime();

function cfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: {
          idleAutoCompact: {
            enabled: true,
            contextThresholdRatio: 0.8,
            idleMinutes: 10,
            cooldownMinutes: 30,
            maxQueueDepth: 0,
            scanEveryMinutes: 5,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function entry(
  sessionId: string,
  totalTokens: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId,
    updatedAt: NOW - 20 * 60_000,
    totalTokens,
    totalTokensFresh: true,
    contextTokens: 100,
    modelProvider: "ollama",
    model: "gemma4:e4b",
    ...overrides,
  };
}

function deps(store: Record<string, SessionEntry>) {
  return {
    now: () => NOW,
    resolveRuntime: () => ({
      agentId: "main",
      storePath: "/tmp/sessions.json",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    }),
    loadStore: vi.fn(() => store),
    resolveSessionFile: vi.fn(({ sessionId }) => `/tmp/${sessionId}.jsonl`),
    compactSession: vi.fn(),
  };
}

describe("runIdleAutoCompactSweepDetailed", () => {
  it("compacts only the highest-token eligible session per sweep by default", async () => {
    const testDeps = deps({
      low: entry("sess-low", 81),
      high: entry("sess-high", 95),
    });
    testDeps.compactSession.mockResolvedValue({ ok: true, compacted: true });

    const result = await runIdleAutoCompactSweepDetailed({ cfg: cfg(), deps: testDeps });

    expect(testDeps.compactSession).toHaveBeenCalledTimes(1);
    expect(testDeps.compactSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "high", sessionId: "sess-high" }),
    );
    expect(result.compacted).toBe(1);
    expect(result.decisions).toContainEqual({ sessionKey: "high", reason: "compacted" });
  });

  it("respects maxSessionsPerSweep when more than one eligible session exists", async () => {
    const testDeps = deps({
      a: entry("sess-a", 99),
      b: entry("sess-b", 95),
      c: entry("sess-c", 91),
    });
    testDeps.compactSession.mockResolvedValue({ ok: true, compacted: true });

    const result = await runIdleAutoCompactSweepDetailed({
      cfg: cfg(),
      maxSessionsPerSweep: 2,
      deps: testDeps,
    });

    expect(testDeps.compactSession).toHaveBeenCalledTimes(2);
    expect(testDeps.compactSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sessionKey: "a" }),
    );
    expect(testDeps.compactSession.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ sessionKey: "b" }),
    );
    expect(result.compacted).toBe(2);
  });

  it("records compact-skipped when compaction returns ok without compacting", async () => {
    const testDeps = deps({ only: entry("sess-only", 90) });
    testDeps.compactSession.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    const result = await runIdleAutoCompactSweepDetailed({ cfg: cfg(), deps: testDeps });

    expect(result.compacted).toBe(0);
    expect(result.decisions).toContainEqual({
      sessionKey: "only",
      reason: "compact-skipped",
      detail: "below threshold",
    });
  });

  it("records compact-failed when compaction throws", async () => {
    const testDeps = deps({ only: entry("sess-only", 90) });
    testDeps.compactSession.mockRejectedValue(new Error("boom"));

    const result = await runIdleAutoCompactSweepDetailed({ cfg: cfg(), deps: testDeps });

    expect(result.compacted).toBe(0);
    expect(result.decisions).toEqual([
      expect.objectContaining({ sessionKey: "only", reason: "compact-failed" }),
    ]);
  });

  it("short-circuits the whole sweep when queue depth exceeds policy", async () => {
    const testDeps = deps({ only: entry("sess-only", 90) });

    const result = await runIdleAutoCompactSweepDetailed({
      cfg: cfg(),
      getQueueSize: () => 1,
      deps: testDeps,
    });

    expect(testDeps.loadStore).not.toHaveBeenCalled();
    expect(testDeps.compactSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      compacted: 0,
      decisions: [{ sessionKey: "*", reason: "queue-depth" }],
    });
  });
});
