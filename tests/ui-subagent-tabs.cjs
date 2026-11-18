const assert = require('node:assert/strict');
const { toolUrl } = require('../electron/hookServer.cjs');
const pty = require('../electron/ptyManager.cjs');

module.exports = async ({ win, evaluate, until, errors }) => {
  const parent = 'smoke-terminal';
  await until("!!document.querySelector('.terminal-node .xterm')");
  pty.write(parent, 'echo PARENT-ONLY\r');
  await until("document.querySelector('.terminal-node .xterm-rows')?.textContent.includes('PARENT-ONLY')");
  const call = (name, args) => fetch(toolUrl(parent), {
    method: 'POST',
    body: JSON.stringify({ name, arguments: args }),
  }).then((response) => response.json());
  const reply = call('orchestra_spawn_subagent', { title: 'Research', prompt: 'Child-only prompt', agentId: 'codex' });
  await until("!!document.querySelector('.subagent-tab .working')");
  const secondReply = call('orchestra_spawn_subagent', { title: 'Review', prompt: 'Second-only prompt', agentId: 'codex' });
  await until("document.querySelectorAll('.subagent-tab-item .working').length === 2");
  assert.equal(await evaluate("document.querySelectorAll('.terminal-node').length"), 1);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.subagent-status.working'), '::after').display"), 'none');
  await evaluate("document.querySelector('.subagent-tab-item [role=tab]').click()");
  await until("document.querySelector('[role=tabpanel]:not([hidden]) .xterm-rows')?.textContent.includes('CHILD OUTPUT')");
  assert.equal(await evaluate("document.querySelector('[role=tabpanel]:not([hidden]) .xterm-rows').textContent.includes('PARENT-ONLY')"), false);
  await evaluate("document.querySelector('.subagent-expand').click()");
  await until("document.querySelectorAll('.subagent-dialog[open] .xterm-rows').length === 3");
  await until("[...document.querySelectorAll('.subagent-dialog .xterm-rows')].every((rows, index) => rows.textContent.includes(['PARENT-ONLY', 'Child-only prompt', 'Second-only prompt'][index]))");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until("!document.querySelector('.subagent-dialog')");
  await until("document.querySelectorAll('.subagent-tab-item .completed').length === 2");
  assert.equal(JSON.parse((await reply).text).summary, 'Child summary');
  assert.equal(JSON.parse((await secondReply).text).title, 'Review');
  await evaluate("document.querySelector('.terminal-header .maximize').click()");
  await until("document.querySelector('.terminal-max [role=tabpanel]:not([hidden]) .xterm-rows')?.textContent.includes('Child-only prompt')");
  await evaluate("document.querySelector('.terminal-max-header button').click()");
  await until("!document.querySelector('.terminal-max')");
  await evaluate("document.querySelector('.subagent-main').click()");
  assert.equal(await evaluate("document.querySelector('[role=tabpanel]:not([hidden]) .xterm-rows').textContent.includes('CHILD OUTPUT')"), false);
  await evaluate("document.querySelector('.subagent-tab-item [role=tab]').click()");
  await evaluate("document.querySelector('.subagent-close').click()");
  await until("document.querySelectorAll('.subagent-tab-item').length === 1 && document.querySelector('.subagent-main').getAttribute('aria-selected') === 'true'");
  const [remaining] = JSON.parse((await call('orchestra_list_subagents', {})).text);
  assert.equal(remaining.title, 'Review');
  await call('orchestra_close_subagent', { subagentId: remaining.id });
  await until("!document.querySelector('.subagent-tabs') && !document.querySelector('.terminal-body[hidden]')");
  assert.deepEqual(JSON.parse((await call('orchestra_list_subagents', {})).text), []);
  assert.deepEqual(pty.ids(), [parent]);
  assert.deepEqual(errors, []);
};
