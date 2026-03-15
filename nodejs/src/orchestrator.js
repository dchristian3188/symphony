// Orchestrator - owns the poll tick, in-memory runtime state, dispatch, retry, reconciliation

import { EventEmitter } from 'node:events';
import logger from './logger.js';
import { getSettings, validateDispatchConfig, maxConcurrentAgentsForState } from './config.js';
import * as workspace from './workspace.js';

export class Orchestrator extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.tracker - Issue tracker client
   * @param {object} deps.workflowStore - Workflow store (getCurrent)
   * @param {object} deps.agentRunner - Agent runner ({ run })
   * @param {function} deps.config - () => settings object
   * @param {object} deps.settings - Initial settings snapshot (fallback)
   */
  constructor(deps) {
    super();
    this.deps = deps;

    // Runtime state
    this.pollIntervalMs = 30_000;
    this.maxConcurrentAgents = 10;
    this.running = new Map();        // issue_id -> running entry
    this.claimed = new Set();        // issue IDs reserved/running/retrying
    this.retryAttempts = new Map();  // issue_id -> retry entry
    this.completed = new Set();      // issue IDs (bookkeeping only)
    this.codexTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    };
    this.codexRateLimits = null;
    this.tickTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    const settings = this.deps.config();
    validateDispatchConfig(settings);

    this.pollIntervalMs = settings.polling?.interval_ms ?? 30_000;
    this.maxConcurrentAgents = settings.agent?.max_concurrent_agents ?? 10;

    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  stop() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Cancel all retry timers
    for (const [issueId, entry] of this.retryAttempts) {
      if (entry.timerHandle) {
        clearTimeout(entry.timerHandle);
      }
    }
    this.retryAttempts.clear();
  }

  // ---------------------------------------------------------------------------
  // Tick scheduling
  // ---------------------------------------------------------------------------

  scheduleTick(delayMs) {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    const delay = typeof delayMs === 'number' ? delayMs : this.pollIntervalMs;
    this.tickTimer = setTimeout(() => this.onTick(), delay);
  }

  async onTick() {
    try {
      // 1. Reconcile running issues
      await this.reconcileRunningIssues();

      // 2. Validate dispatch config
      const settings = this.deps.config();
      try {
        validateDispatchConfig(settings);
      } catch (err) {
        logger.error('Dispatch config validation failed, skipping dispatch', {
          error: err.message,
        });
        this.scheduleTick(this.pollIntervalMs);
        return;
      }

      this.pollIntervalMs = settings.polling?.interval_ms ?? 30_000;
      this.maxConcurrentAgents = settings.agent?.max_concurrent_agents ?? 10;

      // 3. Fetch candidate issues
      const candidates = await this.deps.tracker.fetchCandidateIssues();

      // 4. Sort by dispatch priority
      candidates.sort((a, b) => {
        // priority asc, null last
        const pA = a.priority ?? Number.MAX_SAFE_INTEGER;
        const pB = b.priority ?? Number.MAX_SAFE_INTEGER;
        if (pA !== pB) return pA - pB;

        // created_at oldest first
        const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (tA !== tB) return tA - tB;

        // identifier lexicographic
        const iA = a.identifier ?? '';
        const iB = b.identifier ?? '';
        return iA.localeCompare(iB);
      });

      // 5. Dispatch eligible candidates
      for (const issue of candidates) {
        if (this.shouldDispatch(issue, settings)) {
          this.dispatchIssue(issue, 1);
        }
      }

      // 6. Emit state change
      this.emit('stateChange', this.getSnapshot());
    } catch (err) {
      logger.error('Tick failed', { error: err.message });
    }

    // 7. Schedule next tick
    this.scheduleTick(this.pollIntervalMs);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  async reconcileRunningIssues() {
    const settings = this.deps.config();
    const stallTimeoutMs = settings.codex?.stall_timeout_ms ?? 300_000;

    // Part A - Stall detection
    const now = Date.now();
    for (const [issueId, entry] of this.running) {
      const lastActivity = entry.lastCodexTimestamp
        ? new Date(entry.lastCodexTimestamp).getTime()
        : new Date(entry.startedAt).getTime();
      const elapsed = now - lastActivity;

      if (stallTimeoutMs > 0 && elapsed > stallTimeoutMs) {
        logger.warn('Stall detected, terminating worker', {
          issue_id: issueId,
          identifier: entry.identifier,
          elapsed_ms: elapsed,
          stall_timeout_ms: stallTimeoutMs,
        });
        await this.terminateWorker(issueId);
        this.scheduleRetry(issueId, (entry.retryAttempt ?? 0) + 1, {
          identifier: entry.identifier,
          error: 'Stall timeout exceeded',
        });
      }
    }

    // Part B - Tracker state refresh
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;

    let freshIssues;
    try {
      freshIssues = await this.deps.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      // If fetch fails, keep workers running
      logger.warn('Failed to refresh running issue states, keeping workers', {
        error: err.message,
      });
      return;
    }

    const freshMap = new Map();
    for (const issue of freshIssues) {
      freshMap.set(issue.id, issue);
    }

    const terminalStates = new Set(
      settings.tracker?.terminal_states ?? []
    );
    const activeStates = new Set(
      settings.tracker?.active_states ?? []
    );

    for (const issueId of runningIds) {
      // The entry may have been removed by stall detection above
      if (!this.running.has(issueId)) continue;

      const fresh = freshMap.get(issueId);
      const entry = this.running.get(issueId);

      if (!fresh) {
        // Issue not found in tracker response - terminate without cleanup
        logger.warn('Running issue not found in tracker, terminating', {
          issue_id: issueId,
          identifier: entry.identifier,
        });
        await this.terminateWorker(issueId);
        this.claimed.delete(issueId);
        continue;
      }

      if (terminalStates.has(fresh.state)) {
        // Terminal state - terminate + clean workspace
        logger.info('Running issue reached terminal state, terminating', {
          issue_id: issueId,
          identifier: entry.identifier,
          state: fresh.state,
        });
        await this.terminateWorker(issueId);
        this.claimed.delete(issueId);
        try {
          await workspace.removeIssueWorkspaces(settings, entry.identifier);
        } catch (err) {
          logger.warn('Failed to remove workspace for terminal issue', {
            issue_id: issueId,
            identifier: entry.identifier,
            error: err.message,
          });
        }
      } else if (activeStates.has(fresh.state)) {
        // Still active - update in-memory snapshot
        entry.issue = fresh;
      } else {
        // Neither active nor terminal - terminate without cleanup
        logger.warn('Running issue in unexpected state, terminating', {
          issue_id: issueId,
          identifier: entry.identifier,
          state: fresh.state,
        });
        await this.terminateWorker(issueId);
        this.claimed.delete(issueId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch eligibility
  // ---------------------------------------------------------------------------

  shouldDispatch(issue, settings) {
    // Required fields
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }

    const activeStates = new Set(settings.tracker?.active_states ?? []);
    const terminalStates = new Set(settings.tracker?.terminal_states ?? []);

    // State must be active and not terminal
    if (!activeStates.has(issue.state)) return false;
    if (terminalStates.has(issue.state)) return false;

    // Not already running or claimed
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id)) return false;

    // Global concurrency slots
    if (this.running.size >= this.maxConcurrentAgents) return false;

    // Per-state concurrency slots
    const maxForState = maxConcurrentAgentsForState(settings, issue.state);
    let countInState = 0;
    for (const [, entry] of this.running) {
      if (entry.issue?.state === issue.state) {
        countInState++;
      }
    }
    if (countInState >= maxForState) return false;

    // Blocker rule for "todo" state: no non-terminal blockers
    if (issue.state.toLowerCase() === 'todo' && Array.isArray(issue.blocked_by)) {
      const hasNonTerminalBlocker = issue.blocked_by.some(
        (blocker) => !terminalStates.has(blocker.state)
      );
      if (hasNonTerminalBlocker) return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  dispatchIssue(issue, attempt) {
    const issueId = issue.id;
    const identifier = issue.identifier;

    // 1. Add to claimed set
    this.claimed.add(issueId);

    // 2. Remove from retry_attempts
    if (this.retryAttempts.has(issueId)) {
      const existing = this.retryAttempts.get(issueId);
      if (existing.timerHandle) {
        clearTimeout(existing.timerHandle);
      }
      this.retryAttempts.delete(issueId);
    }

    logger.info('Dispatching issue', {
      issue_id: issueId,
      identifier,
      attempt,
    });

    // 3. Start worker via agentRunner
    const onMessage = (message) => this.handleCodexUpdate(issueId, message);
    const workerPromise = this.deps.agentRunner.run(issue, attempt, onMessage);

    // 4. Add to running map
    this.running.set(issueId, {
      workerPromise,
      identifier,
      issue,
      sessionId: null,
      codexAppServerPid: null,
      lastCodexMessage: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      retryAttempt: attempt,
      startedAt: new Date(),
      turnCount: 0,
    });

    // 5. Handle worker completion
    workerPromise
      .then(() => {
        this.onWorkerExit(issueId, 'normal');
      })
      .catch((err) => {
        logger.error('Worker failed', {
          issue_id: issueId,
          identifier,
          error: err.message,
        });
        this.onWorkerExit(issueId, 'abnormal', err);
      });

    this.emit('stateChange', this.getSnapshot());
  }

  // ---------------------------------------------------------------------------
  // Worker exit handling
  // ---------------------------------------------------------------------------

  onWorkerExit(issueId, reason, error) {
    const entry = this.running.get(issueId);
    if (!entry) return;

    // Remove from running
    this.running.delete(issueId);

    // Add runtime seconds to totals
    const elapsed = (Date.now() - new Date(entry.startedAt).getTime()) / 1000;
    this.codexTotals.secondsRunning += elapsed;

    if (reason === 'normal') {
      // Add to completed
      this.completed.add(issueId);

      logger.info('Worker exited normally, scheduling continuation retry', {
        issue_id: issueId,
        identifier: entry.identifier,
      });

      // Schedule continuation retry (attempt=1, delay=1s)
      this.scheduleRetry(issueId, 1, {
        identifier: entry.identifier,
        error: null,
        continuation: true,
      });
    } else {
      // Abnormal exit - schedule exponential backoff retry
      const nextAttempt = (entry.retryAttempt ?? 0) + 1;

      logger.warn('Worker exited abnormally, scheduling backoff retry', {
        issue_id: issueId,
        identifier: entry.identifier,
        attempt: nextAttempt,
        error: error?.message,
      });

      this.scheduleRetry(issueId, nextAttempt, {
        identifier: entry.identifier,
        error: error?.message ?? 'Unknown error',
      });
    }

    this.emit('stateChange', this.getSnapshot());
  }

  // ---------------------------------------------------------------------------
  // Retry scheduling
  // ---------------------------------------------------------------------------

  scheduleRetry(issueId, attempt, opts = {}) {
    const settings = this.deps.config();
    const maxBackoff = settings.agent?.max_retry_backoff_ms ?? 300_000;

    // Cancel existing retry timer for same issue
    if (this.retryAttempts.has(issueId)) {
      const existing = this.retryAttempts.get(issueId);
      if (existing.timerHandle) {
        clearTimeout(existing.timerHandle);
      }
    }

    // Calculate delay
    let delayMs;
    if (opts.continuation) {
      // Continuation after normal exit
      delayMs = 1000;
    } else {
      // Failure: exponential backoff
      delayMs = Math.min(10_000 * Math.pow(2, attempt - 1), maxBackoff);
    }

    const dueAtMs = Date.now() + delayMs;
    const timerHandle = setTimeout(() => this.onRetryTimer(issueId), delayMs);

    this.retryAttempts.set(issueId, {
      attempt,
      identifier: opts.identifier ?? null,
      error: opts.error ?? null,
      dueAtMs,
      timerHandle,
    });

    logger.info('Retry scheduled', {
      issue_id: issueId,
      identifier: opts.identifier,
      attempt,
      delay_ms: delayMs,
      continuation: !!opts.continuation,
    });
  }

  async onRetryTimer(issueId) {
    // 1. Pop retry entry
    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) return;
    this.retryAttempts.delete(issueId);

    const attempt = retryEntry.attempt;
    const identifier = retryEntry.identifier;

    logger.info('Retry timer fired', {
      issue_id: issueId,
      identifier,
      attempt,
    });

    try {
      // 2. Fetch candidate issues
      const candidates = await this.deps.tracker.fetchCandidateIssues();

      // 3. Find issue by ID
      const issue = candidates.find((c) => c.id === issueId);

      if (!issue) {
        // 4. Not found - release claim
        logger.info('Retry: issue not found in candidates, releasing claim', {
          issue_id: issueId,
          identifier,
        });
        this.claimed.delete(issueId);
        this.emit('stateChange', this.getSnapshot());
        return;
      }

      const settings = this.deps.config();
      const activeStates = new Set(settings.tracker?.active_states ?? []);

      if (!activeStates.has(issue.state)) {
        // 6. Found but not active - release claim
        logger.info('Retry: issue not in active state, releasing claim', {
          issue_id: issueId,
          identifier,
          state: issue.state,
        });
        this.claimed.delete(issueId);
        this.emit('stateChange', this.getSnapshot());
        return;
      }

      // 5. Found and eligible - dispatch if slots available
      if (this.running.size < this.maxConcurrentAgents) {
        this.dispatchIssue(issue, attempt);
      } else {
        // Requeue - schedule another retry
        logger.info('Retry: no slots available, requeuing', {
          issue_id: issueId,
          identifier,
          attempt,
        });
        this.scheduleRetry(issueId, attempt, {
          identifier,
          error: retryEntry.error,
        });
      }
    } catch (err) {
      logger.error('Retry timer handler failed', {
        issue_id: issueId,
        identifier,
        error: err.message,
      });
      // Requeue on failure
      this.scheduleRetry(issueId, attempt, {
        identifier,
        error: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Codex update handling
  // ---------------------------------------------------------------------------

  handleCodexUpdate(issueId, message) {
    const entry = this.running.get(issueId);
    if (!entry) return;

    // Update running entry with latest event data
    entry.lastCodexMessage = message;
    entry.lastCodexEvent = message?.type ?? message?.event ?? null;
    entry.lastCodexTimestamp = new Date();

    // Extract token counts from usage fields
    const usage = message?.usage ?? message?.message?.usage ?? null;
    if (usage) {
      if (typeof usage.input_tokens === 'number') {
        entry.inputTokens += usage.input_tokens;
        this.codexTotals.inputTokens += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number') {
        entry.outputTokens += usage.output_tokens;
        this.codexTotals.outputTokens += usage.output_tokens;
      }
      const totalDelta =
        (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
        (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
      if (totalDelta > 0) {
        entry.totalTokens += totalDelta;
        this.codexTotals.totalTokens += totalDelta;
      }
    }

    // Track rate limits
    const rateLimits = message?.rate_limits ?? message?.rateLimits ?? null;
    if (rateLimits) {
      this.codexRateLimits = rateLimits;
    }

    // Track turn count
    if (message?.type === 'turn_complete' || message?.event === 'turn_complete') {
      entry.turnCount++;
    }
  }

  // ---------------------------------------------------------------------------
  // Worker termination
  // ---------------------------------------------------------------------------

  async terminateWorker(issueId) {
    const entry = this.running.get(issueId);
    if (!entry) return;

    logger.info('Terminating worker', {
      issue_id: issueId,
      identifier: entry.identifier,
    });

    // Remove from running
    this.running.delete(issueId);

    // Add runtime seconds to totals
    const elapsed = (Date.now() - new Date(entry.startedAt).getTime()) / 1000;
    this.codexTotals.secondsRunning += elapsed;

    // Attempt to cancel the worker promise if possible
    try {
      if (entry.workerPromise && typeof entry.workerPromise.cancel === 'function') {
        entry.workerPromise.cancel();
      }
    } catch (err) {
      logger.warn('Failed to cancel worker promise', {
        issue_id: issueId,
        error: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot for API/dashboard
  // ---------------------------------------------------------------------------

  getSnapshot() {
    const runningArr = [];
    for (const [issueId, entry] of this.running) {
      runningArr.push({
        issueId,
        identifier: entry.identifier,
        state: entry.issue?.state ?? null,
        startedAt: entry.startedAt,
        retryAttempt: entry.retryAttempt,
        turnCount: entry.turnCount,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        lastCodexEvent: entry.lastCodexEvent,
        lastCodexTimestamp: entry.lastCodexTimestamp,
      });
    }

    const retryingArr = [];
    for (const [issueId, entry] of this.retryAttempts) {
      retryingArr.push({
        issueId,
        identifier: entry.identifier,
        attempt: entry.attempt,
        error: entry.error,
        dueAtMs: entry.dueAtMs,
      });
    }

    return {
      running: runningArr,
      retrying: retryingArr,
      codexTotals: { ...this.codexTotals },
      rateLimits: this.codexRateLimits,
    };
  }

  // ---------------------------------------------------------------------------
  // Startup terminal cleanup
  // ---------------------------------------------------------------------------

  async startupTerminalCleanup() {
    const settings = this.deps.config();
    const terminalStates = settings.tracker?.terminal_states ?? [];

    if (terminalStates.length === 0) return;

    try {
      const terminalIssues = await this.deps.tracker.fetchIssuesByStates(terminalStates);

      for (const issue of terminalIssues) {
        try {
          await workspace.removeIssueWorkspaces(settings, issue.identifier);
          logger.info('Cleaned up terminal issue workspace', {
            issue_id: issue.id,
            identifier: issue.identifier,
            state: issue.state,
          });
        } catch (err) {
          logger.warn('Failed to clean up terminal workspace', {
            issue_id: issue.id,
            identifier: issue.identifier,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch terminal issues for cleanup', {
        error: err.message,
      });
    }
  }
}

export default Orchestrator;
