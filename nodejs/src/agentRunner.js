import logger from './logger.js';
import * as workspace from './workspace.js';
import * as appServer from './claude/appServer.js';
import { buildPrompt } from './promptBuilder.js';

/**
 * Build the prompt for a given turn.
 *
 * Turn 1 renders the full workflow template via promptBuilder.
 * Subsequent turns return continuation guidance so the agent resumes
 * rather than restarts.
 *
 * @param {string} template - Liquid prompt template from the workflow.
 * @param {object} issue - Issue object from the tracker.
 * @param {number|null} attempt - Current attempt number.
 * @param {number} turnNumber - 1-based turn index.
 * @param {number} maxTurns - Maximum turns allowed for this run.
 * @returns {Promise<string>}
 */
async function buildTurnPrompt(template, issue, attempt, turnNumber, maxTurns) {
  if (turnNumber === 1) {
    return buildPrompt(template, issue, attempt);
  }

  return [
    'Continuation guidance:',
    '',
    '- The previous turn completed normally, but the Linear issue is still in an active state.',
    `- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.`,
    '- Resume from the current workspace state instead of restarting from scratch.',
    '- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.',
    '- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.',
  ].join('\n');
}

/**
 * Create an agent runner bound to the given dependencies.
 *
 * @param {object} deps
 * @param {object} deps.workflowStore - Workflow store (getCurrent()).
 * @param {function} deps.config - getSettings() function returning current settings.
 * @param {object} deps.tracker - Issue tracker with fetchIssueStatesByIds().
 * @returns {{ run: Function, buildTurnPrompt: Function }}
 */
export function createAgentRunner(deps) {
  const { workflowStore, config, tracker } = deps;

  /**
   * Execute a single issue in its workspace with Claude Code.
   *
   * @param {object} issue - The issue to work on.
   * @param {number|null} attempt - Current attempt number.
   * @param {function} [onMessage] - Callback for streaming events.
   */
  async function run(issue, attempt, onMessage) {
    const issueCtx = { issue_id: issue.id, issue_identifier: issue.identifier };
    const msgCallback = typeof onMessage === 'function' ? onMessage : () => {};

    const settings = config();
    logger.info('Agent run starting', issueCtx);

    // 1. Create or reuse workspace
    const ws = await workspace.createForIssue(settings, issue);
    const workspacePath = ws.path;
    logger.info('Workspace ready', { ...issueCtx, workspace: workspacePath, created: ws.createdNow });

    // 2. Run before_run hook (failure throws so orchestrator retries)
    logger.info('Running before_run hook', issueCtx);
    workspace.runBeforeRunHook(settings, workspacePath, issue);

    let session;
    try {
      // 3. Start Claude Code session
      session = appServer.startSession(workspacePath, settings);
      logger.info('Session started', { ...issueCtx, session_id: session.id });

      // 4. Turn loop
      const maxTurns = settings?.agent?.max_turns ?? 20;
      let turnNumber = 1;

      const workflow = workflowStore.getCurrent();
      const template = workflow?.promptTemplate ?? '';

      while (true) {
        logger.info('Starting turn', { ...issueCtx, turn: turnNumber, max_turns: maxTurns });

        // Build prompt for this turn
        const prompt = await buildTurnPrompt(template, issue, attempt, turnNumber, maxTurns);

        // Run the turn — errors propagate to the catch block
        let turnResult;
        try {
          turnResult = await appServer.runTurn(session, prompt, issue, { onMessage: msgCallback });
        } catch (err) {
          logger.error('Turn failed', { ...issueCtx, turn: turnNumber, error: err.message });
          appServer.stopSession(session);
          throw err;
        }

        logger.info('Turn completed', { ...issueCtx, turn: turnNumber, turn_id: turnResult.turnId });

        // Refresh issue state from tracker
        let refreshedIssues;
        try {
          refreshedIssues = await tracker.fetchIssueStatesByIds([issue.id]);
        } catch (err) {
          logger.error('Issue state refresh failed', { ...issueCtx, error: err.message });
          appServer.stopSession(session);
          throw err;
        }

        const refreshedIssue = Array.isArray(refreshedIssues)
          ? refreshedIssues.find(i => i.id === issue.id)
          : null;

        if (refreshedIssue) {
          issue = refreshedIssue;
        }

        const activeStates = (settings.tracker?.active_states ?? []).map(s => s.toLowerCase());
        const currentStateLower = (issue.state || '').toLowerCase();
        if (!activeStates.includes(currentStateLower)) {
          logger.info('Issue no longer active, stopping', { ...issueCtx, state: issue.state });
          break;
        }

        if (turnNumber >= maxTurns) {
          logger.info('Max turns reached', { ...issueCtx, turn: turnNumber, max_turns: maxTurns });
          break;
        }

        turnNumber++;
      }

      // 5. Stop session
      appServer.stopSession(session);
      logger.info('Session stopped', { ...issueCtx, session_id: session.id });
    } finally {
      // 6. Run after_run hook (failure logged, ignored)
      try {
        workspace.runAfterRunHook(settings, workspacePath, issue);
      } catch (err) {
        logger.warn('after_run hook failed', { ...issueCtx, error: err.message });
      }
    }

    logger.info('Agent run finished', issueCtx);
  }

  return {
    run,
    buildTurnPrompt,
  };
}
