import path from "node:path";
import fs from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";

/**
 * Replace characters not in [A-Za-z0-9._-] with "_".
 * @param {string|null|undefined} identifier
 * @returns {string}
 */
export function safeIdentifier(identifier) {
  return (identifier || "issue").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Compute the workspace path for a given identifier.
 * @param {object} settings
 * @param {string} identifier
 * @returns {string}
 */
export function workspacePath(settings, identifier) {
  const sanitized = safeIdentifier(identifier);
  return path.join(settings.workspace.root, sanitized);
}

/**
 * Validate that workspacePath is strictly under workspaceRoot.
 * Both are resolved to absolute paths before comparison.
 * @param {string} workspacePath_
 * @param {string} workspaceRoot
 * @throws {Error} if path is outside root or equals root
 */
export function validateWorkspacePath(workspacePath_, workspaceRoot) {
  const resolved = path.resolve(workspacePath_);
  const resolvedRoot = path.resolve(workspaceRoot);
  const rootPrefix = resolvedRoot + "/";

  if (resolved === resolvedRoot) {
    throw new Error(
      `Workspace path equals root: ${resolved} === ${resolvedRoot}`
    );
  }

  if (!resolved.startsWith(rootPrefix)) {
    throw new Error(
      `Workspace path outside root: ${resolved} is not under ${resolvedRoot}`
    );
  }
}

/**
 * Run a hook script in a workspace directory.
 * Uses `sh -lc <script>` on POSIX.
 * @param {string} script - The hook command to run
 * @param {string} cwd - Working directory for the hook
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(script, cwd, timeoutMs) {
  try {
    const result = spawnSync("sh", ["-lc", script], {
      cwd,
      timeout: timeoutMs,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });

    return {
      status: result.status ?? 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    return {
      status: 1,
      stdout: "",
      stderr: err.message || String(err),
    };
  }
}

/**
 * Get the hook timeout from settings, with a default of 60000ms.
 * @param {object} settings
 * @returns {number}
 */
function hookTimeout(settings) {
  return settings?.hooks?.timeout_ms ?? 60000;
}

/**
 * Create a workspace for an issue.
 * @param {object} settings
 * @param {object|string} issue - Issue object with .identifier or a string identifier
 * @returns {Promise<{ path: string, createdNow: boolean }>}
 */
export async function createForIssue(settings, issue) {
  const identifier =
    typeof issue === "string" ? issue : issue?.identifier || "issue";
  const workspaceKey = safeIdentifier(identifier);
  const wsPath = path.join(settings.workspace.root, workspaceKey);

  validateWorkspacePath(wsPath, settings.workspace.root);

  let createdNow = false;

  try {
    const stat = await fs.stat(wsPath);
    if (!stat.isDirectory()) {
      // Exists but not a directory — remove and recreate
      await fs.rm(wsPath, { recursive: true, force: true });
      await fs.mkdir(wsPath, { recursive: true });
      createdNow = true;
    }
  } catch {
    // Does not exist — create
    await fs.mkdir(wsPath, { recursive: true });
    createdNow = true;
  }

  if (createdNow) {
    const afterCreate = settings?.hooks?.after_create;
    if (afterCreate) {
      const timeout = hookTimeout(settings);
      const result = runHook(afterCreate, wsPath, timeout);
      if (result.status !== 0) {
        throw new Error(
          `after_create hook failed (status ${result.status}): ${result.stderr || result.stdout}`
        );
      }
    }
  }

  return { path: wsPath, createdNow };
}

/**
 * Remove a workspace directory.
 * Validates the path is under workspace root first.
 * Runs before_remove hook (failure is logged but ignored).
 * @param {object} settings
 * @param {string} workspace - Absolute path to the workspace
 * @returns {Promise<void>}
 */
export async function remove(settings, workspace) {
  validateWorkspacePath(workspace, settings.workspace.root);

  // Run before_remove hook — failure is logged and ignored
  const beforeRemove = settings?.hooks?.before_remove;
  if (beforeRemove) {
    try {
      const timeout = hookTimeout(settings);
      const result = runHook(beforeRemove, workspace, timeout);
      if (result.status !== 0) {
        console.warn(
          `before_remove hook failed (status ${result.status}): ${result.stderr || result.stdout}`
        );
      }
    } catch (err) {
      console.warn(`before_remove hook error: ${err.message}`);
    }
  }

  await fs.rm(workspace, { recursive: true, force: true });
}

/**
 * Remove the workspace for a specific issue identifier.
 * @param {object} settings
 * @param {string} identifier - The issue identifier
 * @returns {Promise<void>}
 */
export async function removeIssueWorkspaces(settings, identifier) {
  const wsPath = workspacePath(settings, identifier);
  try {
    await remove(settings, wsPath);
  } catch {
    // If workspace doesn't exist or removal fails, ignore
  }
}

/**
 * Run the before_run hook. Failure aborts (throws).
 * @param {object} settings
 * @param {string} workspace - Workspace directory path
 * @param {object|string} issue - Issue context
 * @returns {void}
 */
export function runBeforeRunHook(settings, workspace, issue) {
  const beforeRun = settings?.hooks?.before_run;
  if (!beforeRun) return;

  const timeout = hookTimeout(settings);
  const result = runHook(beforeRun, workspace, timeout);

  if (result.status !== 0) {
    throw new Error(
      `before_run hook failed (status ${result.status}): ${result.stderr || result.stdout}`
    );
  }
}

/**
 * Run the after_run hook. Failure is logged and ignored.
 * @param {object} settings
 * @param {string} workspace - Workspace directory path
 * @param {object|string} issue - Issue context
 * @returns {void}
 */
export function runAfterRunHook(settings, workspace, issue) {
  const afterRun = settings?.hooks?.after_run;
  if (!afterRun) return;

  const timeout = hookTimeout(settings);
  const result = runHook(afterRun, workspace, timeout);

  if (result.status !== 0) {
    console.warn(
      `after_run hook failed (status ${result.status}): ${result.stderr || result.stdout}`
    );
  }
}
