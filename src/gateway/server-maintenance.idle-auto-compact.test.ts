import { afterEach, describe, expect, it, vi } from "vitest";

const runIdleAutoCompactSweepDetailedMock = vi.fn(async () => ({
  compacted: 1,
  decisions: [{ sessionKey: "abc", reason: "compacted" }],
}));
const summarizeIdleAutoCompactDecisionsMock = vi.fn(() => ({ compacted: 1 }));

vi.mock("./idle-auto-compact.js", () => ({
  runIdleAutoCompactSweepDetailed: runIdleAutoCompactSweepDetailedMock,
  summarizeIdleAutoCompactDecisions: summarizeIdleAutoCompactDecisionsMock,
}));

describe("startGatewayMaintenanceTimers idle auto compact", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("schedules idle auto-compact sweep when enabled", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 1,
      getHealthVersion: () => 1,
      refreshGatewayHealthSnapshot: async () => ({ ok: true }),
      logHealth: { error: () => {} },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState: { abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: () => undefined,
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      cfg: {
        agents: {
          defaults: {
            compaction: {
              idleAutoCompact: {
                enabled: true,
                scanEveryMinutes: 5,
              },
            },
          },
        },
      },
    });

    expect(timers.mediaCleanup).toBeNull();
    expect(timers.idleAutoCompactCleanup).not.toBeNull();
    expect(runIdleAutoCompactSweepDetailedMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runIdleAutoCompactSweepDetailedMock).toHaveBeenCalledTimes(1);
    expect(summarizeIdleAutoCompactDecisionsMock).toHaveBeenCalledWith([
      { sessionKey: "abc", reason: "compacted" },
    ]);

    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    if (timers.mediaCleanup) {
      clearInterval(timers.mediaCleanup);
    }
    if (timers.idleAutoCompactCleanup) {
      clearInterval(timers.idleAutoCompactCleanup);
    }
  });
});
