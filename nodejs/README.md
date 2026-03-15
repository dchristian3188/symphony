# Symphony (Node.js)

A Node.js port of the Symphony orchestration service that polls Linear for
issues and dispatches Claude Code agents to work on them in isolated workspaces.

## Key Differences from the Elixir Reference

- **Claude Code CLI** instead of the Codex app-server. Agents are spawned via
  `claude -p --output-format stream-json --dangerously-skip-permissions`.
- **Node.js 20+** with ES modules (`"type": "module"` in package.json).
- Express-based HTTP server for health checks and status endpoints.
- Single-process, event-driven architecture (no OTP supervision tree).

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 20+ |
| Claude Code CLI | Latest (`claude` on PATH) |
| Linear API key | Provided via `LINEAR_API_KEY` env var |

## Quick Start

```bash
cd nodejs
npm install
export LINEAR_API_KEY=your-key
node src/index.js [path-to-WORKFLOW.md] [--port 4000]
```

If no workflow path is given, the default `WORKFLOW.md` in the current directory
is used. The `--port` flag sets the HTTP server port (default: 4000).

## Configuration

All configuration lives in the YAML front matter of your `WORKFLOW.md` file.
See the [main spec](../SPEC.md) for the full schema. Key sections:

- **tracker** - issue tracker kind, API key, project slug
- **polling** - interval between poll cycles
- **workspace** - root directory for isolated agent workspaces
- **hooks** - shell commands to run after workspace creation
- **agent** - concurrency limits and turn budget
- **codex** - the CLI command template used to invoke Claude Code

Environment variables in values (e.g. `$LINEAR_API_KEY`) are expanded at
runtime.

## Architecture

```
src/
├── index.js          CLI entry point; parses args, wires dependencies, starts server
├── orchestrator.js   Poll loop, dispatch, retry logic, concurrency control
├── agentRunner.js    Spawns Claude Code CLI processes and streams their output
├── config.js         Reads and validates settings from workflow front matter
├── workflow.js       Parses WORKFLOW.md (YAML front matter + Liquid prompt body)
├── workflowStore.js  Holds the current workflow; supports hot-reload via chokidar
├── promptBuilder.js  Renders the Liquid prompt template with issue context
├── workspace.js      Creates and manages isolated per-issue working directories
├── server.js         Express HTTP server (health, status, workflow endpoints)
├── logger.js         Structured logging utility
├── tracker/
│   ├── index.js      Tracker factory (selects backend by kind)
│   ├── linear.js     Linear GraphQL client (poll issues, update state, post comments)
│   └── memory.js     In-memory tracker for testing
└── claude/
    ├── appServer.js   Claude Code process management and streaming JSON parser
    └── dynamicTool.js MCP dynamic tool registration for agent sessions
```

### Request Flow

1. **Orchestrator** ticks on the configured polling interval.
2. Each tick calls the **Tracker** to fetch issues in the "ready" state.
3. For each issue (up to the concurrency limit), a **Workspace** is created.
4. The **PromptBuilder** renders the Liquid template with the issue context.
5. The **AgentRunner** spawns a `claude` CLI process in the workspace.
6. Streaming JSON output is parsed for progress, token usage, and results.
7. On completion the orchestrator updates the issue via the tracker.

## Claude Code Integration

This implementation invokes Claude Code through its CLI rather than an
app-server. The default command is:

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100
```

The prompt is piped to stdin. The `--output-format stream-json` flag produces
newline-delimited JSON events that the agent runner parses in real time for
progress updates and token accounting.

The `--dangerously-skip-permissions` flag is required for unattended operation
since there is no human to approve tool calls. The `--max-turns` flag prevents
runaway agent loops.

You can override this command in the `codex.command` field of your workflow
front matter.

## Development

```bash
# Run tests
npm test

# Run with a custom workflow
node src/index.js ./my-workflow.md --port 3000
```

## License

See the repository root for license information.
