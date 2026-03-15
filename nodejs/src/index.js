#!/usr/bin/env node

// Symphony Node.js - CLI entry point
// Usage: symphony [path-to-WORKFLOW.md] [--port <port>]

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import logger from './logger.js';
import { createWorkflowStore } from './workflowStore.js';
import { getSettings, validateDispatchConfig } from './config.js';
import { createTracker } from './tracker/index.js';
import { createAgentRunner } from './agentRunner.js';
import { Orchestrator } from './orchestrator.js';
import { createServer } from './server.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2); // skip node + script
  let workflowPath = null;
  let port = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      i++;
      if (i >= args.length) {
        console.error('Error: --port requires a value');
        process.exit(1);
      }
      port = Number(args[i]);
      if (!Number.isFinite(port) || port <= 0) {
        console.error(`Error: invalid port number: ${args[i]}`);
        process.exit(1);
      }
    } else if (args[i].startsWith('--')) {
      console.error(`Error: unknown flag ${args[i]}`);
      process.exit(1);
    } else {
      workflowPath = args[i];
    }
  }

  return { workflowPath, port };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { workflowPath: explicitPath, port: cliPort } = parseArgs(process.argv);

  // Resolve workflow path
  const workflowPath = explicitPath
    ? resolve(explicitPath)
    : resolve(process.cwd(), 'WORKFLOW.md');

  if (!existsSync(workflowPath)) {
    const message = explicitPath
      ? `Workflow file not found: ${workflowPath}`
      : `No WORKFLOW.md found in current directory (${process.cwd()})`;
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  logger.info('Starting Symphony', { workflow: workflowPath });

  // 1. Start WorkflowStore with file watching
  const workflowStore = createWorkflowStore();
  await workflowStore.start(workflowPath);
  logger.info('Workflow loaded and watching for changes');

  // 2. Derive settings from the workflow config
  const workflow = workflowStore.getCurrent();
  const settings = getSettings(workflow.config);

  // 3. Validate config before proceeding
  validateDispatchConfig(settings);

  // 4. Create tracker
  const tracker = createTracker(settings);
  logger.info('Tracker created', { kind: settings.tracker.kind });

  // 5. Create agent runner
  const agentRunner = createAgentRunner({
    workflowStore,
    config: () => getSettings(workflowStore.getCurrent()?.config),
    tracker,
  });
  logger.info('Agent runner created');

  // 6. Create and start orchestrator
  const configFn = () => getSettings(workflowStore.getCurrent()?.config);
  const orchestrator = new Orchestrator({
    workflowStore,
    tracker,
    agentRunner,
    config: configFn,
    settings,
  });

  await orchestrator.start();
  logger.info('Orchestrator started');

  // 7. Optionally start HTTP server
  const port = cliPort ?? settings.server.port;
  let server = null;

  if (port) {
    server = createServer(orchestrator, port);
    logger.info('HTTP server started', { port });
  }

  // 8. Graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully`);

    try {
      if (server) {
        await server.close();
      }
      await orchestrator.stop();
      await workflowStore.stop();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message });
  console.error(err);
  process.exit(1);
});
