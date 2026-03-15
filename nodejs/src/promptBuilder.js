import { Liquid } from "liquidjs";

// ---------------------------------------------------------------------------
// Default prompt template (used when the workflow provides no prompt body)
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT = `You are working on a Linear issue.
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Body:
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}`;

// ---------------------------------------------------------------------------
// Liquid engine (singleton – strict mode catches typos in templates)
// ---------------------------------------------------------------------------

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert all top-level keys of an object to strings for Liquid template
 * compatibility while preserving nested arrays and maps.
 *
 * @param {object} obj
 * @returns {object}
 */
function stringifyKeys(obj) {
  if (obj == null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(stringifyKeys);
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const k = String(key);
    if (value !== null && typeof value === "object") {
      result[k] = Array.isArray(value)
        ? value.map(stringifyKeys)
        : stringifyKeys(value);
    } else {
      result[k] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a Liquid prompt template with the given issue and attempt context.
 *
 * @param {string} promptTemplate - Liquid template string (from workflow).
 * @param {object} issue          - Issue object (all tracker fields).
 * @param {number|null} attempt   - Current attempt number, or null.
 * @returns {Promise<string>} The rendered prompt text.
 */
export async function buildPrompt(promptTemplate, issue, attempt = null) {
  const template =
    promptTemplate && promptTemplate.trim().length > 0
      ? promptTemplate
      : DEFAULT_PROMPT;

  const issueCtx = stringifyKeys(issue ?? {});

  const rendered = await engine.parseAndRender(template, {
    issue: issueCtx,
    attempt,
  });

  return rendered;
}
