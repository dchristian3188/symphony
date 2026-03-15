/**
 * Creates an in-memory tracker adapter for testing.
 *
 * @param {Array} initialIssues - Seed issues to populate the store.
 * @returns {{ fetchCandidateIssues: Function, fetchIssuesByStates: Function, fetchIssueStatesByIds: Function, addIssue: Function, updateIssueState: Function }}
 */
export function createMemoryTracker(initialIssues = []) {
  const issues = new Map();

  for (const issue of initialIssues) {
    issues.set(issue.id, { ...issue });
  }

  async function fetchCandidateIssues() {
    return Array.from(issues.values()).map((issue) => ({ ...issue }));
  }

  async function fetchIssuesByStates(stateNames) {
    const states = new Set(stateNames);
    return Array.from(issues.values())
      .filter((issue) => states.has(issue.state))
      .map((issue) => ({ ...issue }));
  }

  async function fetchIssueStatesByIds(issueIds) {
    const idSet = new Set(issueIds);
    return Array.from(issues.values())
      .filter((issue) => idSet.has(issue.id))
      .map((issue) => ({ ...issue }));
  }

  function addIssue(issue) {
    issues.set(issue.id, { ...issue });
  }

  function updateIssueState(issueId, newState) {
    const issue = issues.get(issueId);
    if (issue) {
      issue.state = newState;
    }
  }

  return {
    fetchCandidateIssues,
    fetchIssuesByStates,
    fetchIssueStatesByIds,
    addIssue,
    updateIssueState,
  };
}
