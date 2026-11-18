const fs = require('node:fs');
const { LINEAR_STATUSES, linearScopeId } = require('./linearModel.mjs');

const ENDPOINT = 'https://api.linear.app/graphql';
const ISSUE_ID = /^[\w-]{1,128}$/;
const ISSUE_IDENTIFIER = /^[a-z\d][a-z\d_-]{0,110}-\d{1,16}$/i;
const STATE_FIELDS = 'id name type';
const ISSUE_FIELDS = `id identifier title priority updatedAt state { ${STATE_FIELDS} }
  team { id } project { id } assignee { name displayName avatarUrl }`;
const ISSUE_LIST = `query OrchestraIssues($filter: IssueFilter!, $after: String, $project: String!, $team: String!, $hasProject: Boolean!, $hasTeam: Boolean!) {
  issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
  project(id: $project) @include(if: $hasProject) { name }
  team(id: $team) @include(if: $hasTeam) { name }
}`;
const ISSUE_WORKFLOW = `query OrchestraIssueWorkflow($id: String!, $after: String, $includeIssue: Boolean!) {
  issue(id: $id) {
    state @include(if: $includeIssue) { ${STATE_FIELDS} }
    team { states(first: 100, after: $after) { nodes { ${STATE_FIELDS} position } pageInfo { hasNextPage endCursor } } }
  }
}`;
const UPDATE_STATUS = `mutation OrchestraIssueStatus($id: String!, $state: String!) {
  issueUpdate(id: $id, input: { stateId: $state }) { success issue { ${ISSUE_FIELDS} } }
}`;

function statusOf(state) {
  switch (state?.type) {
    case 'triage': case 'backlog': case 'unstarted': return 'todo';
    case 'completed': return 'done';
    case 'started': {
      const name = typeof state.name === 'string' ? state.name.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('_', ' ') : '';
      return /\b(review|qa|testing|verification|validation|relecture|revision|recette)\b/i.test(name) ? 'inReview' : 'inProgress';
    }
    default: return null;
  }
}

function stateForStatus(states, status) {
  const matches = states.filter((state) => statusOf(state) === status).sort((a, b) => a.position - b.position);
  if (status !== 'todo') return matches[0];
  return matches.find((state) => state.type === 'unstarted') ?? matches.find((state) => state.type === 'backlog') ?? matches[0];
}

function avatarUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

function normalizeIssue(issue) {
  if (typeof issue?.id !== 'string' || !ISSUE_ID.test(issue.id) || typeof issue.title !== 'string' ||
    typeof issue.identifier !== 'string' || !ISSUE_IDENTIFIER.test(issue.identifier)) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    priority: [1, 2, 3, 4].includes(issue.priority) ? issue.priority : 0,
    status: statusOf(issue.state),
    stateName: issue.state?.name ?? '',
    updatedAt: issue.updatedAt,
    projectId: issue.project?.id ?? '',
    teamId: issue.team?.id ?? '',
    assignee: issue.assignee ? {
      name: issue.assignee.displayName || issue.assignee.name,
      avatarUrl: avatarUrl(issue.assignee.avatarUrl),
    } : null,
  };
}

// Claude Code and Codex send canonical MCP names in PostToolUse. The official server uses save_issue.
function isLinearIssueChange(payload) {
  if (payload?.hook_event_name !== 'PostToolUse' || typeof payload.tool_name !== 'string') return false;
  if (payload.tool_response?.isError === true || payload.tool_response?.is_error === true) return false;
  return /^(?:linear_(?:create|update|save)_issue|mcp__[\w.-]*linear[\w.-]*__(?:linear_)?(?:create|update|save)_issue)$/i.test(payload.tool_name);
}

function createLinearCredentials(file, safeStorage) {
  let current;
  let saving = Promise.resolve();
  async function decrypt() {
    try {
      const encrypted = fs.readFileSync(file());
      return (await safeStorage.decryptStringAsync(encrypted)).result;
    } catch { return ''; }
  }

  async function store(value) {
    try {
      if (!value) fs.rmSync(file(), { force: true });
      else {
        if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return 'keyStorage';
        const encrypted = await safeStorage.encryptStringAsync(value);
        const temp = file() + '.tmp';
        try {
          fs.writeFileSync(temp, encrypted, { mode: 0o600 });
          fs.renameSync(temp, file());
        } finally {
          fs.rmSync(temp, { force: true });
        }
      }
      current = Promise.resolve(value);
      return null;
    } catch { return 'keyStorage'; }
  }

  return {
    read: () => current ??= decrypt(),
    async save(value) {
      if (typeof value !== 'string' || (value !== '' && !/^lin_api_[a-z0-9_-]{1,248}$/i.test(value))) return 'invalidKey';
      saving = saving.then(() => store(value));
      return saving;
    },
  };
}

function createLinearSync({ getKey, fetchApi = globalThis.fetch, emit = () => {} }) {
  const updating = new Set();

  async function request(key, query, variables) {
    if (await getKey() !== key) throw new Error('connectionChanged');
    let response, payload;
    try {
      response = await fetchApi(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', Authorization: key },
        body: JSON.stringify({ query, variables }),
      });
      payload = await response.json();
    } catch { throw new Error('unavailable'); }
    if (response.status === 401 || response.status === 403 || payload?.errors?.some?.((error) => error.extensions?.code === 'AUTHENTICATION_ERROR')) {
      throw new Error('unauthorized');
    }
    if (!response.ok || payload?.errors?.length || !payload?.data) throw new Error('unavailable');
    if (await getKey() !== key) throw new Error('connectionChanged');
    return payload.data;
  }

  function nextCursor(connection, cursors) {
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) throw new Error('unavailable');
    if (!connection.pageInfo.hasNextPage) return null;
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('unavailable');
    cursors.add(cursor);
    return cursor;
  }

  async function fetchIssues({ projectId, teamId, pendingOnly } = {}) {
    const project = linearScopeId(projectId);
    const team = linearScopeId(teamId);
    if ((projectId && !project) || (teamId && !team)) return { error: 'invalidScope' };
    const key = await getKey();
    if (!key) return { error: 'notConfigured' };
    const filter = {
      ...(project && { project: { id: { eq: project } } }),
      ...(team && { team: { id: { eq: team } } }),
      ...(pendingOnly === true && { state: { type: { in: ['triage', 'backlog', 'unstarted', 'started'] } } }),
    };
    const issues = new Map();
    const cursors = new Set();
    let after = null;
    let title = '';
    try {
      do {
        const page = await request(key, ISSUE_LIST, { filter, after, project, team, hasProject: !!project && !after, hasTeam: !!team && !after });
        if (!after) title = [page.project?.name, page.team?.name].filter(Boolean).join(' · ');
        after = nextCursor(page.issues, cursors);
        for (const raw of page.issues.nodes) {
          const issue = normalizeIssue(raw);
          if (issue?.status && !issues.has(issue.id)) issues.set(issue.id, issue);
        }
      } while (after);
      const columns = Object.fromEntries(LINEAR_STATUSES.map((status) => [status, []]));
      for (const issue of issues.values()) columns[issue.status].push(issue);
      return { title, columns };
    } catch (error) { return { error: error.message }; }
  }

  async function updateIssueStatus({ issueId, status, expectedStatus } = {}) {
    if (typeof issueId !== 'string' || !ISSUE_ID.test(issueId) || !LINEAR_STATUSES.includes(status) ||
      (expectedStatus !== undefined && !LINEAR_STATUSES.includes(expectedStatus))) return { error: 'invalidMove' };
    const key = await getKey();
    if (!key) return { error: 'notConfigured' };
    const lockId = issueId.toLowerCase();
    if (updating.has(lockId)) return { error: 'movePending' };
    updating.add(lockId);
    try {
      const states = [];
      const cursors = new Set();
      let after = null;
      do {
        const { issue } = await request(key, ISSUE_WORKFLOW, { id: issueId, after, includeIssue: !after });
        if (!after) {
          const current = statusOf(issue?.state);
          if (current === status) return { changed: false };
          if (!current || (expectedStatus && current !== expectedStatus)) return { error: 'issueMoved' };
        }
        const page = issue?.team?.states;
        after = nextCursor(page, cursors);
        states.push(...page.nodes);
      } while (after);
      const state = stateForStatus(states, status);
      if (!state) return { error: 'missingStatus' };
      const { issueUpdate } = await request(key, UPDATE_STATUS, { id: issueId, state: state.id });
      const issue = normalizeIssue(issueUpdate?.issue);
      if (!issueUpdate?.success || !issue || issue.status !== status) return { error: 'unavailable' };
      emit({ issue });
      return { issue, changed: true };
    } catch (error) {
      return { error: error.message };
    } finally { updating.delete(lockId); }
  }

  return {
    fetchIssues,
    updateIssueStatus,
    onHook: (payload) => { if (isLinearIssueChange(payload)) emit({}); },
  };
}

module.exports = { createLinearCredentials, createLinearSync, isLinearIssueChange, stateForStatus, statusOf };
