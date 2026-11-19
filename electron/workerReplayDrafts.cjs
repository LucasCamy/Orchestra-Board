const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { directoryIdentity, hashBytes, validPath, MAX_BATCH_BYTES, MAX_FILE, MAX_ENTRIES } = require('./workerChangePaths.cjs');
const { validJournalId } = require('./workerUndo.cjs');

const MAX_SAVED_DRAFTS = 20;
const MAX_STORAGE_BYTES = 4 * MAX_BATCH_BYTES;
const hashPattern = /^[a-f0-9]{64}$/;
const identity = (value) => typeof value === 'string' && /^\d+:\d+$/.test(value);
const hostVersion = (value) => value && typeof value.hash === 'string' && hashPattern.test(value.hash) &&
  typeof value.executable === 'boolean' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777;
const strategy = (value) => ['local', 'selected', 'manual'].includes(value);

function check(condition) {
  if (!condition) throw Error('Invalid replay draft');
}

function draftItems(items, allowed) {
  check(Array.isArray(items) && items.length <= allowed.size);
  const seen = new Set();
  let size = 0;
  return items.map(({ file, key, choice, content }) => {
    check(typeof key === 'string' && validPath(file) && allowed.get(key) === file && !seen.has(key) && (choice === null || strategy(choice)));
    seen.add(key);
    if (choice !== 'manual') return { file, key, choice };
    check(typeof content === 'string' && content.length <= MAX_FILE);
    size += Buffer.byteLength(content);
    check(size <= MAX_BATCH_BYTES);
    return { file, key, choice, content };
  });
}

function encodeRecoveries(rebased) {
  const buffers = new Map();
  let size = 0;
  const encode = (data) => {
    const hash = hashBytes(data);
    if (!buffers.has(hash)) {
      size += data.length;
      check(size <= MAX_BATCH_BYTES);
      buffers.set(hash, data.toString('base64'));
    }
    return hash;
  };
  const recoveries = [...rebased].map(([file, item]) => {
    const { origin, original, live, parent, before, selected, goal, opposite, limited, conflictState } = item;
    return [file, { origin, original: encode(original), live, parent, before: encode(before), selected: encode(selected),
      goal: encode(goal), opposite: encode(opposite), limited, ...(conflictState && { conflictState: {
        baseline: encode(conflictState.baseline), goal: encode(conflictState.goal), limited: conflictState.limited,
        regions: [...conflictState.regions].map(([key, region]) => [key, { ...region, selected: encode(region.selected) }]),
        choices: [...conflictState.choices].map(([key, { strategy, data }]) => [key, { strategy, ...(data && { data: encode(data) }) }]),
      } }) }];
  });
  return { recoveries, buffers: [...buffers] };
}

function decodeRecoveries({ recoveries, buffers }, allowedPaths) {
  check(Array.isArray(recoveries) && recoveries.length <= allowedPaths.size && Array.isArray(buffers));
  const data = new Map();
  let size = 0;
  for (const [hash, encoded] of buffers) {
    check(typeof hash === 'string' && hashPattern.test(hash) && !data.has(hash) &&
      typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_FILE / 3) * 4);
    const bytes = Buffer.from(encoded, 'base64');
    size += bytes.length;
    check(bytes.length <= MAX_FILE && size <= MAX_BATCH_BYTES && hashBytes(bytes) === hash);
    data.set(hash, bytes);
  }
  const decode = (hash) => {
    check(data.has(hash));
    return data.get(hash);
  };
  const restored = new Map();
  for (const [file, item] of recoveries) {
    check(validPath(file) && allowedPaths.has(file) && !restored.has(file));
    const { origin, original, live, parent, before, selected, goal, opposite, limited, conflictState } = item;
    check(hostVersion(origin) && origin.hash === original && hostVersion(live) && live.hash === before && identity(parent) && typeof limited === 'boolean');
    const candidate = { origin, original: decode(original), live, parent, before: decode(before), selected: decode(selected),
      goal: decode(goal), opposite: decode(opposite), limited };
    if (conflictState) {
      const baseline = decode(conflictState.baseline);
      const regions = new Map();
      const choices = new Map();
      check(Array.isArray(conflictState.regions) && Array.isArray(conflictState.choices) && typeof conflictState.limited === 'boolean');
      let offset = 0;
      for (const [key, { start, end, line, selected }] of conflictState.regions) {
        check(validJournalId(key) && !regions.has(key) && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
          start >= offset && end >= start && end <= baseline.length && Number.isInteger(line) && line > 0);
        regions.set(key, { start, end, line, selected: decode(selected) });
        offset = end;
      }
      for (const [key, choice] of conflictState.choices) {
        check(regions.has(key) && !choices.has(key) && strategy(choice.strategy));
        choices.set(key, { strategy: choice.strategy, ...(choice.strategy === 'manual' && { data: decode(choice.data) }) });
      }
      candidate.conflictState = { baseline, goal: decode(conflictState.goal), limited: conflictState.limited, regions, choices };
    }
    restored.set(file, candidate);
  }
  return restored;
}

function workerReplayDraftStore(storage) {
  const folder = path.join(storage, 'replay-drafts');
  const filename = (project, { root, direction, selection }) => {
    const projectKey = hashBytes(Buffer.from(project.id));
    const key = hashBytes(Buffer.from(JSON.stringify([root, direction, [...selection].sort()])));
    return path.join(folder, `${projectKey}-${key}.json`);
  };

  function save(project, scope, snapshot) {
    const target = filename(project, scope);
    const { rebased, ...rest } = snapshot;
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...rest, ...encodeRecoveries(rebased) }));
    check(bytes.length <= MAX_STORAGE_BYTES);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    check(directoryIdentity(folder));
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, target);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* The rename may already have committed. */ }
    }
    try {
      const prefix = path.basename(target).slice(0, 65);
      const older = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() &&
        entry.name.startsWith(prefix) && hashPattern.test(entry.name.slice(65, -5)) && entry.name.endsWith('.json'))
        .map(({ name }) => path.join(folder, name)).filter((file) => file !== target)
        .map((file) => ({ file, time: fs.lstatSync(file).mtimeMs })).sort((a, b) => b.time - a.time);
      for (const { file } of older.slice(MAX_SAVED_DRAFTS - 1)) fs.unlinkSync(file);
    } catch { /* Retention is best effort after the draft has been committed. */ }
  }

  function load(project, scope, allowedPaths) {
    const target = filename(project, scope);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return null;
    check(directoryIdentity(folder) && stat.isFile() && stat.nlink === 1 && stat.size <= MAX_STORAGE_BYTES);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      check(opened.isFile() && opened.nlink === 1 && opened.ino === stat.ino && opened.dev === stat.dev && opened.size === stat.size);
      const bytes = Buffer.alloc(opened.size);
      check(fs.readSync(fd, bytes, 0, bytes.length, 0) === bytes.length);
      const snapshot = JSON.parse(bytes.toString('utf8'));
      check(snapshot?.version === 1);
      for (const field of ['selectable', 'included', 'unavailable']) {
        check(Array.isArray(snapshot[field]) && snapshot[field].length <= allowedPaths.size &&
          snapshot[field].every((file) => validPath(file) && allowedPaths.has(file)));
      }
      check(Array.isArray(snapshot.regular) && snapshot.regular.length <= MAX_ENTRIES &&
        snapshot.regular.every(([file, fingerprint]) => validPath(file) && allowedPaths.has(file) && hashPattern.test(fingerprint)));
      const rebased = decodeRecoveries(snapshot, allowedPaths);
      const allowed = new Map();
      for (const [file, { conflictState }] of rebased) {
        for (const key of conflictState?.regions.keys() ?? []) {
          check(!allowed.has(key));
          allowed.set(key, file);
        }
      }
      return { ...snapshot, rebased, drafts: draftItems(snapshot.drafts, allowed) };
    } finally { fs.closeSync(fd); }
  }

  function discard(project, scope) {
    try {
      if (directoryIdentity(folder)) fs.rmSync(filename(project, scope), { force: true });
    } catch { /* An obsolete draft cannot match a changed journal revision. */ }
  }

  return { save, load, discard };
}

module.exports = { workerReplayDraftStore, draftItems };
