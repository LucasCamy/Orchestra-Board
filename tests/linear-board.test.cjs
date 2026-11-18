const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { load, i18n } = require('./helpers.cjs');
const { createLinearBoardNode } = require('../electron/linearModel.mjs');
const { createLinearCredentials, createLinearSync, statusOf, stateForStatus } = require('../electron/linearSync.cjs');

const states = [
  { id: 'backlog', type: 'backlog', name: 'Backlog', position: 0 },
  { id: 'todo', type: 'unstarted', name: 'Ready', position: 1 },
  { id: 'doing', type: 'started', name: 'Implementing', position: 2 },
  { id: 'review', type: 'started', name: 'Révision', position: 3 },
  { id: 'done', type: 'completed', name: 'Released', position: 4 },
  { id: 'cancelled', type: 'canceled', name: 'Canceled', position: 5 },
];
const issue = (number, state) => ({ id: `issue-${number}`, identifier: `SI-${number}`, title: 'Add the board', priority: 1,
  assignee: { displayName: 'Tech Lead', avatarUrl: 'https://example.test/avatar.png' }, team: { id: 'team' }, project: { id: 'project' }, state });
const connection = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const data = (body) => json({ data: body });

test('a saved Linear board template retains only its scope and a deliberate delegation edge', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-linear-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const electron = { app: { getPath: () => dir } };
  const node = createLinearBoardNode({ x: 500, y: 250 }, 'kanban');
  assert.deepEqual(node.position, { x: 20, y: 3 });
  node.data = { projectId: ' project ', teamId: '../../unsafe', key: 'SECRET', issues: [issue(211, states[0])], loading: true };
  const lead = { id: 'lead', type: 'terminal', position: { x: 1100, y: 0 }, data: { agentId: 'codex' } };
  const badEdge = { id: 'bad', source: lead.id, target: node.id, data: { mode: 'linear', enabled: true } };
  const { sanitizeContent } = load('workspaceStore.cjs', { electron, './settingsStore.cjs': { MODEL: /^[\w.-]+$/ }, './i18n.cjs': i18n });
  const templates = load('teamTemplates.cjs', {
    electron, './workspaceStore.cjs': { sanitizeContent }, './i18n.cjs': i18n,
    './settingsStore.cjs': { load: () => ({ agents: [{ id: 'codex', hooks: 'codex' }] }) },
  });
  const saved = templates.save('Linear project', { nodes: [node, lead], edges: [badEdge,
    { id: 'link', source: node.id, target: lead.id, data: { mode: 'linear', enabled: true, prompt: 'SECRET' } }] });
  const stored = fs.readFileSync(path.join(dir, 'team-templates.json'), 'utf8');
  assert.doesNotMatch(stored, /SECRET|SI-211|unsafe|loading/);
  const { board } = templates.instantiate(saved.id, dir);
  assert.deepEqual(board.nodes[0].data, { projectId: 'project' });
  assert.equal(board.edges.length, 1);
  assert.equal(board.edges[0].source, board.nodes[0].id);
  assert.equal(board.edges[0].target, board.nodes[1].id);
  assert.deepEqual(board.edges[0].data, { mode: 'linear', enabled: true });
});

test('Linear workflow types and review names map to the four columns; scopes and pagination are applied', async () => {
  assert.deepEqual(states.map(statusOf), ['todo', 'todo', 'inProgress', 'inReview', 'done', null]);
  assert.equal(stateForStatus(states, 'todo').id, 'todo');
  assert.equal(stateForStatus(states, 'inReview').id, 'review');
  assert.equal(stateForStatus(states.slice(0, 3), 'inReview'), undefined);
  const cursors = [];
  const linear = createLinearSync({ getKey: () => 'fixture', fetchApi: async (url, request) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'fixture');
    const { variables } = JSON.parse(request.body);
    assert.deepEqual(variables.filter, { project: { id: { eq: 'project' } }, team: { id: { eq: 'team' } } });
    cursors.push(variables.after);
    return variables.after ? data({ issues: connection([issue(213, states[3]), issue(214, states[4]), issue(215, states[5])]) })
      : data({ project: { name: 'Orchestra' }, team: { name: 'Squad' }, issues: connection([issue(211, states[0]), issue(212, states[2])], 'next') });
  } });
  const board = await linear.fetchIssues({ projectId: 'project', teamId: 'team' });
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(board.title, 'Orchestra · Squad');
  assert.deepEqual(Object.values(board.columns).map((entries) => entries.map(({ identifier }) => identifier)), [['SI-211'], ['SI-212'], ['SI-213'], ['SI-214']]);
  assert.deepEqual(board.columns.todo[0].assignee, { name: 'Tech Lead', avatarUrl: 'https://example.test/avatar.png' });
});

test('failed, stale and unsupported moves preserve the issue and emit no update; confirmed retries emit once', async () => {
  let current = states[1];
  let failure = 'network';
  let mutations = 0;
  const events = [];
  const linear = createLinearSync({ getKey: () => 'fixture', emit: (value) => events.push(value), fetchApi: async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    if (query.includes('OrchestraIssues')) return data({ issues: connection([issue(211, current)]) });
    if (query.includes('OrchestraIssueWorkflow')) return data({ issue: { state: current, team: { states: connection(states.filter(({ id }) => id !== 'review')) } } });
    mutations++;
    assert.equal(variables.state, 'doing');
    if (failure === 'network') throw new Error('Network broke');
    if (failure === 'graphql') return json({ data: { issueUpdate: { success: true } }, errors: [{ message: 'Denied' }] });
    current = states[2];
    return data({ issueUpdate: { success: true, issue: issue(211, current) } });
  } });
  const move = (status, expectedStatus) => linear.updateIssueStatus({ issueId: 'issue-211', status, expectedStatus });
  assert.deepEqual(await move('inProgress', 'inReview'), { error: 'issueMoved' });
  assert.deepEqual(await move('inReview', 'todo'), { error: 'missingStatus' });
  assert.equal(mutations, 0);
  assert.deepEqual(await move('inProgress', 'todo'), { error: 'unavailable' });
  failure = 'graphql';
  assert.deepEqual(await move('inProgress', 'todo'), { error: 'unavailable' });
  assert.equal(events.length, 0);
  assert.equal((await linear.fetchIssues()).columns.todo[0].id, 'issue-211');
  failure = null;
  assert.equal((await move('inProgress', 'todo')).issue.status, 'inProgress');
  assert.deepEqual(await move('inProgress', 'todo'), { changed: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].issue.identifier, 'SI-211');
});

test('only completed Linear MCP issue writes invalidate the views', () => {
  const events = [];
  const linear = createLinearSync({ getKey: () => '', emit: (value) => events.push(value) });
  const call = (tool_name, rest) => linear.onHook({ hook_event_name: 'PostToolUse', tool_name, ...rest });
  call('mcp__linear__save_issue');
  call('mcp__linear-server__update_issue');
  call('linear_create_issue');
  call('mcp__linear__list_issues');
  call('mcp__other__update_issue');
  call('linear_update_issue', { tool_response: { isError: true } });
  call('linear_update_issue', { hook_event_name: 'PreToolUse' });
  assert.deepEqual(events, [{}, {}, {}]);
});

test('an in-flight move blocks a concurrent move of the same ticket', async () => {
  const workflow = Promise.withResolvers();
  const started = Promise.withResolvers();
  const linear = createLinearSync({ getKey: () => 'fixture', fetchApi: async (_url, request) => {
    if (JSON.parse(request.body).query.includes('OrchestraIssueWorkflow')) {
      started.resolve();
      return workflow.promise;
    }
    return data({ issueUpdate: { success: true, issue: issue(211, states[2]) } });
  } });
  const first = linear.updateIssueStatus({ issueId: 'issue-211', status: 'inProgress' });
  await started.promise;
  assert.deepEqual(await linear.updateIssueStatus({ issueId: 'issue-211', status: 'done' }), { error: 'movePending' });
  workflow.resolve(data({ issue: { state: states[1], team: { states: connection(states) } } }));
  assert.equal((await first).changed, true);
});

test('Linear preferences write an encrypted file and preserve the previous key when storage is unavailable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-linear-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = () => path.join(dir, 'linear-key');
  let backend = 'os-crypt';
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value) => Buffer.from(value.split('').reverse().join('')),
    decryptStringAsync: async (value) => ({ result: value.toString().split('').reverse().join('') }),
  };
  const credentials = createLinearCredentials(file, safeStorage);
  assert.equal(await credentials.read(), '');
  assert.equal(await credentials.save('lin_api_fixture'), null);
  assert.doesNotMatch(fs.readFileSync(file(), 'utf8'), /lin_api_/);
  assert.equal(await createLinearCredentials(file, safeStorage).read(), 'lin_api_fixture');
  backend = 'basic_text';
  assert.equal(await credentials.save('lin_api_replacement'), 'keyStorage');
  assert.equal(await credentials.read(), 'lin_api_fixture');
  assert.equal(await credentials.save(''), null);
  assert.equal(await credentials.read(), '');
});
