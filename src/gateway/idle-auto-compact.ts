import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { compactEmbeddedPiSession } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";

const log = createSubsystemLogger("gateway/idle-auto-compact");

export type IdleAutoCompactPolicy = {
  enabled: boolean;
  contextThresholdRatio: number;
  idleMinutes: number;
  cooldownMinutes: number;
  maxQueueDepth: number;
  scanEveryMinutes: number;
};

export type IdleAutoCompactSkipReason =
  | "disabled"
  | "queue-depth"
  | "reserved-session"
  | "missing-session-id"
  | "stale-total-tokens"
  | "missing-context-window"
  | "below-threshold"
  | "not-idle"
  | "cooldown"
  | "compact-failed"
  | "compact-skipped";

export type IdleAutoCompactDecision = {
  sessionKey: string;
  reason: IdleAutoCompactSkipReason | "compacted";
  detail?: string;
};

export type IdleAutoCompactSweepResult = {
  compacted: number;
  decisions: IdleAutoCompactDecision[];
};

export function summarizeIdleAutoCompactDecisions(
  decisions: IdleAutoCompactDecision[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const decision of decisions) {
    summary[decision.reason] = (summary[decision.reason] ?? 0) + 1;
  }
  return summary;
}

export function resolveIdleAutoCompactPolicy(cfg: OpenClawConfig): IdleAutoCompactPolicy {
  const raw = cfg.agents?.defaults?.compaction?.idleAutoCompact;
  return {
    enabled: raw?.enabled === true,
    contextThresholdRatio: raw?.contextThresholdRatio ?? 0.8,
    idleMinutes: raw?.idleMinutes ?? 10,
    cooldownMinutes: raw?.cooldownMinutes ?? 30,
    maxQueueDepth: raw?.maxQueueDepth ?? 0,
    scanEveryMinutes: raw?.scanEveryMinutes ?? 5,
  };
}

export function evaluateIdleAutoCompactEntry(params: {
  sessionKey: string;
  entry: SessionEntry;
  policy: IdleAutoCompactPolicy;
  now: number;
  queueDepth: number;
}): IdleAutoCompactDecision | { sessionKey: string; reason: "eligible" } {
  const { sessionKey, entry, policy, now, queueDepth } = params;
  if (sessionKey === "global" || sessionKey === "unknown") {
    return { sessionKey, reason: "reserved-session" };
  }
  if (!entry.sessionId) {
    return { sessionKey, reason: "missing-session-id" };
  }
  if (queueDepth > policy.maxQueueDepth) {
    return { sessionKey, reason: "queue-depth" };
  }
  const totalTokens = resolveFreshSessionTotalTokens(entry);
  if (typeof totalTokens !== "number") {
    return { sessionKey, reason: "stale-total-tokens" };
  }
  const contextTokens = entry.contextTokens;
  if (typeof contextTokens !== "number" || contextTokens <= 0) {
    return { sessionKey, reason: "missing-context-window" };
  }
  if (totalTokens / contextTokens < policy.contextThresholdRatio) {
    return { sessionKey, reason: "below-threshold" };
  }
  const updatedAt = entry.updatedAt ?? 0;
  if (now - updatedAt < policy.idleMinutes * 60_000) {
    return { sessionKey, reason: "not-idle" };
  }
  const lastCompactedAt = entry.lastCompactedAt ?? 0;
  if (lastCompactedAt > 0 && now - lastCompactedAt < policy.cooldownMinutes * 60_000) {
    return { sessionKey, reason: "cooldown" };
  }
  return { sessionKey, reason: "eligible" };
}

export function resolveIdleAutoCompactRuntime(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
}) {
  const agentId = normalizeAgentId(params.agentId ?? "main");
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  return {
    agentId,
    storePath,
    workspaceDir: params.workspaceDir?.trim() || process.cwd(),
    agentDir: resolveOpenClawAgentDir(),
  };
}

export type IdleAutoCompactSweepDeps = {
  now?: () => number;
  resolveRuntime?: (params: { cfg: OpenClawConfig; workspaceDir?: string; agentId?: string }) => {
    agentId: string;
    storePath: string;
    workspaceDir: string;
    agentDir: string;
  };
  loadStore?: (storePath: string) => Record<string, SessionEntry>;
  resolveSessionFile?: (params: {
    sessionId: string;
    entry: SessionEntry;
    runtime: {
      agentId: string;
      storePath: string;
      workspaceDir: string;
      agentDir: string;
    };
  }) => string;
  compactSession?: (params: {
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
    workspaceDir: string;
    agentDir: string;
    config: OpenClawConfig;
    provider?: string;
    model?: string;
    trigger: "automatic";
    allowGatewaySubagentBinding: boolean;
    bashElevated: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: "off";
    };
  }) => Promise<{ ok: boolean; compacted: boolean; reason?: string }>;
};

export async function runIdleAutoCompactSweepDetailed(params: {
  cfg: OpenClawConfig;
  getQueueSize?: (lane?: string) => number;
  maxSessionsPerSweep?: number;
  workspaceDir?: string;
  agentId?: string;
  deps?: IdleAutoCompactSweepDeps;
}): Promise<IdleAutoCompactSweepResult> {
  const policy = resolveIdleAutoCompactPolicy(params.cfg);
  if (!policy.enabled) {
    return { compacted: 0, decisions: [{ sessionKey: "*", reason: "disabled" }] };
  }

  const now = params.deps?.now?.() ?? Date.now();
  const queueDepth = Math.max(0, params.getQueueSize?.() ?? 0);
  if (queueDepth > policy.maxQueueDepth) {
    return { compacted: 0, decisions: [{ sessionKey: "*", reason: "queue-depth" }] };
  }

  const runtime = (params.deps?.resolveRuntime ?? resolveIdleAutoCompactRuntime)({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
  });
  const store = (params.deps?.loadStore ?? loadSessionStore)(runtime.storePath);
  const decisions: IdleAutoCompactDecision[] = [];
  const candidates = Object.entries(store)
    .map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
      evaluation: evaluateIdleAutoCompactEntry({ sessionKey, entry, policy, now, queueDepth }),
    }))
    .filter((item) => {
      if (item.evaluation.reason !== "eligible") {
        decisions.push(item.evaluation);
        return false;
      }
      return true;
    })
    .toSorted((a, b) => (b.entry.totalTokens ?? 0) - (a.entry.totalTokens ?? 0));

  const maxSessions = Math.max(1, params.maxSessionsPerSweep ?? 1);
  const resolveSessionFile =
    params.deps?.resolveSessionFile ??
    ((fileParams) =>
      resolveSessionFilePath(
        fileParams.sessionId,
        fileParams.entry,
        resolveSessionFilePathOptions({
          agentId: fileParams.runtime.agentId,
          storePath: fileParams.runtime.storePath,
        }),
      ));
  const compactSession = params.deps?.compactSession ?? compactEmbeddedPiSession;
  let compacted = 0;

  for (const { sessionKey, entry } of candidates) {
    if (compacted >= maxSessions) {
      break;
    }
    try {
      const sessionFile = resolveSessionFile({
        sessionId: entry.sessionId,
        entry,
        runtime,
      });
      const result = await compactSession({
        sessionId: entry.sessionId,
        sessionKey,
        sessionFile,
        workspaceDir: runtime.workspaceDir,
        agentDir: runtime.agentDir,
        config: params.cfg,
        provider: entry.modelProvider,
        model: entry.model,
        trigger: "automatic",
        allowGatewaySubagentBinding: true,
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
      });
      if (result.ok && result.compacted) {
        compacted += 1;
        decisions.push({ sessionKey, reason: "compacted" });
        log.info(`idle auto-compact succeeded for ${sessionKey}`);
      } else {
        decisions.push({ sessionKey, reason: "compact-skipped", detail: result.reason });
      }
    } catch (err) {
      decisions.push({ sessionKey, reason: "compact-failed", detail: String(err) });
      log.warn(`idle auto-compact failed for ${sessionKey}: ${String(err)}`);
    }
  }

  return { compacted, decisions };
}

export async function runIdleAutoCompactSweep(params: {
  cfg: OpenClawConfig;
  getQueueSize?: (lane?: string) => number;
  maxSessionsPerSweep?: number;
  workspaceDir?: string;
  agentId?: string;
}): Promise<number> {
  const result = await runIdleAutoCompactSweepDetailed(params);
  return result.compacted;
}
