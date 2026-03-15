---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "my-project"

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create:
    # - "git clone git@github.com:myorg/myrepo.git ."
    # - "npm install"

agent:
  max_concurrent_agents: 5
  max_turns: 20

codex:
  command: "claude -p --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 100"
---

You are an autonomous coding agent. You have been assigned the following issue
from the project's Linear tracker.

## Issue Details

- **ID:** {{ issue.id }}
- **Title:** {{ issue.title }}
- **State:** {{ issue.state }}
- **Priority:** {{ issue.priority }}
- **Labels:** {{ issue.labels | join: ", " }}

{% if issue.description %}
## Description

{{ issue.description }}
{% endif %}

{% if issue.comments and issue.comments.size > 0 %}
## Comments

{% for comment in issue.comments %}
**{{ comment.author }}** ({{ comment.created_at }}):
{{ comment.body }}

{% endfor %}
{% endif %}

## Instructions

1. Read the issue description and any comments carefully.
2. Explore the codebase to understand the relevant files and architecture.
3. Implement the requested changes. Write clean, well-structured code that
   follows the existing conventions in the repository.
4. Add or update tests to cover your changes where appropriate.
5. Make sure existing tests still pass.
6. Commit your changes with a clear, descriptive commit message that references
   the issue ID.

If the issue is unclear or you are blocked, leave a comment explaining what you
need and mark the issue as needing clarification.
