const fs = require('node:fs');
const path = require('node:path');
const { checkedPath, directoryIdentity, readFileState, validPath } = require('./workerChangePaths.cjs');

const directoryId = (value) => typeof value === 'string' && /^\d+:\d+$/.test(value);
const version = (state) => state === null || (state && typeof state.hash === 'string' &&
  /^[a-f0-9]{64}$/.test(state.hash) && typeof state.executable === 'boolean');
const hostVersion = (state) => state === null || (version(state) && Number.isInteger(state.mode) && state.mode >= 0 && state.mode <= 0o777);
const projectId = /^[\w-]{1,128}$/;
const journalId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validJournalId = (id) => typeof id === 'string' && journalId.test(id);

function workerUndoStore(storage, maxEntries, fail) {
  function directory(project, id) {
    if (!projectId.test(project.id) || !validJournalId(id)) throw fail('workerChanges.undoUnavailable');
    return path.join(storage, project.id + '.undo-' + id);
  }

  function validate(journal) {
    if (journal === null) return null;
    const paths = new Set();
    const slots = new Set();
    if (!validJournalId(journal?.id) || !directoryId(journal.root) || !Array.isArray(journal.entries) ||
        !journal.entries.length || journal.entries.length > maxEntries) throw fail('workerChanges.undoUnavailable');
    for (const entry of journal.entries) {
      if (!validPath(entry?.file) || !Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= maxEntries ||
          !version(entry.workerBefore) || !version(entry.workerAfter) ||
          typeof entry.unobserved !== 'boolean' || typeof entry.resolution !== 'boolean' ||
          (entry.unobserved && entry.workerBefore === null) ||
          (entry.unobservedAfter !== undefined && (typeof entry.unobservedAfter !== 'boolean' || (entry.unobservedAfter && entry.workerAfter === null))) ||
          (entry.archive !== undefined && !validJournalId(entry.archive)) ||
          (entry.split !== undefined && (entry.split !== true || !entry.change?.before || !entry.change?.after)) ||
          (entry.change !== null && (!entry.change || !directoryId(entry.change.parent) ||
            (entry.change.before === null && entry.change.after === null) ||
            !hostVersion(entry.change.before) || !hostVersion(entry.change.after)))) throw fail('workerChanges.undoUnavailable');
      const key = entry.file.normalize('NFC').toLowerCase();
      if (paths.has(key) || slots.has(entry.slot)) throw fail('workerChanges.undoUnavailable');
      paths.add(key);
      slots.add(entry.slot);
    }
    return journal;
  }

  function store(project, id, writes) {
    const files = writes.filter(({ host }) => host);
    if (!files.length) return;
    fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
    const folder = directory(project, id);
    fs.mkdirSync(folder, { mode: 0o700 });
    for (const { slot, host, readHost } of files) {
      fs.writeFileSync(path.join(folder, String(slot)), readHost ? readHost() : host.data, { flag: 'wx', mode: 0o600 });
    }
  }

  function read(project, id, slot, hash) {
    const state = readFileState(directory(project, id), String(slot), true);
    if (!state || state.hash !== hash) throw fail('workerChanges.undoUnavailable');
    return state.data;
  }

  function discard(project, id, entries) {
    const groups = new Map();
    for (const entry of entries) {
      const slot = entry?.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= maxEntries) continue;
      const archive = entry.archive ?? id;
      if (!groups.has(archive)) groups.set(archive, []);
      groups.get(archive).push(slot);
    }
    for (const [archive, slots] of groups) {
      try {
        const folder = directory(project, archive);
        if (!directoryIdentity(folder)) continue;
        for (const slot of slots) fs.rmSync(path.join(folder, String(slot)), { force: true });
        try { fs.rmdirSync(folder); } catch { /* Other records can still reference files in this archive. */ }
      } catch { /* The journal no longer references these private backup files. */ }
    }
  }

  return { validate, store, read, discard };
}

function fileParentIdentity(root, file) {
  try {
    const target = checkedPath(root, file);
    return target && !target.unsafe ? directoryIdentity(path.dirname(target.file)) : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(error.code)) return null;
    throw error;
  }
}

module.exports = { workerUndoStore, fileParentIdentity, validJournalId };
