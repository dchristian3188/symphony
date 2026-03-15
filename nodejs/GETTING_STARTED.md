# Getting Started with Symphony (Node.js)

Symphony is an AI-powered orchestration service that polls your Linear issue
tracker, creates isolated workspaces, and dispatches Claude Code agents to
autonomously work on issues.

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js** | v20 or later |
| **Claude Code CLI** | `claude` must be on your PATH ([install guide](https://docs.anthropic.com/en/docs/claude-code/overview)) |
| **Linear API key** | Create one at **Settings > API > Personal API keys** in Linear |

## 1. Install

```bash
cd nodejs
npm install
```

## 2. Set your Linear API key

```bash
export LINEAR_API_KEY=lin_api_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

## 3. Configure your workflow

All configuration lives in a single `WORKFLOW.md` file. It has two parts:

1. **YAML front matter** (between `---` fences) — runtime settings
2. **Markdown body** — the prompt template sent to each agent

Open `WORKFLOW.md` and update the `tracker.project_slug` to match your Linear
project:

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "my-project"        # <-- change this

polling:
  interval_ms: 30000                 # poll every 30 seconds

workspace:
  root: ~/symphony-workspaces        # where per-issue dirs are created

hooks:
  after_create:
    # Uncomment and edit to clone your repo into each workspace:
    # - "git clone git@github.com:myorg/myrepo.git ."
    # - "npm install"

agent:
  max_concurrent_agents: 5           # max parallel agents
  max_turns: 20                      # turns per issue before yielding

codex:
  command: "claude -p --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100"
---
```

The Markdown body below the front matter is a [Liquid](https://liquidjs.com/)
template. It receives `{{ issue }}` context (id, title, state, priority, labels,
description, comments) and `{{ attempt }}` (retry count). Edit the instructions
to match your team's workflow.

## 4. Run Symphony

```bash
# Using the default WORKFLOW.md in the current directory
node src/index.js

# Or specify a workflow file and HTTP port
node src/index.js ./my-workflow.md --port 4000

# Or use npm start
npm start
```

Symphony will:
1. Load and validate your `WORKFLOW.md`
2. Connect to Linear and begin polling for issues in active states
3. Create an isolated workspace for each issue
4. Spawn a Claude Code agent per issue (up to the concurrency limit)
5. Stream agent output and track token usage
6. Retry on failure with exponential backoff

Press `Ctrl+C` for graceful shutdown.

## 5. Dashboard and API

Pass `--port` to enable the HTTP server:

```bash
node src/index.js --port 4000
```

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/v1/state` | Current orchestrator state (running, claimed, retries) |
| `GET /api/v1/workflow` | Active workflow config and prompt |

## 6. Run tests

```bash
npm test
```

This runs all tests under `test/` using the built-in `node:test` runner.

## Key concepts

- **Workflow** — A `WORKFLOW.md` that defines both config and the agent prompt
  template. Supports hot-reload: edit the file while Symphony is running and
  changes take effect on the next poll cycle.

- **Workspace** — An isolated directory created per issue under
  `workspace.root`. Agents operate here, never in your source repo. Hooks let
  you clone repos and install dependencies on creation.

- **Orchestrator** — The central loop that polls Linear, decides which issues to
  dispatch, enforces concurrency limits, and manages retries.

- **Agent Runner** — Spawns `claude` CLI processes, pipes in the rendered
  prompt, and parses streaming JSON output for progress and token usage.

- **Tracker** — Abstraction over Linear's GraphQL API. Fetches issues, updates
  state, posts comments. A `memory` backend is available for testing.

## Example: end-to-end setup

```bash
# 1. Clone your project
git clone https://github.com/yourorg/symphony.git
cd symphony/nodejs

# 2. Install dependencies
npm install

# 3. Export your Linear key
export LINEAR_API_KEY=lin_api_...

# 4. Edit WORKFLOW.md — set project_slug and uncomment hooks
#    to clone your app repo into each workspace

# 5. Start Symphony with the dashboard
node src/index.js --port 4000

# 6. Create an issue in your Linear project — Symphony will pick it up
#    on the next poll cycle and dispatch an agent to work on it

# 7. Monitor at http://localhost:4000/api/v1/state
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `Error: No WORKFLOW.md found` | Run from the `nodejs/` dir or pass an explicit path |
| `Error: tracker.api_key is required` | Export `LINEAR_API_KEY` before starting |
| `Error: tracker.project_slug is required` | Set `project_slug` in your WORKFLOW.md front matter |
| Agent never starts | Verify `claude` is on your PATH: `which claude` |
| Issues not picked up | Check that `project_slug` matches your Linear project and issues are in an active state (e.g. "Todo") |

## Further reading

- [Full specification](../SPEC.md) — language-agnostic design doc
- [Node.js README](./README.md) — architecture and integration details
- [Elixir README](../elixir/README.md) — reference implementation with OTP
