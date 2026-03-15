import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Orchestrator } from "../src/orchestrator.js";
import { createMemoryTracker } from "../src/tracker/memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    state: "Todo",
    priority: 1,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function defaultSettings(tmpRoot) {
  return {
    tracker: {
      kind: "memory",
      endpoint: null,
      api_key: null,
      project_slug: null,
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: tmpRoot },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 5000,
    },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: "echo test",
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    server: { port: null },
  };
}

/** Creates a mock agent runner. run() returns a promise that resolves via the returned resolve callback. */
function createMockAgentRunner() {
  const runs = [];
  return {
    runs,
    run(issue, attempt, onMessage) {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      runs.push({ issue, attempt, onMessage, resolve, reject, promise });
      return promise;
    },
  };
}

let tmpRoot;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orch-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("orchestrator", () => {
  describe("shouldDispatch", () => {
    it("returns true for eligible issue", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 10;

      const issue = makeIssue();
      assert.strictEqual(orch.shouldDispatch(issue, settings), true);
    });

    it("returns false for already-claimed issue", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 10;

      const issue = makeIssue();
      orch.claimed.add(issue.id);

      assert.strictEqual(orch.shouldDispatch(issue, settings), false);
    });

    it("returns false when at max concurrency", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 1;

      // Simulate one running issue
      orch.running.set("other-id", {
        issue: makeIssue({ id: "other-id", identifier: "PROJ-0" }),
        identifier: "PROJ-0",
      });

      const issue = makeIssue();
      assert.strictEqual(orch.shouldDispatch(issue, settings), false);
    });

    it("returns false for todo issue with non-terminal blocker", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 10;

      const issue = makeIssue({
        state: "Todo",
        blocked_by: [{ id: "blocker-1", state: "In Progress" }],
      });
      assert.strictEqual(orch.shouldDispatch(issue, settings), false);
    });

    it("returns true for todo issue with only terminal blockers", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 10;

      const issue = makeIssue({
        state: "Todo",
        blocked_by: [{ id: "blocker-1", state: "Done" }],
      });
      assert.strictEqual(orch.shouldDispatch(issue, settings), true);
    });
  });

  describe("dispatch sort order", () => {
    it("sorts by priority asc, then created_at oldest", async () => {
      const issues = [
        makeIssue({
          id: "c",
          identifier: "PROJ-3",
          priority: 3,
          created_at: "2025-01-01T00:00:00Z",
        }),
        makeIssue({
          id: "a",
          identifier: "PROJ-1",
          priority: 1,
          created_at: "2025-01-03T00:00:00Z",
        }),
        makeIssue({
          id: "b",
          identifier: "PROJ-2",
          priority: 1,
          created_at: "2025-01-01T00:00:00Z",
        }),
      ];

      // Apply the same sort logic used in onTick
      issues.sort((a, b) => {
        const pA = a.priority ?? Number.MAX_SAFE_INTEGER;
        const pB = b.priority ?? Number.MAX_SAFE_INTEGER;
        if (pA !== pB) return pA - pB;

        const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (tA !== tB) return tA - tB;

        return (a.identifier ?? "").localeCompare(b.identifier ?? "");
      });

      assert.strictEqual(issues[0].id, "b"); // priority 1, oldest
      assert.strictEqual(issues[1].id, "a"); // priority 1, newer
      assert.strictEqual(issues[2].id, "c"); // priority 3
    });
  });

  describe("worker normal exit", () => {
    it("schedules continuation retry on normal exit", async () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([makeIssue()]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });
      orch.maxConcurrentAgents = 10;

      const issue = makeIssue();
      orch.dispatchIssue(issue, 1);

      // Resolve the worker promise (normal exit)
      assert.strictEqual(agentRunner.runs.length, 1);
      agentRunner.runs[0].resolve();

      // Wait for the promise chain to settle
      await new Promise((r) => setTimeout(r, 50));

      // Should have a retry scheduled
      assert.ok(orch.retryAttempts.has(issue.id));
      const retry = orch.retryAttempts.get(issue.id);
      assert.strictEqual(retry.attempt, 1);

      // Cleanup timers
      orch.stop();
    });
  });

  describe("startup terminal cleanup", () => {
    it("removes workspaces for terminal issues", async () => {
      const settings = defaultSettings(tmpRoot);

      // Create a workspace directory that should be cleaned up
      const wsPath = path.join(tmpRoot, "PROJ-DONE");
      await fs.mkdir(wsPath, { recursive: true });
      await fs.writeFile(path.join(wsPath, "file.txt"), "data");

      const terminalIssue = makeIssue({
        id: "done-1",
        identifier: "PROJ-DONE",
        state: "Done",
      });
      const tracker = createMemoryTracker([terminalIssue]);
      const agentRunner = createMockAgentRunner();

      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });

      await orch.startupTerminalCleanup();

      // Workspace should be removed
      await assert.rejects(() => fs.stat(wsPath), { code: "ENOENT" });

      orch.stop();
    });
  });

  describe("getSnapshot", () => {
    it("returns correct shape", () => {
      const settings = defaultSettings(tmpRoot);
      const tracker = createMemoryTracker([]);
      const agentRunner = createMockAgentRunner();
      const orch = new Orchestrator({
        tracker,
        agentRunner,
        config: () => settings,
        settings,
      });

      const snap = orch.getSnapshot();

      assert.ok(Array.isArray(snap.running));
      assert.ok(Array.isArray(snap.retrying));
      assert.ok(typeof snap.codexTotals === "object");
      assert.ok("inputTokens" in snap.codexTotals);
      assert.ok("outputTokens" in snap.codexTotals);
      assert.ok("totalTokens" in snap.codexTotals);
      assert.ok("secondsRunning" in snap.codexTotals);
      assert.strictEqual(snap.running.length, 0);
      assert.strictEqual(snap.retrying.length, 0);
    });
  });
});
