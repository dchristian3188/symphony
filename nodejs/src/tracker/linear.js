const LINEAR_API_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const RELATION_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

const CANDIDATE_ISSUES_QUERY = `
query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes { type issue { id identifier state { name } } }
      }
      createdAt updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();

const ISSUES_BY_ID_QUERY = `
query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes { type issue { id identifier state { name } } }
      }
      createdAt updatedAt
    }
  }
}
`.trim();

/**
 * Normalize a raw Linear issue node into a standard Issue object.
 */
function normalizeIssue(node) {
  const priority =
    typeof node.priority === "number" && Number.isInteger(node.priority)
      ? node.priority
      : null;

  const labels = (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase());

  const blockedBy = (node.inverseRelations?.nodes ?? [])
    .filter((rel) => rel.type === "blocks")
    .map((rel) => ({
      id: rel.issue.id,
      identifier: rel.issue.identifier,
      state: rel.issue.state.name,
    }));

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    priority,
    state: node.state?.name ?? null,
    branch_name: node.branchName ?? null,
    url: node.url,
    labels,
    blocked_by: blockedBy,
    created_at: new Date(node.createdAt),
    updated_at: new Date(node.updatedAt),
  };
}

/**
 * Execute a GraphQL request against the Linear API.
 */
async function linearRequest(endpoint, apiKey, query, variables) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const error = new Error(`Linear API request failed: ${err.message}`);
    error.category = "linear_api_request";
    error.cause = err;
    throw error;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(
      `Linear API returned HTTP ${response.status}: ${body}`,
    );
    error.category = "linear_api_status";
    throw error;
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    const error = new Error(`Failed to parse Linear API response as JSON`);
    error.category = "linear_unknown_payload";
    error.cause = err;
    throw error;
  }

  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join("; ");
    const error = new Error(`Linear GraphQL errors: ${messages}`);
    error.category = "linear_graphql_errors";
    error.graphqlErrors = json.errors;
    throw error;
  }

  if (!json.data) {
    const error = new Error(`Linear API response missing data field`);
    error.category = "linear_unknown_payload";
    throw error;
  }

  return json.data;
}

/**
 * Creates a Linear tracker client.
 *
 * @param {object} settings - Symphony settings.
 * @param {object} settings.tracker - Tracker config with api_key, project_slug, active_states.
 * @returns {{ fetchCandidateIssues: Function, fetchIssuesByStates: Function, fetchIssueStatesByIds: Function }}
 */
export function createLinearClient(settings) {
  const { api_key, project_slug, active_states, endpoint } = settings.tracker;
  const apiEndpoint = endpoint || LINEAR_API_URL;

  async function fetchIssuesWithStates(stateNames) {
    const allNodes = [];
    let after = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables = {
        projectSlug: project_slug,
        stateNames,
        first: PAGE_SIZE,
        relationFirst: RELATION_PAGE_SIZE,
        ...(after != null ? { after } : {}),
      };

      const data = await linearRequest(apiEndpoint, api_key, CANDIDATE_ISSUES_QUERY, variables);
      const issues = data.issues;

      if (!issues?.nodes) {
        const error = new Error("Linear API response missing issues.nodes");
        error.category = "linear_unknown_payload";
        throw error;
      }

      allNodes.push(...issues.nodes);
      hasNextPage = issues.pageInfo?.hasNextPage ?? false;

      if (hasNextPage) {
        if (!issues.pageInfo?.endCursor) {
          const error = new Error(
            "Linear API indicated hasNextPage but no endCursor provided",
          );
          error.category = "linear_missing_end_cursor";
          throw error;
        }
        after = issues.pageInfo.endCursor;
      }
    }

    return allNodes.map(normalizeIssue);
  }

  async function fetchCandidateIssues() {
    return fetchIssuesWithStates(active_states);
  }

  async function fetchIssuesByStates(stateNames) {
    return fetchIssuesWithStates(stateNames);
  }

  async function fetchIssueStatesByIds(issueIds) {
    if (!issueIds || issueIds.length === 0) {
      return [];
    }

    const variables = {
      ids: issueIds,
      first: issueIds.length,
      relationFirst: RELATION_PAGE_SIZE,
    };

    const data = await linearRequest(apiEndpoint, api_key, ISSUES_BY_ID_QUERY, variables);
    const issues = data.issues;

    if (!issues?.nodes) {
      const error = new Error("Linear API response missing issues.nodes");
      error.category = "linear_unknown_payload";
      throw error;
    }

    return issues.nodes.map(normalizeIssue);
  }

  return {
    fetchCandidateIssues,
    fetchIssuesByStates,
    fetchIssueStatesByIds,
  };
}
