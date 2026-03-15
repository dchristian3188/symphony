import chokidar from "chokidar";
import { load } from "./workflow.js";

/**
 * Creates a workflow store that watches a WORKFLOW.md file for changes and
 * keeps a cached copy of the most recently loaded workflow.
 *
 * If a reload fails the store retains the last known good workflow and logs
 * the error to stderr.
 */
export function createWorkflowStore() {
  /** @type {{ config: object, promptTemplate: string } | null} */
  let current = null;

  /** @type {string | null} */
  let watchedPath = null;

  /** @type {import("chokidar").FSWatcher | null} */
  let watcher = null;

  /**
   * (Re-)load the workflow from disk. On failure keeps the previous value and
   * logs an error.
   */
  async function reload() {
    if (!watchedPath) return;
    try {
      current = await load(watchedPath);
    } catch (err) {
      console.error(
        `[workflowStore] Failed to reload workflow from ${watchedPath}:`,
        err.message ?? err,
      );
      // Keep last known good `current`.
    }
  }

  /**
   * Start watching a workflow file. Performs an initial load before returning.
   *
   * @param {string} filePath - Path to the WORKFLOW.md file.
   */
  async function start(filePath) {
    // Stop any existing watcher first.
    await stop();

    watchedPath = filePath;

    // Initial load – this one is allowed to throw so callers know the file is
    // missing / broken on startup.
    current = await load(filePath);

    watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    watcher.on("change", () => {
      reload();
    });
  }

  /**
   * Stop watching and release resources.
   */
  async function stop() {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
  }

  /**
   * Force an immediate reload of the workflow file.
   */
  async function forceReload() {
    await reload();
  }

  /**
   * Return the current (cached) workflow, or null if not yet loaded.
   *
   * @returns {{ config: object, promptTemplate: string } | null}
   */
  function getCurrent() {
    return current;
  }

  return { start, stop, forceReload, getCurrent };
}
