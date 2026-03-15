import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Env-var & path helpers
// ---------------------------------------------------------------------------

/**
 * If `value` starts with `$`, resolve it from `process.env`.
 * Returns the resolved string or `undefined` if the env var is not set.
 * Non-string or non-`$`-prefixed values are returned as-is.
 *
 * @param {*} value
 * @returns {string | undefined}
 */
export function resolveEnvVar(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$")) return value;
  const varName = value.slice(1);
  return process.env[varName];
}

/**
 * Expand `~` to the user's home directory and `$VAR_NAME` tokens inside a
 * path string.
 *
 * @param {string} value
 * @returns {string}
 */
export function expandPath(value) {
  if (typeof value !== "string") return value;

  let result = value;

  // Expand leading ~
  if (result.startsWith("~/") || result === "~") {
    result = path.join(os.homedir(), result.slice(1));
  }

  // Expand $VAR_NAME tokens (word-chars only).
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
    return process.env[name] ?? "";
  });

  return result;
}

// ---------------------------------------------------------------------------
// Supported tracker kinds
// ---------------------------------------------------------------------------

const SUPPORTED_TRACKER_KINDS = new Set(["linear", "memory"]);

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
];

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

/**
 * Parse a workflow front-matter config object into a fully-typed settings
 * object with defaults applied.
 *
 * @param {object} workflowConfig - Raw config from the YAML front matter.
 * @returns {object} Normalised settings.
 */
export function getSettings(workflowConfig = {}) {
  const cfg = workflowConfig ?? {};

  const trackerRaw = cfg.tracker ?? {};
  const pollingRaw = cfg.polling ?? {};
  const workspaceRaw = cfg.workspace ?? {};
  const hooksRaw = cfg.hooks ?? {};
  const agentRaw = cfg.agent ?? {};
  const codexRaw = cfg.codex ?? {};
  const serverRaw = cfg.server ?? {};

  // Tracker ----------------------------------------------------------------
  const trackerKind = trackerRaw.kind ?? undefined;

  let trackerEndpoint = trackerRaw.endpoint ?? undefined;
  if (trackerEndpoint === undefined && trackerKind === "linear") {
    trackerEndpoint = "https://api.linear.app/graphql";
  }

  const trackerApiKeyRaw = trackerRaw.api_key ?? undefined;
  const trackerApiKey = resolveEnvVar(trackerApiKeyRaw);

  const trackerProjectSlug = trackerRaw.project_slug ?? undefined;

  const trackerActiveStates =
    trackerRaw.active_states ?? [...DEFAULT_ACTIVE_STATES];
  const trackerTerminalStates =
    trackerRaw.terminal_states ?? [...DEFAULT_TERMINAL_STATES];

  // Polling -----------------------------------------------------------------
  const pollingIntervalMs = pollingRaw.interval_ms ?? 30_000;

  // Workspace ---------------------------------------------------------------
  const workspaceRootRaw =
    workspaceRaw.root ?? path.join(os.tmpdir(), "symphony_workspaces");
  const workspaceRoot = expandPath(workspaceRootRaw);

  // Hooks -------------------------------------------------------------------
  const hooks = {
    after_create: hooksRaw.after_create ?? null,
    before_run: hooksRaw.before_run ?? null,
    after_run: hooksRaw.after_run ?? null,
    before_remove: hooksRaw.before_remove ?? null,
    timeout_ms: hooksRaw.timeout_ms ?? 60_000,
  };

  // Agent -------------------------------------------------------------------
  const agent = {
    max_concurrent_agents: agentRaw.max_concurrent_agents ?? 10,
    max_turns: agentRaw.max_turns ?? 20,
    max_retry_backoff_ms: agentRaw.max_retry_backoff_ms ?? 300_000,
    max_concurrent_agents_by_state:
      agentRaw.max_concurrent_agents_by_state ?? {},
  };

  // Codex -------------------------------------------------------------------
  const codex = {
    command:
      codexRaw.command ??
      "claude -p --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100",
    turn_timeout_ms: codexRaw.turn_timeout_ms ?? 3_600_000,
    read_timeout_ms: codexRaw.read_timeout_ms ?? 5_000,
    stall_timeout_ms: codexRaw.stall_timeout_ms ?? 300_000,
  };

  // Server ------------------------------------------------------------------
  const server = {
    port: serverRaw.port ?? null,
  };

  return {
    tracker: {
      kind: trackerKind,
      endpoint: trackerEndpoint,
      api_key: trackerApiKey,
      project_slug: trackerProjectSlug,
      active_states: trackerActiveStates,
      terminal_states: trackerTerminalStates,
    },
    polling: {
      interval_ms: pollingIntervalMs,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks,
    agent,
    codex,
    server,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the settings object contains the minimum required fields for
 * dispatching work.
 *
 * @param {object} settings - Settings from `getSettings`.
 * @throws {Error} If validation fails.
 */
export function validateDispatchConfig(settings) {
  const errors = [];

  // tracker.kind
  if (!settings.tracker?.kind) {
    errors.push("tracker.kind is required");
  } else if (!SUPPORTED_TRACKER_KINDS.has(settings.tracker.kind)) {
    errors.push(
      `tracker.kind "${settings.tracker.kind}" is not supported (expected one of: ${[...SUPPORTED_TRACKER_KINDS].join(", ")})`,
    );
  }

  // tracker.api_key (after $-resolution it must be present)
  if (
    settings.tracker?.kind === "linear" &&
    (!settings.tracker.api_key || settings.tracker.api_key.length === 0)
  ) {
    errors.push(
      "tracker.api_key is required (and must resolve to a non-empty value)",
    );
  }

  // tracker.project_slug
  if (
    settings.tracker?.kind === "linear" &&
    !settings.tracker.project_slug
  ) {
    errors.push("tracker.project_slug is required for linear tracker");
  }

  // codex.command
  if (!settings.codex?.command || settings.codex.command.trim().length === 0) {
    errors.push("codex.command must be a non-empty string");
  }

  if (errors.length > 0) {
    const error = new Error(
      `Invalid dispatch config:\n  - ${errors.join("\n  - ")}`,
    );
    error.validationErrors = errors;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-state concurrency lookup
// ---------------------------------------------------------------------------

/**
 * Return the maximum number of concurrent agents allowed for the given state.
 *
 * Lookup is case-insensitive. Falls back to `agent.max_concurrent_agents` if
 * no per-state override is configured.
 *
 * @param {object} settings
 * @param {string} stateName
 * @returns {number}
 */
export function maxConcurrentAgentsForState(settings, stateName) {
  const byState = settings.agent?.max_concurrent_agents_by_state ?? {};
  const normalised = stateName.toLowerCase();

  for (const [key, value] of Object.entries(byState)) {
    if (key.toLowerCase() === normalised) {
      return value;
    }
  }

  return settings.agent?.max_concurrent_agents ?? 10;
}
