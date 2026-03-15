import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Default turn timeout: 1 hour.
 */
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Default max turns per subprocess invocation.
 */
const DEFAULT_MAX_TURNS = 100;

/**
 * Start a new Claude Code session.
 * Validates the workspace path and returns a session object.
 *
 * @param {string} workspace - Absolute path to the workspace directory
 * @param {object} settings - Configuration settings
 * @returns {{ id: string, workspace: string, settings: object, threadId: string|null, process: import('node:child_process').ChildProcess|null }}
 */
export function startSession(workspace, settings) {
  const resolved = path.resolve(workspace);
  if (!resolved || resolved === "/") {
    throw new Error(`Invalid workspace path: ${workspace}`);
  }

  return {
    id: randomUUID(),
    workspace: resolved,
    settings,
    threadId: null,
    process: null,
  };
}

/**
 * Run a turn in a Claude Code session.
 * Launches `claude` CLI as a subprocess and streams output.
 *
 * For initial turns: claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100
 * For continuation turns: claude --continue --session-id <sessionId> -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100
 *
 * @param {object} session - Session object from startSession
 * @param {string} prompt - The prompt to send
 * @param {object|null} issue - Issue context (for event metadata)
 * @param {object} [opts={}] - Options
 * @param {function} [opts.onMessage] - Callback for streaming events: (event) => void
 * @param {number} [opts.timeoutMs] - Turn timeout in milliseconds
 * @param {number} [opts.maxTurns] - Max agentic turns
 * @returns {Promise<{ sessionId: string, threadId: string|null, turnId: string, result: object|null }>}
 */
export async function runTurn(session, prompt, issue, opts = {}) {
  const turnId = randomUUID();
  const timeoutMs =
    opts.timeoutMs ??
    session.settings?.codex?.turn_timeout_ms ??
    DEFAULT_TURN_TIMEOUT_MS;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const onMessage = opts.onMessage || (() => {});

  // Build command args
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
  ];

  // If this is a continuation turn, add --continue --session-id
  if (session.threadId) {
    args.unshift("--continue", "--session-id", session.threadId);
  }

  return new Promise((resolve, reject) => {
    let result = null;
    let sessionId = session.threadId;
    let timedOut = false;
    const collectedEvents = [];

    // Spawn the claude subprocess
    const child = spawn("claude", args, {
      cwd: session.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    session.process = child;

    // Emit session_started event
    onMessage({
      type: "session_started",
      sessionId: session.id,
      turnId,
      workspace: session.workspace,
      timestamp: new Date().toISOString(),
    });

    // Set up turn timeout
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it a moment to exit gracefully, then force kill
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    // Parse stdout line-by-line as newline-delimited JSON
    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Non-JSON output, emit as raw notification
        onMessage({
          type: "notification",
          subtype: "raw_output",
          content: trimmed,
          turnId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      collectedEvents.push(event);

      // Extract session_id from result events
      if (event.session_id) {
        sessionId = event.session_id;
        session.threadId = sessionId;
      }

      // Handle different event types
      if (event.type === "result") {
        result = {
          content: event.result || null,
          sessionId: event.session_id || sessionId,
          usage: event.usage || null,
          costUsd: event.cost_usd ?? null,
          duration: event.duration_ms ?? null,
          turns: event.num_turns ?? null,
        };

        onMessage({
          type: "result",
          data: result,
          turnId,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "assistant") {
        onMessage({
          type: "notification",
          subtype: "assistant_message",
          content: event.message,
          turnId,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "tool_use" || event.type === "tool_result") {
        onMessage({
          type: event.type,
          data: event,
          turnId,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Forward any other event types
        onMessage({
          type: "notification",
          subtype: event.type || "unknown",
          data: event,
          turnId,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Collect stderr for diagnostics
    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      session.process = null;

      onMessage({
        type: "turn_failed",
        error: err.message,
        turnId,
        timestamp: new Date().toISOString(),
      });

      reject(new Error(`Failed to spawn claude subprocess: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      session.process = null;

      if (timedOut) {
        onMessage({
          type: "turn_failed",
          error: `Turn timed out after ${timeoutMs}ms`,
          turnId,
          timestamp: new Date().toISOString(),
        });

        reject(
          new Error(`Claude subprocess timed out after ${timeoutMs}ms`)
        );
        return;
      }

      if (code === 0) {
        onMessage({
          type: "turn_completed",
          sessionId: session.id,
          threadId: sessionId,
          turnId,
          result,
          timestamp: new Date().toISOString(),
        });

        resolve({
          sessionId: session.id,
          threadId: sessionId,
          turnId,
          result,
        });
      } else {
        const errMsg = stderrBuf.trim()
          ? `Claude subprocess exited with code ${code}: ${stderrBuf.trim()}`
          : `Claude subprocess exited with code ${code}`;

        onMessage({
          type: "turn_failed",
          error: errMsg,
          code,
          signal,
          turnId,
          timestamp: new Date().toISOString(),
        });

        reject(new Error(errMsg));
      }
    });
  });
}

/**
 * Stop a session by killing the subprocess if still running.
 * @param {object} session - Session object from startSession
 * @returns {void}
 */
export function stopSession(session) {
  if (session.process && !session.process.killed) {
    session.process.kill("SIGTERM");

    // Force kill after a grace period
    setTimeout(() => {
      if (session.process && !session.process.killed) {
        session.process.kill("SIGKILL");
      }
    }, 5000);
  }

  session.process = null;
}
