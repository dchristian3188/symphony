import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPrompt } from "../src/promptBuilder.js";

describe("promptBuilder", () => {
  it("renders issue.identifier and issue.title", async () => {
    const template =
      "Work on {{ issue.identifier }}: {{ issue.title }}";
    const issue = { identifier: "PROJ-1", title: "Fix login bug" };

    const result = await buildPrompt(template, issue);

    assert.strictEqual(result, "Work on PROJ-1: Fix login bug");
  });

  it("renders with attempt variable", async () => {
    const template = "Attempt #{{ attempt }} for {{ issue.identifier }}";
    const issue = { identifier: "PROJ-2" };

    const result = await buildPrompt(template, issue, 3);

    assert.strictEqual(result, "Attempt #3 for PROJ-2");
  });

  it("uses default prompt when template is empty", async () => {
    const issue = {
      identifier: "PROJ-3",
      title: "Add dark mode",
      description: "Please implement dark mode.",
    };

    const result = await buildPrompt("", issue);

    assert.ok(result.includes("PROJ-3"));
    assert.ok(result.includes("Add dark mode"));
    assert.ok(result.includes("Please implement dark mode."));
  });

  it("throws on unknown variable (strict mode)", async () => {
    const template = "Hello {{ bogus_variable }}";

    await assert.rejects(() => buildPrompt(template, {}));
  });
});
