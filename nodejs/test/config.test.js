import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import os from "node:os";
import {
  getSettings,
  resolveEnvVar,
  expandPath,
  validateDispatchConfig,
  maxConcurrentAgentsForState,
} from "../src/config.js";

describe("config", () => {
  describe("getSettings", () => {
    it("returns all defaults with empty config", () => {
      const s = getSettings({});

      assert.strictEqual(s.tracker.kind, undefined);
      assert.strictEqual(s.polling.interval_ms, 30_000);
      assert.strictEqual(s.agent.max_concurrent_agents, 10);
      assert.strictEqual(s.agent.max_turns, 20);
      assert.strictEqual(s.hooks.after_create, null);
      assert.strictEqual(s.server.port, null);
    });

    it("populates tracker defaults (active_states, terminal_states, endpoint)", () => {
      const s = getSettings({ tracker: { kind: "linear" } });

      assert.deepStrictEqual(s.tracker.active_states, [
        "Todo",
        "In Progress",
      ]);
      assert.ok(s.tracker.terminal_states.includes("Done"));
      assert.ok(s.tracker.terminal_states.includes("Closed"));
      assert.strictEqual(
        s.tracker.endpoint,
        "https://api.linear.app/graphql"
      );
    });
  });

  describe("resolveEnvVar", () => {
    const envKey = "SYMPHONY_TEST_VAR_" + Date.now();

    beforeEach(() => {
      process.env[envKey] = "resolved_value";
    });

    afterEach(() => {
      delete process.env[envKey];
    });

    it("resolves $VAR from process.env", () => {
      const result = resolveEnvVar("$" + envKey);
      assert.strictEqual(result, "resolved_value");
    });

    it("returns non-$ strings as-is", () => {
      assert.strictEqual(resolveEnvVar("plain_string"), "plain_string");
    });
  });

  describe("expandPath", () => {
    it("expands ~ to homedir", () => {
      const result = expandPath("~/projects");
      const expected = os.homedir() + "/projects";
      assert.strictEqual(result, expected);
    });
  });

  describe("validateDispatchConfig", () => {
    it("throws on missing tracker.kind", () => {
      const s = getSettings({});
      assert.throws(() => validateDispatchConfig(s), (err) => {
        assert.ok(err.message.includes("tracker.kind"));
        return true;
      });
    });

    it("throws on missing api_key for linear", () => {
      const s = getSettings({
        tracker: { kind: "linear", project_slug: "test" },
      });
      assert.throws(() => validateDispatchConfig(s), (err) => {
        assert.ok(err.message.includes("api_key"));
        return true;
      });
    });

    it("passes with valid linear config", () => {
      const envKey = "SYMPHONY_VALID_KEY_" + Date.now();
      process.env[envKey] = "sk-test-key";

      try {
        const s = getSettings({
          tracker: {
            kind: "linear",
            api_key: "$" + envKey,
            project_slug: "my-project",
          },
        });
        // Should not throw
        validateDispatchConfig(s);
      } finally {
        delete process.env[envKey];
      }
    });
  });

  describe("maxConcurrentAgentsForState", () => {
    it("returns per-state limit", () => {
      const s = getSettings({
        agent: {
          max_concurrent_agents: 10,
          max_concurrent_agents_by_state: { "In Progress": 3 },
        },
      });
      assert.strictEqual(maxConcurrentAgentsForState(s, "In Progress"), 3);
    });

    it("falls back to global limit", () => {
      const s = getSettings({
        agent: { max_concurrent_agents: 7 },
      });
      assert.strictEqual(maxConcurrentAgentsForState(s, "Todo"), 7);
    });
  });
});
