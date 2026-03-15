import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

/**
 * Error codes used by the workflow loader.
 */
export const WorkflowError = {
  MISSING_FILE: "missing_workflow_file",
  PARSE_ERROR: "workflow_parse_error",
  FRONT_MATTER_NOT_MAP: "workflow_front_matter_not_a_map",
};

/**
 * Load a WORKFLOW.md file, splitting YAML front matter from the prompt body.
 *
 * Parse rules:
 *  - If the file starts with `---`, everything up to the next `---` is parsed
 *    as YAML front matter. The remainder becomes the prompt body (trimmed).
 *  - If there is no front matter the entire file is the prompt body and an
 *    empty config object is returned.
 *  - The YAML front matter MUST decode to a plain object/map – anything else
 *    (string, array, number …) is an error.
 *
 * @param {string} filePath - Absolute or relative path to the workflow file.
 * @returns {Promise<{ config: object, promptTemplate: string }>}
 */
export async function load(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    const error = new Error(`Workflow file not found: ${filePath}`);
    error.code = WorkflowError.MISSING_FILE;
    error.cause = err;
    throw error;
  }

  const lines = raw.split("\n");

  // No front matter – the entire file is the prompt body.
  if (lines[0].trim() !== "---") {
    return { config: {}, promptTemplate: raw.trim() };
  }

  // Find the closing `---` (start searching from line index 1).
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    const error = new Error(
      "Workflow front matter is missing closing `---` delimiter",
    );
    error.code = WorkflowError.PARSE_ERROR;
    throw error;
  }

  const yamlBlock = lines.slice(1, closingIndex).join("\n");
  const promptBody = lines.slice(closingIndex + 1).join("\n").trim();

  let parsed;
  try {
    parsed = yaml.load(yamlBlock);
  } catch (err) {
    const error = new Error(`Failed to parse YAML front matter: ${err.message}`);
    error.code = WorkflowError.PARSE_ERROR;
    error.cause = err;
    throw error;
  }

  // An empty YAML block (e.g. `---\n---`) parses as undefined/null – treat as
  // empty config.
  if (parsed == null) {
    return { config: {}, promptTemplate: promptBody };
  }

  // The parsed value must be a plain object (map).
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error(
      "Workflow YAML front matter must be a mapping (object), " +
        `got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
    error.code = WorkflowError.FRONT_MATTER_NOT_MAP;
    throw error;
  }

  return { config: parsed, promptTemplate: promptBody };
}
