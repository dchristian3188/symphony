import express from 'express';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// Dashboard HTML template
// ---------------------------------------------------------------------------

function renderDashboard(state) {
  const { counts, running, retrying, codex_totals } = state;

  const runningRows = running
    .map(
      (s) => `
      <tr>
        <td>${esc(s.issue_identifier)}</td>
        <td>${esc(s.state)}</td>
        <td>${esc(s.session_id ?? '-')}</td>
        <td>${s.turn_count ?? 0}</td>
        <td>${esc(s.last_message ?? '-')}</td>
        <td>${s.tokens?.total_tokens ?? 0}</td>
        <td>${esc(s.started_at ?? '-')}</td>
      </tr>`,
    )
    .join('\n');

  const retryRows = retrying
    .map(
      (r) => `
      <tr>
        <td>${esc(r.issue_identifier)}</td>
        <td>${r.attempt}</td>
        <td>${esc(r.due_at ?? '-')}</td>
        <td>${esc(r.error ?? '-')}</td>
      </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #fafafa; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #ddd; }
    th { background: #f0f0f0; }
    .counts { display: flex; gap: 2rem; margin-bottom: 1.5rem; }
    .counts div { padding: 0.75rem 1.25rem; background: #fff; border: 1px solid #ddd; border-radius: 6px; }
    .counts .label { font-size: 0.8rem; color: #666; }
    .counts .value { font-size: 1.5rem; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p class="meta">Generated at ${esc(state.generated_at)} &mdash; auto-refreshes every 10 s</p>

  <div class="counts">
    <div><div class="label">Running</div><div class="value">${counts.running}</div></div>
    <div><div class="label">Retrying</div><div class="value">${counts.retrying}</div></div>
    <div><div class="label">Total tokens</div><div class="value">${codex_totals.total_tokens}</div></div>
    <div><div class="label">Seconds running</div><div class="value">${codex_totals.seconds_running}</div></div>
  </div>

  <h2>Running Sessions</h2>
  ${
    running.length === 0
      ? '<p>No running sessions.</p>'
      : `<table>
    <thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Turns</th><th>Last Message</th><th>Tokens</th><th>Started</th></tr></thead>
    <tbody>${runningRows}</tbody>
  </table>`
  }

  <h2>Retry Queue</h2>
  ${
    retrying.length === 0
      ? '<p>No issues in retry queue.</p>'
      : `<table>
    <thead><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
    <tbody>${retryRows}</tbody>
  </table>`
  }
</body>
</html>`;
}

/** Minimal HTML escaping. */
function esc(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function errorJson(code, message) {
  return { error: { code, message } };
}

function methodNotAllowed(req, res) {
  res.status(405).json(errorJson('method_not_allowed', `Method ${req.method} is not allowed on ${req.path}`));
}

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------

function getStateSnapshot(orchestrator) {
  const snapshot = orchestrator.getSnapshot();

  // Normalize snapshot to API shape
  const running = (snapshot.running || []).map(r => ({
    issue_id: r.issueId ?? r.issue_id,
    issue_identifier: r.identifier ?? r.issue_identifier,
    state: r.state ?? null,
    session_id: r.sessionId ?? r.session_id ?? null,
    turn_count: r.turnCount ?? r.turn_count ?? 0,
    last_event: r.lastCodexEvent ?? r.last_event ?? null,
    last_message: '',
    started_at: r.startedAt instanceof Date ? r.startedAt.toISOString() : r.startedAt ?? null,
    last_event_at: r.lastCodexTimestamp instanceof Date ? r.lastCodexTimestamp.toISOString() : r.lastCodexTimestamp ?? null,
    tokens: {
      input_tokens: r.inputTokens ?? r.tokens?.input_tokens ?? 0,
      output_tokens: r.outputTokens ?? r.tokens?.output_tokens ?? 0,
      total_tokens: r.totalTokens ?? r.tokens?.total_tokens ?? 0,
    },
  }));

  const retrying = (snapshot.retrying || []).map(r => ({
    issue_id: r.issueId ?? r.issue_id,
    issue_identifier: r.identifier ?? r.issue_identifier,
    attempt: r.attempt ?? 0,
    due_at: r.dueAtMs ? new Date(r.dueAtMs).toISOString() : r.due_at ?? null,
    error: r.error ?? null,
  }));

  const totals = snapshot.codexTotals || {};

  return {
    generated_at: new Date().toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    codex_totals: {
      input_tokens: totals.inputTokens ?? totals.input_tokens ?? 0,
      output_tokens: totals.outputTokens ?? totals.output_tokens ?? 0,
      total_tokens: totals.totalTokens ?? totals.total_tokens ?? 0,
      seconds_running: Math.round((totals.secondsRunning ?? totals.seconds_running ?? 0) * 10) / 10,
    },
    rate_limits: snapshot.rateLimits ?? snapshot.rate_limits ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and start an Express HTTP server for the Symphony dashboard and API.
 *
 * @param {object} orchestrator - The Orchestrator instance.
 * @param {number} port - Port to listen on.
 * @returns {{ server: import('http').Server, close: () => Promise<void> }}
 */
export function createServer(orchestrator, port) {
  const app = express();

  app.use(express.json());

  // -- Dashboard ------------------------------------------------------------

  app.get('/', (_req, res) => {
    try {
      const state = getStateSnapshot(orchestrator);
      res.type('html').send(renderDashboard(state));
    } catch (err) {
      logger.error('Dashboard render error', { error: err.message });
      res.status(500).json(errorJson('internal_error', 'Failed to render dashboard'));
    }
  });

  app.all('/', methodNotAllowed);

  // -- GET /api/v1/state ----------------------------------------------------

  app.get('/api/v1/state', (_req, res) => {
    try {
      const state = getStateSnapshot(orchestrator);
      res.json(state);
    } catch (err) {
      logger.error('State endpoint error', { error: err.message });
      res.status(500).json(errorJson('internal_error', 'Failed to retrieve state'));
    }
  });

  app.all('/api/v1/state', methodNotAllowed);

  // -- POST /api/v1/refresh -------------------------------------------------

  app.post('/api/v1/refresh', (_req, res) => {
    try {
      if (typeof orchestrator.scheduleTick === 'function') {
        orchestrator.scheduleTick(0);
      }
      res.status(202).json({ status: 'accepted', message: 'Immediate poll queued' });
    } catch (err) {
      logger.error('Refresh endpoint error', { error: err.message });
      res.status(500).json(errorJson('internal_error', 'Failed to queue refresh'));
    }
  });

  app.all('/api/v1/refresh', methodNotAllowed);

  // -- GET /api/v1/:issueIdentifier -----------------------------------------

  app.get('/api/v1/:issueIdentifier', (req, res) => {
    try {
      const { issueIdentifier } = req.params;
      const state = getStateSnapshot(orchestrator);

      const entry =
        state.running.find((s) => s.issue_identifier === issueIdentifier) ??
        state.retrying.find((r) => r.issue_identifier === issueIdentifier);

      if (!entry) {
        return res.status(404).json(errorJson('not_found', `Issue ${issueIdentifier} not found`));
      }

      res.json(entry);
    } catch (err) {
      logger.error('Issue detail endpoint error', { error: err.message });
      res.status(500).json(errorJson('internal_error', 'Failed to retrieve issue details'));
    }
  });

  app.all('/api/v1/:issueIdentifier', methodNotAllowed);

  // -- Start listening -------------------------------------------------------

  const server = app.listen(port, '127.0.0.1', () => {
    logger.info('Server listening', { address: '127.0.0.1', port });
  });

  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          logger.info('Server closed');
          resolve();
        }
      });
    });
  }

  return { server, close };
}
