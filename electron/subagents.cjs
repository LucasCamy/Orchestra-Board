const { randomUUID } = require('node:crypto');

const PREFIX = 'subagent-';
const TOOLS = new Set(['orchestra_spawn_subagent', 'orchestra_list_subagents', 'orchestra_close_subagent']);
const MAX_CHILDREN = 32;
const MAX_PROMPT = 20000;
const MAX_REPLY = 4000;
const PASTE_MODE = /\x1b\[\?2004([hl])/g;
const isSubagent = (id) => typeof id === 'string' && id.startsWith(PREFIX);
const isTool = (name) => TOOLS.has(name);

function createSubagents({ parent, agent, launch, stop, write, snapshot, emit, lastReply, readDelay, t }) {
  const entries = new Map();
  const children = (parentId) => [...entries.values()].filter((entry) => entry.parentId === parentId);
  const describe = ({ id, title, agentId, status }) => ({ id, title, agentId, status });
  const list = (parentId) => children(parentId).map(describe);
  const changed = (parentId) => emit(parentId, list(parentId));
  const error = (key, vars) => ({ text: t(key, vars), isError: true });
  const result = (value, isError = false) => ({ text: JSON.stringify(value), isError });
  const scoped = (parentId, id) => entries.get(id)?.parentId === parentId ? entries.get(id) : null;

  function finish(entry, status, summary) {
    clearTimeout(entry.startup);
    clearTimeout(entry.submit);
    clearTimeout(entry.read);
    entry.phase = 'idle';
    entry.status = status;
    entry.summary = summary;
    changed(entry.parentId);
    entry.resolveFirst(result({ ...describe(entry), summary }, status === 'failed'));
  }

  function close(parentId, id) {
    const entry = scoped(parentId, id);
    if (!entry) return false;
    entries.delete(id);
    clearTimeout(entry.startup);
    clearTimeout(entry.submit);
    clearTimeout(entry.read);
    entry.resolveFirst(error('card.subagents.closed', { title: entry.title }));
    stop(id);
    changed(parentId);
    return true;
  }

  function failStartup(entry, key) {
    entry.output = snapshot(entry.id);
    stop(entry.id);
    finish(entry, 'failed', t(key));
  }

  function spawn(parentId, owner, args, signal) {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
    // Reject input that could escape a terminal paste or act as a control key.
    if (!title || title.length > 80 || !prompt || prompt.length > MAX_PROMPT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(prompt)) {
      return error('card.subagents.invalidTask');
    }
    const target = args.agentId === undefined || args.agentId === owner.agentId ? owner.agent : agent(args.agentId);
    if (!target?.command || !['claude', 'codex', 'antigravity'].includes(target.hooks)) return error('card.subagents.unsupported');
    if (children(parentId).length >= MAX_CHILDREN) return error('card.subagents.limit', { max: MAX_CHILDREN });
    if (signal?.aborted) return error('card.subagents.cancelled');

    const id = PREFIX + randomUUID();
    const entry = { id, parentId, title, agentId: target.id, hooks: target.hooks, cwd: owner.cwd, status: 'working', phase: 'starting', prompt };
    const reply = new Promise((resolve) => { entry.resolveFirst = resolve; });
    const waiting = () => entry.resolveFirst(result(describe(entry)));
    const timeout = setTimeout(waiting, 300000);
    signal?.addEventListener('abort', waiting, { once: true });
    entries.set(id, entry);
    changed(parentId);
    entry.startup = setTimeout(() => failStartup(entry, 'card.subagents.unconfirmed'), 90000);
    try {
      launch(entry, target, target.id === owner.agentId ? owner.model : undefined);
    } catch {
      failStartup(entry, 'card.subagents.launchFailed');
    }
    return reply.finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', waiting);
      entry.resolveFirst = () => {};
    });
  }

  function callTool(parentId, name, args, signal) {
    const owner = parent(parentId);
    if (!owner) return error('delegate.callerNotRunning');
    if (name === 'orchestra_spawn_subagent') return spawn(parentId, owner, args, signal);
    if (name === 'orchestra_list_subagents') {
      return result(children(parentId).map((entry) => ({
        ...describe(entry), ...(entry.summary !== undefined && { summary: entry.summary }),
      })));
    }
    const id = args?.subagentId;
    return close(parentId, id) ? result({ id, closed: true }) : error('card.subagents.unknown');
  }

  function writePrompt(entry, value) {
    try { write(entry.id, value); }
    catch { failStartup(entry, 'card.subagents.unconfirmed'); return false; }
    return true;
  }

  function trySubmit(entry) {
    // Codex can fire SessionStart on the first submitted prompt. Its dedicated PTY
    // has no shell prompt, so bracketed paste is enough to recognize the CLI there.
    if (entry.phase !== 'starting' || !entry.bracketed || (!entry.ready && entry.hooks !== 'codex')) return;
    entry.phase = 'pasting';
    if (!writePrompt(entry, '\x1b[200~' + entry.prompt.replace(/\r\n?|\n/g, '\r') + '\x1b[201~')) return;
    delete entry.prompt;
    let attempts = 0;
    const enter = () => {
      if (entry.phase !== 'pasting' && entry.phase !== 'submitted') return;
      if (!entry.bracketed) return;
      entry.phase = 'submitted';
      if (writePrompt(entry, '\r') && ++attempts < 4) entry.submit = setTimeout(enter, 1500);
    };
    entry.submit = setTimeout(enter, 250);
  }

  function onOutput(id, data) {
    const entry = entries.get(id);
    if (!entry || !['starting', 'pasting', 'submitted'].includes(entry.phase)) return;
    // A ConPTY chunk may split an escape sequence. Keep only its incomplete suffix.
    const stream = (entry.pendingEscape ?? '') + data;
    for (const match of stream.matchAll(PASTE_MODE)) entry.bracketed = match[1] === 'h';
    entry.pendingEscape = stream.match(/\x1b(?:\[(?:\?(?:2(?:0(?:0(?:4)?)?)?)?)?)?$/)?.[0] ?? '';
    trySubmit(entry);
  }

  function onHook(id, payload) {
    const entry = entries.get(id);
    if (!entry || entry.output) return;
    switch (payload.hook_event_name) {
      case 'SessionStart':
        entry.ready = true;
        trySubmit(entry);
        return;
      case 'UserPromptSubmit':
        if (entry.phase !== 'submitted' && entry.phase !== 'idle' && entry.phase !== 'reading') return;
        clearTimeout(entry.startup);
        clearTimeout(entry.submit);
        clearTimeout(entry.read);
        entry.phase = 'running';
        entry.sessionId = payload.session_id;
        entry.turnId = payload.turn_id;
        if (entry.status !== 'working') {
          entry.status = 'working';
          delete entry.summary;
          changed(entry.parentId);
        }
        return;
      case 'Stop':
        if (entry.phase !== 'running' ||
            (entry.sessionId && payload.session_id && entry.sessionId !== payload.session_id) ||
            (entry.turnId && payload.turn_id && entry.turnId !== payload.turn_id)) return;
        entry.phase = 'reading';
        entry.read = setTimeout(() => {
          finish(entry, 'completed', lastReply(payload).slice(0, MAX_REPLY) || t('delegate.emptyReply'));
        }, readDelay);
    }
  }

  function onExit(id, output) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.output = output;
    if (entry.status === 'working' && entry.phase !== 'reading') finish(entry, 'failed', t('card.subagents.exited'));
  }

  return {
    list, close, callTool, onHook, onOutput, onExit,
    kind: (id) => entries.get(id)?.hooks,
    snapshot: (id) => entries.has(id) ? entries.get(id).output ?? snapshot(id) : null,
    write: (id, data) => {
      const entry = entries.get(id);
      if (entry && !['pasting', 'submitted', 'reading'].includes(entry.phase)) write(id, data);
    },
    closeParent: (parentId) => children(parentId).forEach(({ id }) => close(parentId, id)),
    closeAll: () => [...entries.values()].forEach(({ id, parentId }) => close(parentId, id)),
    busy: () => [...entries.values()].filter(({ status }) => status === 'working')
      .map(({ id, title, cwd, parentId, agentId, status }) => ({ id, name: title, cwd, parentId, agentId, status })),
  };
}

module.exports = { createSubagents, isSubagent, isTool };
