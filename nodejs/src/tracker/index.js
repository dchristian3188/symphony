import { createLinearClient } from "./linear.js";
import { createMemoryTracker } from "./memory.js";

/**
 * Factory function that creates a tracker adapter based on settings.
 *
 * @param {object} settings - Symphony settings object.
 * @param {object} settings.tracker - Tracker configuration.
 * @param {string} settings.tracker.kind - Either "linear" or "memory".
 * @returns {{ fetchCandidateIssues: Function, fetchIssuesByStates: Function, fetchIssueStatesByIds: Function }}
 */
export function createTracker(settings) {
  const kind = settings?.tracker?.kind;

  switch (kind) {
    case "linear":
      return createLinearClient(settings);
    case "memory":
      return createMemoryTracker(settings?.tracker?.initialIssues ?? []);
    default:
      throw new Error(`Unsupported tracker kind: ${kind}`);
  }
}
