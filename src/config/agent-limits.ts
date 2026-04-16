import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

/**
 * Resolve per-agent lane configurations from agents.list[].maxConcurrent.
 * Returns a map of agentId → maxConcurrent for agents that have their own lane.
 */
export function resolvePerAgentLanes(cfg?: OpenClawConfig): Map<string, number> {
  const lanes = new Map<string, number>();
  const agents = cfg?.agents?.list;
  if (!Array.isArray(agents)) {
    return lanes;
  }
  for (const agent of agents) {
    if (!agent?.id || agent.default) {
      continue;
    }
    const raw = agent.maxConcurrent;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      lanes.set(agent.id, Math.max(1, Math.floor(raw)));
    } else {
      // Non-default agents without explicit maxConcurrent share the main lane
    }
  }
  return lanes;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}
