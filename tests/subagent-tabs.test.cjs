const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { load, clock, i18n } = require('./helpers.cjs');

const spawnTool = 'orchestra_spawn_subagent';
const listTool = 'orchestra_list_subagents';
const closeTool = 'orchestra_close_subagent';
const task = { title: 'Research', prompt: 'Read the docs.\nReturn findings.', agentId: 'codex' };

function setup() {
  const time = clock();
  const { createSubagents } = load('subagents.cjs', {}, time);
  const agent = { id: 'codex', command: 'codex', hooks: 'codex' };
  const parents = new Set(['parent', 'other']);
  const events = [];
  const launches = [];
  const writes = [];
  const outputs = new Map([['parent', { buffer: 'Main chat', offset: 9 }]]);
  const service = createSubagents({
    parent: (id) => parents.has(id) ? { agentId: agent.id, agent, cwd: 'project', model: 'test-model' } : null,
    agent: (id) => id === agent.id ? agent : null,
    launch: (entry, target, model) => {
      launches.push({ id: entry.id, cwd: entry.cwd, target, model });
      outputs.set(entry.id, { buffer: 'Child terminal', offset: 14 });
    },
    stop: (id) => outputs.delete(id),
    snapshot: (id) => outputs.get(id),
    write: (id, value) => writes.push([id, value]),
    emit: (parentId, list) => events.push([parentId, list]),
    lastReply: (payload) => payload.last_assistant_message,
    readDelay: 400,
    t: i18n.t,
  });
  const hook = (id, event, payload) => service.onHook(id, { hook_event_name: event, session_id: 'child-session', turn_id: 'child-turn', ...payload });
  const submit = (id) => {
    service.onOutput(id, '\x1b[?20');
    service.onOutput(id, '04h');
    time.tick(250);
    hook(id, 'SessionStart');
    hook(id, 'UserPromptSubmit');
  };
  return { time, service, events, launches, writes, outputs, hook, submit };
}

test('MCP spawns a working tab scoped to the authenticated parent and returns its own Stop summary', { timeout: 5000 }, async (t) => {
  const s = setup();
  let arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  const relay = createServer(async (req, res) => {
    assert.equal(req.url, '/tool/parent?t=test-token');
    let body = '';
    for await (const chunk of req) body += chunk;
    const { name, arguments: args } = JSON.parse(body);
    const reply = s.service.callTool('parent', name, args);
    if (name === spawnTool) arrived();
    res.end(JSON.stringify(await reply));
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const mcp = spawn(process.execPath, [path.resolve(__dirname, '../electron/mcpServer.cjs')], {
    env: { ...process.env, ORCHESTRA_URL: `http://127.0.0.1:${relay.address().port}/tool/parent?t=test-token` },
    windowsHide: true,
  });
  t.after(() => mcp.kill());
  const lines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  let requestId = 0;
  const request = (method, params) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) + '\n');
    return lines.next().then(({ value }) => JSON.parse(value).result);
  };

  const catalog = await request('tools/list');
  assert.deepEqual(catalog.tools.filter(({ name }) => name.includes('_subagent')).map(({ name }) => name), [spawnTool, listTool, closeTool]);
  const runningCall = request('tools/call', { name: spawnTool, arguments: task });
  await started;
  const [{ id, cwd, model }] = s.launches;
  const working = { id, title: task.title, agentId: 'codex', status: 'working' };
  assert.equal(cwd, 'project');
  assert.equal(model, 'test-model');
  assert.deepEqual(s.events, [['parent', [working]]]);
  assert.deepEqual(s.service.list('other'), []);
  s.hook(id, 'Stop', { last_assistant_message: 'Ignored before submit' });
  s.submit(id);
  assert.deepEqual(s.writes, [[id, '\x1b[200~Read the docs.\rReturn findings.\x1b[201~'], [id, '\r']]);
  s.hook(id, 'Stop', { turn_id: 'wrong-turn', last_assistant_message: 'Wrong turn' });
  s.time.tick(400);
  assert.deepEqual(s.service.list('parent'), [working]);
  s.hook(id, 'Stop', { last_assistant_message: 'Only child findings' });
  s.time.tick(400);
  const completed = { ...working, status: 'completed' };
  const response = await runningCall;
  assert.equal(response.isError, false);
  assert.deepEqual(JSON.parse(response.content[0].text), { ...completed, summary: 'Only child findings' });
  assert.deepEqual(s.events.at(-1), ['parent', [completed]]);
  const listed = await request('tools/call', { name: listTool, arguments: {} });
  assert.deepEqual(JSON.parse(listed.content[0].text), [{ ...completed, summary: 'Only child findings' }]);
});

test('closing a tab is scoped, cancels pending input and never touches the parent output', async () => {
  const s = setup();
  const first = s.service.callTool('parent', spawnTool, task);
  const second = s.service.callTool('parent', spawnTool, { ...task, title: 'Second' });
  const [one, two] = s.service.list('parent');
  s.hook(one.id, 'SessionStart');
  s.service.onOutput(one.id, '\x1b[?2004h');
  assert.equal(s.service.callTool('other', closeTool, { subagentId: one.id }).isError, true);
  assert.equal(s.service.callTool(one.id, closeTool, { subagentId: one.id }).isError, true);
  assert.deepEqual(JSON.parse(s.service.callTool('parent', closeTool, { subagentId: one.id }).text), { id: one.id, closed: true });
  s.time.tick(2000);
  assert.deepEqual(s.writes.map(([id]) => id), [one.id], 'no delayed Enter or writes to the parent');
  assert.equal(s.service.snapshot(one.id), null);
  assert.equal(s.service.snapshot(two.id).buffer, 'Child terminal');
  assert.equal(s.outputs.get('parent').buffer, 'Main chat');
  assert.deepEqual(s.service.list('parent'), [two]);
  assert.equal((await first).isError, true);
  s.service.closeParent('parent');
  assert.deepEqual(s.events.at(-1), ['parent', []]);
  assert.equal((await second).isError, true);
});

test('failed startup and premature exit retain independent tab output and report failure', async () => {
  const s = setup();
  const request = s.service.callTool('parent', spawnTool, task);
  const [{ id }] = s.service.list('parent');
  s.hook(id, 'SessionStart');
  s.time.tick(90000);
  assert.deepEqual(s.writes, [], 'no paste into a terminal that has not enabled bracketed paste');
  assert.equal(JSON.parse((await request).text).status, 'failed');
  assert.equal(s.service.snapshot(id).buffer, 'Child terminal');

  const premature = s.service.callTool('other', spawnTool, task);
  const [second] = s.service.list('other');
  s.service.onExit(second.id, { buffer: 'command not found', offset: 17 });
  assert.equal((await premature).isError, true);
  assert.equal(s.service.list('other')[0].status, 'failed');
  assert.equal(s.service.snapshot(second.id).buffer, 'command not found');
});

test('a timed-out MCP wait leaves the sub-agent available and an exit after Stop retains its result', async () => {
  const s = setup();
  const request = s.service.callTool('parent', spawnTool, task);
  const [{ id }] = s.service.list('parent');
  s.submit(id);
  s.time.tick(300000);
  assert.equal(JSON.parse((await request).text).status, 'working');
  s.hook(id, 'Stop', { last_assistant_message: 'Late result' });
  s.service.onExit(id, { buffer: 'Final screen', offset: 12 });
  s.time.tick(400);
  const [listed] = JSON.parse(s.service.callTool('parent', listTool, {}).text);
  assert.equal(listed.status, 'completed');
  assert.equal(listed.summary, 'Late result');
  assert.equal(s.service.snapshot(id).buffer, 'Final screen');
});

test('rejects terminal control characters and leaves a valid tab running if the MCP client disconnects', async () => {
  const s = setup();
  assert.equal(s.service.callTool('parent', spawnTool, { ...task, prompt: 'escape\x1b[201~' }).isError, true);
  assert.deepEqual(s.launches, []);
  const controller = new AbortController();
  const request = s.service.callTool('parent', spawnTool, task, controller.signal);
  const [child] = s.service.list('parent');
  controller.abort();
  assert.deepEqual(JSON.parse((await request).text), child);
  s.submit(child.id);
  s.hook(child.id, 'Stop', { last_assistant_message: 'Still ran' });
  s.time.tick(400);
  assert.equal(s.service.list('parent')[0].status, 'completed');
  assert.equal(JSON.parse(s.service.callTool('parent', listTool, {}).text)[0].summary, 'Still ran');
});

test('workspace and reusable templates exclude sub-agent nodes and runtime fields', () => {
  const electron = { app: {}, ipcMain: {} };
  const { sanitizeContent } = load('workspaceStore.cjs', { electron, './settingsStore.cjs': { MODEL: /^model$/ } });
  const { templateBoard } = load('teamTemplates.cjs', { electron, './workspaceStore.cjs': { sanitizeContent }, './settingsStore.cjs': {} });
  const childId = 'subagent-bd31cdbf-fd23-45c2-8420-fcf1b3be2e0a';
  const parent = { id: 'parent', type: 'terminal', position: { x: 0, y: 0 }, data: { agentId: 'codex', subagents: [{ id: childId, transcript: 'temporary' }], activeSubagent: childId } };
  const board = { nodes: [parent, { ...parent, id: childId }], edges: [{ id: 'edge', source: 'parent', target: childId, data: {} }] };
  for (const saved of [sanitizeContent(board), templateBoard(board)]) {
    assert.deepEqual(saved.nodes.map(({ id }) => id), ['parent']);
    assert.deepEqual(saved.edges, []);
    assert.equal(saved.nodes[0].data.subagents, undefined);
    assert.equal(saved.nodes[0].data.activeSubagent, undefined);
  }
});
