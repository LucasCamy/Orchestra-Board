const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LINEAR_BOARD_DRAG } = require('../electron/linearModel.mjs');
const { hookUrl } = require('../electron/hookServer.cjs');

const states = [
  { id: 'todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'working', name: 'Implementing', type: 'started', position: 1 },
  { id: 'review', name: 'In Review', type: 'started', position: 2 },
  { id: 'done', name: 'Done', type: 'completed', position: 3 },
];
const ticket = (id, title, priority, state) => ({ id: `issue-${id}`, identifier: `SI-${id}`, title, priority, state, team: { id: 'squad' }, project: { id: 'project' }, assignee: { name: 'Taylor Nguyen' } });
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });

function prepare() {
  const realFetch = global.fetch;
  const issues = [ticket(211, 'Add the Linear integration to the Orchestra canvas', 1, states[0]),
    ticket(210, 'Verify canvas snapshots', 3, states[2]), ticket(209, 'Set up the project', 4, states[3]),
    ticket(212, 'Review accessibility and shortcuts', 2, states[1])];
  const moves = [];
  const writes = [];
  let failMutation = false;
  global.fetch = async (url, options) => {
    if (url !== 'https://api.linear.app/graphql') return realFetch(url, options);
    assert.equal(options.headers.Authorization, 'lin_api_ui_fixture');
    const { query, variables } = JSON.parse(options.body);
    let data;
    if (query.includes('OrchestraIssues')) {
      data = { project: variables.hasProject ? { name: 'Orchestra' } : undefined,
        issues: connection(issues.filter((issue) => !variables.filter.state || variables.filter.state.type.in.includes(issue.state.type))) };
    } else {
      const issue = issues.find((entry) => entry.id === variables.id);
      assert.ok(issue);
      if (query.includes('OrchestraIssueWorkflow')) data = { issue: { state: issue.state, team: { states: connection(states) } } };
      else {
        moves.push(variables.state);
        if (failMutation) return new Response(null, { status: 503 });
        issue.state = states.find((state) => state.id === variables.state);
        data = { issueUpdate: { success: true, issue } };
      }
    }
    return Response.json({ data });
  };
  const pty = require('../electron/ptyManager.cjs');
  pty.create = () => ({});
  pty.write = (id, input) => writes.push([id, input]);

  return async ({ win, evaluate, until, data, errors }) => {
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const fill = (selector, value) => evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const status = (name) => `[data-linear-status=${name}] [data-issue-id=issue-211]`;
    const exists = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`;
    const hook = (hook_event_name, rest) => realFetch(hookUrl('lead'), {
      method: 'POST', body: JSON.stringify({ hook_event_name, ...rest }),
    }).then((response) => { assert.ok(response.ok); });

    await until("!!document.querySelector('.dock-linear') && !document.querySelector('.splash')");
    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'View board')?.click()");
    await until("!document.querySelector('.dialog')");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.dock-linear .linear-logo')).maskImage"), 'none');
    await click('.dock-linear');
    await until(exists('.linear-drawer .linear-feedback button'));
    await click('.linear-drawer .linear-feedback button');
    await fill('.linear-key-input', 'lin_api_ui_fixture');
    await click('form:has(.linear-key-input) button[type=submit]');
    await until("document.body.textContent.includes('A Linear API key is saved')");
    assert.equal(await evaluate("document.querySelector('.linear-key-input').value"), '');
    assert.doesNotMatch(fs.readFileSync(path.join(data, 'linear-key')).toString(), /lin_api_ui_fixture/);
    await click('.modal-header button');
    await until(exists('.linear-drawer [data-issue-id=issue-211]'));
    assert.equal(await evaluate(exists('.linear-drawer [data-issue-id=issue-209]')), false);

    const dragType = await evaluate(`(() => {
      const dataTransfer = new DataTransfer();
      document.querySelector('.dock-linear').dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
      const board = document.querySelector('.board');
      const { left, top } = board.getBoundingClientRect();
      board.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: left + 370, clientY: top + 265 }));
      return dataTransfer.getData(${JSON.stringify(LINEAR_BOARD_DRAG)});
    })()`);
    assert.equal(dragType, 'linear');
    await until(exists(status('todo')));
    assert.equal(await evaluate(exists('.linear-drawer')), false);
    await click('.dock-linear');
    assert.equal(await evaluate("document.querySelectorAll('.linear-board-node').length"), 1);
    await click('button[aria-label="Filter Linear issues"]');
    await fill('.linear-filters input', 'project');
    await click('.linear-filters button[type=submit]');
    await until("document.querySelector('.linear-board-heading h2').textContent === 'Orchestra'");
    assert.equal(await evaluate("document.querySelector('.linear-assignee[aria-label=\"Taylor Nguyen\"]').textContent"), 'TN');

    await evaluate(`window.pty.create({ id: 'lead', boardId: 'board-1', agentId: 'codex', cwd: ${JSON.stringify(data)}, label: 'Tech Lead', cols: 80, rows: 24 })`);
    await hook('SessionStart');
    assert.equal(require('../electron/agentStatus.cjs').info('lead')?.ready, true, 'the mock Tech Lead has started');
    await click('.react-flow__controls-fitview');
    await until(`(() => {
      const target = document.querySelector('[data-id=lead] .react-flow__handle.target').getBoundingClientRect();
      return target.left > 0 && target.right < document.querySelector('.board').getBoundingClientRect().right;
    })()`);
    await evaluate(`(() => {
      const source = document.querySelector('.linear-board-node .react-flow__handle.source');
      const target = document.querySelector('[data-id=lead] .react-flow__handle.target');
      function mouse(type, handle) {
        const { left, top, width, height } = handle.getBoundingClientRect();
        handle.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
          clientX: left + width / 2, clientY: top + height / 2, view: window }));
      }
      mouse('mousedown', source);
      mouse('mousemove', target);
      mouse('mouseup', target);
    })()`);
    await until(exists('.react-flow__edge'));
    await click('.react-flow__edge-interaction');
    await until(exists('.link-panel input[type=checkbox]'));
    assert.equal(await evaluate("document.querySelector('.link-panel input').checked"), false);
    await click('.link-panel input');
    await evaluate(`window.linearDrag = new DataTransfer();
      document.querySelector(${JSON.stringify(status('todo'))}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.linearDrag })); true`);
    assert.deepEqual(moves, []);
    await evaluate(`document.querySelector('[data-linear-status=inProgress]').dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: window.linearDrag
    }))`);
    await until(exists(status('inProgress')));
    assert.deepEqual(moves, ['working']);
    assert.ok(await evaluate(exists(`${status('inProgress')}.linear-arriving`)));
    await until("document.querySelector('.link-panel [role=status]')?.textContent.includes('Message sent')").catch(async (error) => {
      throw new Error(`${error.message}; link: ${await evaluate("document.querySelector('.link-panel')?.textContent")}; terminal writes: ${JSON.stringify(writes)}`);
    });
    assert.equal(writes.filter(([id, input]) => id === 'lead' && input.includes('Start implementing Linear issue SI-211')).length, 1);

    issues[0].state = states[2];
    await hook('PostToolUse', { tool_name: 'mcp__linear__save_issue', tool_response: { isError: false } });
    await until(exists(status('inReview')));
    issues.unshift(ticket(213, 'Document the Linear setup', 2, states[0]));
    await hook('PostToolUse', { tool_name: 'mcp__linear__create_issue' });
    await until(exists('[data-linear-status=todo] [data-issue-id=issue-213]'));
    failMutation = true;
    await evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(`${status('inReview')} select`)});
      select.value = 'done';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until("document.querySelector('.linear-board-node').textContent.includes('could not be reached')");
    assert.ok(await evaluate(exists(status('inReview'))));
    await until("!document.querySelector('.linear-board-header button').disabled");
    await click('button[aria-label="Refresh Linear issues"]');
    await until("!document.querySelector('.linear-feedback')");
    await evaluate("document.querySelector('.link-panel-header button')?.click()");
    await click('.dock-linear');
    await until("document.querySelector('.linear-board-node').getBoundingClientRect().width > 900");
    const image = await win.webContents.capturePage(undefined, { stayHidden: true });
    fs.writeFileSync(path.join(data, 'linear-board.png'), image.toPNG());
    assert.deepEqual(errors, []);
  };
}

module.exports = { prepare };
