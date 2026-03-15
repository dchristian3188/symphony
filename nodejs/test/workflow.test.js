import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { load, WorkflowError } from "../src/workflow.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("workflow loader", () => {
  it("loads YAML front matter and prompt body correctly", async () => {
    const content = `---
tracker:
  kind: linear
agent:
  max_turns: 5
---
Fix the bug described in {{ issue.title }}`;
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(filePath, content);

    const result = await load(filePath);

    assert.deepStrictEqual(result.config, {
      tracker: { kind: "linear" },
      agent: { max_turns: 5 },
    });
    assert.strictEqual(
      result.promptTemplate,
      "Fix the bug described in {{ issue.title }}"
    );
  });

  it("no front matter → entire file is prompt, empty config", async () => {
    const content = "Just a plain prompt template\nwith multiple lines";
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(filePath, content);

    const result = await load(filePath);

    assert.deepStrictEqual(result.config, {});
    assert.strictEqual(result.promptTemplate, content.trim());
  });

  it("empty front matter (---\\n---) → empty config", async () => {
    const content = "---\n---\nSome prompt here";
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(filePath, content);

    const result = await load(filePath);

    assert.deepStrictEqual(result.config, {});
    assert.strictEqual(result.promptTemplate, "Some prompt here");
  });

  it("non-map front matter (array) → throws workflow_front_matter_not_a_map", async () => {
    const content = "---\n- item1\n- item2\n---\nPrompt";
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(filePath, content);

    await assert.rejects(() => load(filePath), (err) => {
      assert.strictEqual(err.code, WorkflowError.FRONT_MATTER_NOT_MAP);
      return true;
    });
  });

  it("missing file → throws missing_workflow_file", async () => {
    const filePath = path.join(tmpDir, "DOES_NOT_EXIST.md");

    await assert.rejects(() => load(filePath), (err) => {
      assert.strictEqual(err.code, WorkflowError.MISSING_FILE);
      return true;
    });
  });

  it("whitespace-only prompt → empty prompt string", async () => {
    const content = "---\nkey: value\n---\n   \n  \n  ";
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(filePath, content);

    const result = await load(filePath);

    assert.deepStrictEqual(result.config, { key: "value" });
    assert.strictEqual(result.promptTemplate, "");
  });
});
