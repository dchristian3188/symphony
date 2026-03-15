/**
 * Dynamic tool execution for client-side tools.
 * Currently supports the "linear_graphql" tool for executing
 * GraphQL queries against the Linear API.
 */

/**
 * Execute a client-side tool by name.
 *
 * @param {string} toolName - The name of the tool to execute
 * @param {object} args - The arguments for the tool
 * @param {object} settings - Configuration settings (includes linear endpoint/auth)
 * @returns {Promise<{ success: boolean, output?: string, contentItems?: Array, error?: string }>}
 */
export async function execute(toolName, args, settings) {
  switch (toolName) {
    case "linear_graphql":
      return executeLinearGraphQL(args, settings);

    default:
      return {
        success: false,
        error: "unsupported_tool_call",
      };
  }
}

/**
 * Validate that a GraphQL query string contains a single operation.
 * Rejects multiple operations to prevent query batching attacks.
 *
 * @param {string} query - The GraphQL query string
 * @returns {boolean}
 */
function validateSingleOperation(query) {
  // Count top-level operation keywords (query, mutation, subscription)
  // that appear at the start of a line or after a closing brace
  const operationPattern =
    /(?:^|\})\s*(?:query|mutation|subscription)\b/gi;
  const matches = query.match(operationPattern);

  // Allow unnamed queries (just `{ ... }`) as a single operation
  if (!matches) {
    // Check if it's a shorthand query (just `{ field { ... } }`)
    const trimmed = query.trim();
    if (trimmed.startsWith("{")) {
      return true;
    }
    return false;
  }

  return matches.length <= 1;
}

/**
 * Execute a GraphQL query against the Linear API.
 *
 * @param {object} args - { query: string, variables?: object }
 * @param {object} settings - Must include linear.endpoint and linear.api_key
 * @returns {Promise<{ success: boolean, output?: string, contentItems?: Array, error?: string }>}
 */
async function executeLinearGraphQL(args, settings) {
  const { query, variables } = args || {};

  // Validate query is a non-empty string
  if (!query || typeof query !== "string" || query.trim() === "") {
    return {
      success: false,
      error: "Query must be a non-empty string",
    };
  }

  // Validate single GraphQL operation
  if (!validateSingleOperation(query)) {
    return {
      success: false,
      error: "Query must contain a single GraphQL operation",
    };
  }

  const endpoint =
    settings?.linear?.endpoint || "https://api.linear.app/graphql";
  const apiKey = settings?.linear?.api_key;

  if (!apiKey) {
    return {
      success: false,
      error: "Linear API key is not configured",
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query,
        variables: variables || undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Linear API returned ${response.status}: ${text}`,
      };
    }

    const data = await response.json();

    if (data.errors && data.errors.length > 0) {
      return {
        success: false,
        output: JSON.stringify(data, null, 2),
        error: data.errors.map((e) => e.message).join("; "),
      };
    }

    const output = JSON.stringify(data.data, null, 2);

    return {
      success: true,
      output,
      contentItems: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  } catch (err) {
    return {
      success: false,
      error: `Linear GraphQL request failed: ${err.message}`,
    };
  }
}
