import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  safeIdentifier,
  validateWorkspacePath,
  createForIssue,
  remove,
} from "../src/workspace.js";

let tmpRoot;
let settings;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
  settings = {
    workspace: { root: tmpRoot },
    hooks: { after_create: null, before_remove: null, timeout_ms: 5000 },
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("workspace", () => {
  describe("safeIdentifier", () => {
    it("replaces special chars with _", () => {
      assert.strictEqual(safeIdentifier("feat/FOO-123"), "feat_FOO-123");
      assert.strictEqual(safeIdentifier("a b@c!d"), "a_b_c_d");
    });

    it("keeps valid chars", () => {
      assert.strictEqual(safeIdentifier("FOO-123.patch"), "FOO-123.patch");
      assert.strictEqual(safeIdentifier("simple"), "simple");
    });
  });

  describe("validateWorkspacePath", () => {
    it("rejects paths outside root", () => {
      assert.throws(
        () => validateWorkspacePath("/outside/path", tmpRoot),
        /outside root/
      );
    });

    it("accepts paths under root", () => {
      // Should not throw
      validateWorkspacePath(path.join(tmpRoot, "child"), tmpRoot);
    });

    it("rejects path equal to root", () => {
      assert.throws(
        () => validateWorkspacePath(tmpRoot, tmpRoot),
        /equals root/
      );
    });
  });

  describe("createForIssue", () => {
    it("creates new directory and sets createdNow=true", async () => {
      const result = await createForIssue(settings, {
        identifier: "PROJ-42",
      });

      assert.strictEqual(result.createdNow, true);
      assert.ok(result.path.includes("PROJ-42"));

      const stat = await fs.stat(result.path);
      assert.ok(stat.isDirectory());
    });

    it("reuses existing directory and sets createdNow=false", async () => {
      // Create the workspace first
      const first = await createForIssue(settings, {
        identifier: "PROJ-99",
      });
      assert.strictEqual(first.createdNow, true);

      // Call again - should reuse
      const second = await createForIssue(settings, {
        identifier: "PROJ-99",
      });
      assert.strictEqual(second.createdNow, false);
      assert.strictEqual(second.path, first.path);
    });
  });

  describe("remove", () => {
    it("deletes workspace directory", async () => {
      const result = await createForIssue(settings, {
        identifier: "PROJ-DEL",
      });
      assert.strictEqual(result.createdNow, true);

      // Verify it exists
      const stat = await fs.stat(result.path);
      assert.ok(stat.isDirectory());

      // Remove it
      await remove(settings, result.path);

      // Verify it is gone
      await assert.rejects(() => fs.stat(result.path), { code: "ENOENT" });
    });
  });
});
