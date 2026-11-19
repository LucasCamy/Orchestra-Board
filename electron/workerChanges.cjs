const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { diffPreview } = require('./diffPreview.cjs');
const { exec } = require('./workerSandbox.cjs');
const { validPath, checkedPath, readFileState, directoryIdentity, hashBytes, MAX_FILE, MAX_BATCH_BYTES, MAX_ENTRIES } = require('./workerChangePaths.cjs');
const { workerUndoStore, fileParentIdentity, validJournalId } = require('./workerUndo.cjs');
const { applyReplayLines, selectableReplayLines } = require('./workerReplayHunks.cjs');
const { createInlineReview, validateInlineRanges, projectInlineLine } = require('./workerReplayInline.cjs');
const { replayChanges, mergeReplayChanges, applyChanges: applyReplayChanges, MAX_CONFLICT_DETAILS } = require('./workerReplayMerge.cjs');

const MAX_REVIEW = 500;
const MAX_SELECTION = 200;
const MAX_HISTORY = 20;
const REPLAY_PREVIEW_TTL = 5 * 60 * 1000;
const platformUsesMode = process.platform !== 'win32';
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const fail = (key, file) => Object.assign(new Error(key), { reviewKey: key, file });
const sameState = (a, b) => a === null || b === null ? a === b :
  Boolean(a?.hash && a.hash === b?.hash && (!platformUsesMode || a.executable === b.executable));
const usable = (state) => !state || Boolean(state.hash);
const folded = (file) => file.normalize('NFC').toLowerCase();
const fileVersion = (state) => state && { hash: state.hash, executable: state.executable };
const hostFileVersion = (state) => state && { ...fileVersion(state), mode: state.mode };
const sameHostState = (a, b) => sameState(a, b) && a?.mode === b?.mode;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const editorText = (text) => text?.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') ?? null;

function inventory(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw fail('workerChanges.failed');
  const files = new Map();
  for (const [file, state] of entries) {
    if (!validPath(file) || files.has(file) || !state ||
      !(state.large === true || state.unsafe === true || (/^[a-f0-9]{64}$/.test(state.hash) && typeof state.executable === 'boolean'))) {
      throw fail('workerChanges.failed');
    }
    files.set(file, state);
  }
  return files;
}

async function ignoredFiles(cwd, files) {
  if (!files.length) return new Set();
  try {
    const output = await exec('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-z', '--stdin'], {
      cwd, env: gitEnv, input: Buffer.from(files.join('\0') + '\0'),
    });
    return new Set(output.toString('utf8').split('\0'));
  } catch (error) {
    if (error.code === 1 || error.code === 128 || error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function scopeCollisions(paths) {
  const result = new Set();
  const exact = new Map();
  for (const file of paths) {
    let parent = '';
    for (const part of file.split('/')) {
      parent += (parent ? '/' : '') + part;
      const key = folded(parent);
      if (exact.has(key) && exact.get(key) !== parent) result.add(key);
      else exact.set(key, parent);
    }
  }
  return (file) => {
    let parent = '';
    return file.split('/').some((part) => {
      parent += (parent ? '/' : '') + part;
      return result.has(folded(parent));
    });
  };
}

function createWorkerChanges(profile, sandbox) {
  const storage = path.join(profile, 'worker-reviews');
  const undoStore = workerUndoStore(storage, MAX_SELECTION, fail);
  const inits = new Map();
  const reviews = new Map();
  const replayPreviews = new Map();
  const filename = (project) => path.join(storage, project.id + '.json');

  function loadBase(project) {
    try {
      const saved = JSON.parse(fs.readFileSync(filename(project), 'utf8'));
      return makeBase(saved);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function makeBase({ legacy, entries, unobserved = [], undo = null, redo = null,
    history = undo || redo ? [{ id: (undo ?? redo).id, appliedAt: null, undo, redo }] : [] }) {
    const files = inventory(entries);
    if (!Array.isArray(unobserved) || !unobserved.every((file) => files.has(file))) throw fail('workerChanges.failed');
    if (!Array.isArray(history) || history.length > MAX_HISTORY) throw fail('workerChanges.undoUnavailable');
    const ids = new Set();
    for (const batch of history) {
      if (!validJournalId(batch?.id) || ids.has(batch.id) ||
          (batch.appliedAt !== null && (!Number.isSafeInteger(batch.appliedAt) || batch.appliedAt < 0 || batch.appliedAt > 8.64e15))) {
        throw fail('workerChanges.undoUnavailable');
      }
      ids.add(batch.id);
      const undo = undoStore.validate(batch.undo);
      const redo = undoStore.validate(batch.redo);
      if (!undo && !redo) throw fail('workerChanges.undoUnavailable');
      if (undo && redo) {
        if (undo.id === redo.id || undo.root !== redo.root) throw fail('workerChanges.undoUnavailable');
        const bySlot = new Map(undo.entries.map((entry) => [entry.slot, entry]));
        const independent = redo.entries.filter((entry) => {
          const paired = bySlot.get(entry.slot);
          return !(entry.split && paired?.split && entry.file === paired.file &&
            entry.change.parent === paired.change.parent && sameHostState(entry.change.after, paired.change.after) &&
            sameState(entry.workerAfter, paired.workerAfter) &&
            Boolean(entry.unobservedAfter) === Boolean(paired.unobservedAfter));
        });
        undoStore.validate({ ...undo, entries: [...undo.entries, ...independent] });
      }
    }
    return { legacy: legacy === true, files, unobserved: new Set(unobserved), history };
  }

  function saveBase(project, base) {
    fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
    const target = filename(project);
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      const { legacy, files, unobserved, history } = base;
      fs.writeFileSync(temp, JSON.stringify({ legacy, entries: [...files], unobserved: [...unobserved], history }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, target);
      replayPreviews.delete(project.id);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* A completed rename has already committed the state. */ }
    }
  }

  function initialize(project, startWorker = true) {
    let pending = inits.get(project.id);
    if (pending) return pending;
    const saved = loadBase(project);
    pending = (async () => {
      if (saved || !startWorker) {
        const exists = await sandbox.volumeExists(project);
        if (saved && exists) return saved;
        if (!startWorker && !exists) throw fail('workerChanges.notStarted');
      }
      const base = makeBase(await sandbox.workerFiles(project, 'initialize'));
      base.history = loadBase(project)?.history ?? [];
      saveBase(project, base);
      return base;
    })().finally(() => inits.delete(project.id));
    inits.set(project.id, pending);
    return pending;
  }

  async function review(project) {
    const id = randomUUID();
    reviews.set(project.id, { id });
    const base = await initialize(project, false);
    const result = await sandbox.workerFiles(project, 'inventory');
    if (result?.unavailable) throw fail('workerChanges.notStarted');
    const worker = inventory(result);
    const paths = [...new Set([...base.files.keys(), ...worker.keys()])].sort();
    const collides = scopeCollisions(paths);
    const ignore = await ignoredFiles(project.source, paths.filter((file) => !base.files.has(file)));
    const entries = [];
    let limited = false;
    for (const file of paths) {
      if (ignore.has(file)) continue;
      const original = base.files.get(file) ?? null;
      const proposed = worker.get(file) ?? null;
      if (!proposed && base.unobserved.has(file)) continue;
      if (sameState(original, proposed) || ((original?.large && proposed?.large) || (original?.unsafe && proposed?.unsafe))) continue;
      const host = readFileState(project.source, file);
      if (sameState(host, proposed)) continue;
      const status = proposed === null ? 'D' : host === null ? 'A' : 'M';
      const blocked = collides(file) || !usable(original) || !usable(proposed) || !usable(host) ? 'unsupported' :
        !sameState(host, original) ? 'conflict' : null;
      if (entries.length >= MAX_REVIEW) { limited = true; break; }
      entries.push({ file, host, proposed, status, blocked });
    }
    if (reviews.get(project.id)?.id !== id) throw fail('workerChanges.stale');
    reviews.set(project.id, { id, entries, seen: new Set(), at: Date.now() });
    return { id, limited, legacy: base.legacy, files: entries.map(({ file, status, blocked }, index) => ({ index, path: file, status, blocked })) };
  }

  function current(project, id) {
    const snapshot = reviews.get(project.id);
    if (!snapshot?.entries || snapshot.id !== id || Date.now() - snapshot.at > 30 * 60 * 1000) throw fail('workerChanges.stale');
    return snapshot;
  }

  async function blobs(project, entries) {
    const data = await sandbox.workerFiles(project, 'read', entries.map(({ file }) => file));
    if (data?.unavailable) throw fail('workerChanges.notStarted');
    if (data?.tooLarge) throw fail('workerChanges.batchLimit');
    if (!Array.isArray(data) || data.length !== entries.length) throw fail('workerChanges.failed');
    let sum = 0;
    return data.map((returned, index) => {
      const { file, proposed } = entries[index];
      if (!sameState(returned, proposed)) throw fail('workerChanges.stale', file);
      if (returned === null) return null;
      if (typeof returned.content !== 'string' || returned.content.length > Math.ceil(MAX_FILE / 3) * 4) throw fail('workerChanges.unsupported', file);
      const bytes = Buffer.from(returned.content, 'base64');
      if (bytes.length > MAX_FILE || returned.hash !== hashBytes(bytes)) throw fail('workerChanges.stale', file);
      sum += bytes.length;
      if (sum > MAX_BATCH_BYTES) throw fail('workerChanges.batchLimit');
      return bytes;
    });
  }

  const hostVersion = (project, entry) => {
    const state = readFileState(project.source, entry.file, true);
    if (!sameState(state, entry.host)) throw fail('workerChanges.stale', entry.file);
    return state;
  };

  async function diff(project, id, index) {
    const snapshot = current(project, id);
    const entry = Number.isSafeInteger(index) && snapshot.entries[index];
    if (!entry) throw fail('workerChanges.stale');
    if (entry.blocked === 'unsupported') throw fail('workerChanges.unsupported');
    const [proposed] = await blobs(project, [entry]);
    const host = hostVersion(project, entry);
    const texts = textVersions(host?.data, proposed);
    const result = texts ? await compare(host?.data, proposed) : { binary: true };
    current(project, id).seen.add(index);
    return { ...result, hostHash: host?.hash, workerHash: entry.proposed?.hash,
      ...(entry.blocked === 'conflict' && { conflict: {
        hostExists: host !== null,
        workerExists: entry.proposed !== null,
        ...(texts && { text: { host: editorText(texts.host), worker: editorText(texts.worker) } }),
      } }),
      modeChanged: platformUsesMode && host && entry.proposed && host.executable !== entry.proposed.executable };
  }

  async function apply(project, id, selection, verifyScope = () => {}) {
    const snapshot = current(project, id);
    if (!Array.isArray(selection) || !selection.length || selection.length > MAX_SELECTION) throw fail('workerChanges.batchLimit');
    const indexes = new Set();
    let draftBytes = 0;
    const selections = selection.map((item) => {
      const index = Number.isSafeInteger(item) ? item : item?.index;
      const entry = Number.isSafeInteger(index) && snapshot.entries[index];
      if (!entry || entry.blocked === 'unsupported' || !validPath(entry.file) || !snapshot.seen.has(index) || indexes.has(index)) {
        throw fail('workerChanges.stale');
      }
      indexes.add(index);
      const conflict = entry.blocked === 'conflict';
      const strategy = item?.strategy;
      if (conflict ? !['host', 'worker', 'manual'].includes(strategy) : !Number.isSafeInteger(item)) {
        throw fail('workerChanges.resolutionRequired', entry.file);
      }
      if (strategy === 'manual') {
        const content = item.content;
        if (typeof content !== 'string' || content.length > MAX_FILE || content.includes('\0') || !content.isWellFormed()) {
          throw fail('workerChanges.invalidResolution', entry.file);
        }
        draftBytes += Buffer.byteLength(content);
        if (draftBytes > MAX_BATCH_BYTES) throw fail('workerChanges.batchLimit');
      }
      return { entry, strategy: strategy ?? 'worker', content: strategy === 'manual' ? item.content : undefined };
    });
    const proposed = await blobs(project, selections.map(({ entry }) => entry));
    if (current(project, id) !== snapshot) throw fail('workerChanges.stale');
    verifyScope();
    const base = loadBase(project);
    if (!base) throw fail('workerChanges.stale');
    const root = directoryIdentity(project.source);
    if (!root) throw fail('workerChanges.stale');
    const journal = { id: randomUUID(), root, entries: [] };
    const writes = [];
    let resolved = 0;
    let outputBytes = 0;
    for (const [index, { entry, strategy, content }] of selections.entries()) {
      const { file, proposed: worker } = entry;
      const host = hostVersion(project, entry);
      const result = resolveContent(entry, strategy, content, host, proposed[index]);
      const resolution = entry.blocked === 'conflict';
      const record = { slot: index, file, resolution, change: null, unobserved: base.unobserved.has(file),
        workerBefore: fileVersion(base.files.get(file) ?? null), workerAfter: fileVersion(worker) };
      journal.entries.push(record);
      if (!sameState(host, result.state)) {
        outputBytes += result.data?.length ?? 0;
        if (outputBytes > MAX_BATCH_BYTES) throw fail('workerChanges.batchLimit');
        writes.push({ file, slot: index, host, ...result });
      }
      if (resolution) resolved++;
      // Acknowledge the reviewed worker version while keeping the host result independent.
      if (worker) base.files.set(file, worker);
      else base.files.delete(file);
      base.unobserved.delete(file);
    }
    if (base.files.size > MAX_ENTRIES) throw fail('workerChanges.batchLimit');
    const discarded = [];
    const history = [];
    for (const batch of base.history) {
      if (batch.redo) discarded.push(batch.redo);
      if (batch.undo?.root === root) history.push({ ...batch, redo: null });
      else if (batch.undo) discarded.push(batch.undo);
    }
    history.push({ id: journal.id, appliedAt: Date.now(), undo: journal, redo: null });
    if (history.length > MAX_HISTORY) discarded.push(history.shift().undo);
    base.history = history;
    saveWithBackups(project, base, journal.id, journal.entries, writes);
    for (const previous of discarded) undoStore.discard(project, previous.id, previous.entries);
    reviews.delete(project.id);
    return { applied: writes.length, ...(resolved && { resolved }) };
  }

  function saveWithBackups(project, base, archive, records, writes) {
    const recordsBySlot = new Map(records.map((record) => [record.slot, record]));
    try {
      undoStore.store(project, archive, writes);
      applyFiles(project.source, writes, (changes) => {
        for (const { write, applied, parent } of changes) {
          recordsBySlot.get(write.slot).change = { before: hostFileVersion(write.host), after: applied, parent };
        }
        saveBase(project, base);
      });
    } catch (error) {
      undoStore.discard(project, archive, records);
      throw error;
    }
  }

  function scopedHistory(project, base) {
    const root = directoryIdentity(project.source);
    return base?.history.filter(({ undo, redo }) => (undo ?? redo).root === root) ?? [];
  }

  function undoStatus(project) {
    const history = scopedHistory(project, loadBase(project));
    const describe = (journal) => journal && { id: journal.id, count: journal.entries.length };
    return {
      lastApplication: describe(history.findLast(({ undo }) => undo)?.undo ?? null),
      lastUndoneApplication: describe(history.find(({ redo }) => redo)?.redo ?? null),
      batches: history.toReversed().map(({ id, appliedAt, undo, redo }) => {
        const paths = new Set([...(undo?.entries ?? []), ...(redo?.entries ?? [])].sort((a, b) => a.slot - b.slot)
          .map(({ file }) => file));
        return { id, appliedAt, undo: describe(undo), redo: describe(redo), pathCount: paths.size, paths: [...paths].slice(0, 3) };
      }),
    };
  }

  function planReplay(project, base, history, selection, direction, includedFiles = null, rebased = new Map()) {
    const undoing = direction === 'undo';
    const opposite = undoing ? 'redo' : 'undo';
    const batches = undoing ? history.toReversed() : history;
    const selected = batches.filter(({ id }) => selection.has(id));
    if (selected.length !== selection.size || selected.some((batch) => batch[direction]?.id !== selection.get(batch.id))) {
      throw fail('workerChanges.' + direction + 'Stale');
    }
    const collides = scopeCollisions(selected.flatMap((batch) => batch[direction].entries.map(({ file }) => file)));
    // Simulate each transition in order. Keep the intermediate bytes in their existing archives until commit.
    const virtualFiles = new Map();
    const blockedPaths = new Set();
    const skippedPaths = new Map();
    const completedPaths = new Set();
    const initialTracking = new Map();
    const resolvedPaths = new Map();
    const embeddedSplits = new Set();
    const oppositeBackups = new Map();
    const journals = [];
    let resolutions = 0;
    const readHost = (file, version, parent) => {
      const actual = readFileState(project.source, file, true);
      if (!sameHostState(actual, version) || fileParentIdentity(project.source, file) !== parent) {
        throw fail('workerChanges.stale', file);
      }
      return actual?.data ?? null;
    };
    for (const batch of batches) {
      const journal = batch[direction];
      if (!journal) continue;
      if (!selection.has(batch.id)) {
        for (const { file } of journal.entries) blockedPaths.add(folded(file));
        continue;
      }
      const completed = [];
      const inverse = [];
      const backups = [];
      const pending = [];
      const counterpart = batch[opposite];
      const pairedByPath = new Map(counterpart?.entries.filter((entry) => entry.split).map((entry) => [entry.file, entry]));
      for (const record of journal.entries) {
        const { file, slot, change, workerBefore, workerAfter } = record;
        if (includedFiles && !includedFiles.has(file)) {
          pending.push(record);
          continue;
        }
        const trackedVersion = base.files.get(file) ?? null;
        const unobserved = base.unobserved.has(file);
        const tracked = unobserved === (record.unobservedAfter ?? false) && sameState(trackedVersion, workerAfter);
        let fileState = virtualFiles.get(file);
        let reason = null;
        if (blockedPaths.has(folded(file)) || collides(file)) reason = 'dependency';
        else if (!usable(trackedVersion) || (!change && !tracked)) reason = 'changed';
        else if (change) {
          if (!fileState) {
            const actual = hostFileVersion(readFileState(project.source, file, true));
            const parent = fileParentIdentity(project.source, file);
            const candidate = rebased.get(file);
            const recovered = candidate && candidate.parent === parent && sameHostState(actual, candidate.live) ? candidate : null;
            const initial = recovered
              ? { version: recovered.origin, read: () => recovered.original }
              : { version: actual, read: () => readHost(file, actual, parent) };
            fileState = { initial, current: initial, parent, recovered, staleRecovery: candidate && !recovered };
          }
          if (fileState.staleRecovery || !sameHostState(fileState.current.version, change.after) ||
              fileState.parent !== change.parent) reason = 'changed';
        }
        if (reason) {
          pending.push(record);
          if (!skippedPaths.has(file)) skippedPaths.set(file, reason);
          continue;
        }
        let reversedChange = null;
        const paired = record.split ? pairedByPath.get(file) : null;
        if (paired && initialTracking.has(file)) embeddedSplits.add(file);
        if (change) {
          const { current, parent } = fileState;
          const inverseHost = paired ? {
            version: paired.change.before,
            read: () => undoStore.read(project, paired.archive ?? counterpart.id, slot, paired.change.before.hash),
          } : current;
          if (paired && !initialTracking.has(file)) oppositeBackups.set(file, inverseHost.read);
          if (inverseHost.version) backups.push({ slot, host: inverseHost.version, readHost: inverseHost.read });
          const before = change.before;
          fileState.current = {
            version: before,
            read: () => before ? undoStore.read(project, record.archive ?? journal.id, slot, before.hash) : null,
          };
          virtualFiles.set(file, fileState);
          reversedChange = { before: inverseHost.version, after: before, parent };
        }
        if (!initialTracking.has(file)) {
          initialTracking.set(file, { version: fileVersion(trackedVersion), unobserved });
        }
        if (tracked) {
          if (workerBefore) base.files.set(file, workerBefore);
          else base.files.delete(file);
          if (record.unobserved) base.unobserved.add(file);
          else base.unobserved.delete(file);
          if (record.resolution) {
            resolutions++;
            resolvedPaths.set(file, (resolvedPaths.get(file) ?? 0) + 1);
          }
        }
        completed.push(record);
        completedPaths.add(file);
        inverse.push({
          file, slot, change: reversedChange, resolution: Boolean(tracked && (record.resolution || paired?.resolution)),
          workerBefore: paired && tracked ? paired.workerBefore : fileVersion(trackedVersion), workerAfter: fileVersion(base.files.get(file) ?? null),
          unobserved: paired && tracked ? paired.unobserved : unobserved, unobservedAfter: base.unobserved.has(file),
        });
      }
      // Omitted and skipped records stay in the journal and still constrain later replay steps.
      for (const { file } of pending) blockedPaths.add(folded(file));
      if (completed.length) {
        batch[direction] = pending.length ? { ...journal, entries: pending } : null;
        journals.push({ batch, journal, counterpart, completed, inverse, backups, remainder: [], remainderBackups: [] });
      }
    }
    if (base.files.size > MAX_ENTRIES) throw fail('workerChanges.batchLimit');
    const writes = [];
    const verify = [];
    const files = [];
    for (const file of new Set([...completedPaths, ...skippedPaths.keys()])) {
      const versions = virtualFiles.get(file);
      let effect = completedPaths.has(file) ? 'history' : null;
      if (versions) {
        const { initial, current, parent, recovered } = versions;
        if (sameHostState(initial.version, current.version)) verify.push(initial.read);
        else {
          effect = !initial.version ? 'create' : !current.version ? 'delete' : 'modify';
          writes.push({
            file, parent, host: recovered?.live ?? initial.version,
            readHost: recovered ? () => readHost(file, recovered.live, parent) : initial.read,
            readData: recovered ? () => recovered.goal : current.read,
            state: recovered ? { ...fileVersion(recovered.live), hash: hashBytes(recovered.goal) } : fileVersion(current.version),
            mode: current.version?.mode,
            selectableHunks: !recovered && !embeddedSplits.has(file) &&
              Boolean(initial.version && current.version && initial.version.mode === current.version.mode),
            oppositeBackup: oppositeBackups.get(file), recovered,
          });
        }
      }
      files.push({ path: file, effect, skipped: skippedPaths.get(file) ?? null });
    }
    return { journals, direction, opposite, writes, verify, files, resolutions, initialTracking, resolvedPaths,
      skipped: [...skippedPaths.keys()] };
  }

  function commitReplay(project, base, plan) {
    const { journals, direction, opposite, writes, verify } = plan;
    if (!journals.length) return;
    const verifyRoot = () => {
      if (directoryIdentity(project.source) !== journals[0].journal.root) throw fail('workerChanges.stale');
    };
    verifyRoot();
    const archives = [];
    const replaced = [];
    const archive = (entries, backups) => {
      const id = randomUUID();
      archives.push({ id, entries });
      undoStore.store(project, id, backups);
      return id;
    };
    try {
      for (const { batch, journal, counterpart, inverse, backups, remainder, remainderBackups } of journals) {
        if (remainder.length) {
          const id = archive(remainder, remainderBackups);
          const pending = batch[direction]?.entries.map((record) => ({ ...record, archive: record.archive ?? journal.id })) ?? [];
          batch[direction] = { id, root: journal.root, entries: [...pending, ...remainder].sort((a, b) => a.slot - b.slot) };
        }
        if (inverse.length) {
          const id = archive(inverse, backups);
          const slots = new Set(inverse.map(({ slot }) => slot));
          const previous = [];
          for (const record of counterpart?.entries ?? []) {
            if (slots.has(record.slot)) replaced.push([counterpart.id, record]);
            else previous.push({ ...record, archive: record.archive ?? counterpart.id });
          }
          batch[opposite] = { id, root: journal.root, entries: [...previous, ...inverse].sort((a, b) => a.slot - b.slot) };
        }
      }
      base.history = base.history.filter(({ undo, redo }) => undo || redo);
      applyFiles(project.source, writes, () => {
        verifyRoot();
        for (const check of verify) check();
        saveBase(project, base);
      });
    } catch (error) {
      for (const { id, entries } of archives) undoStore.discard(project, id, entries);
      throw error;
    }
    for (const { journal, completed } of journals) undoStore.discard(project, journal.id, completed);
    for (const [id, record] of replaced) undoStore.discard(project, id, [record]);
    reviews.delete(project.id);
  }

  function checkHunkVersions(write, patch) {
    if (!write.selectableHunks || write.host.hash !== patch.beforeHash || write.state.hash !== patch.afterHash || write.mode !== patch.mode) {
      throw fail('workerChanges.historyPreviewStale', write.file);
    }
  }

  function partialProjection(write, patch, before, after) {
    checkHunkVersions(write, patch);
    const overrides = new Map();
    for (const { group, projected } of patch.inline.values()) {
      // The addition slot preserves the order of paired replacements within the diff block.
      if (group.removed !== undefined) overrides.set(group.removed, group.added === undefined ? projected : null);
      if (group.added !== undefined) overrides.set(group.added, projected);
    }
    const data = applyReplayLines(before, after, patch.edits, patch.selected, overrides);
    if (data.length > MAX_FILE) throw fail('workerChanges.historyHunkLimit', write.file);
    return data;
  }

  function applyPartialSelections(project, base, plan, patches) {
    const selectedFiles = new Set([...patches.keys(), ...plan.writes.filter(({ recovered }) => recovered).map(({ file }) => file)]);
    if (!selectedFiles.size) return;
    const stepsByFile = new Map();
    for (const group of plan.journals) {
      for (const record of group.inverse) {
        if (!selectedFiles.has(record.file)) continue;
        if (!stepsByFile.has(record.file)) stepsByFile.set(record.file, []);
        stepsByFile.get(record.file).push({ group, record });
      }
    }
    plan.writes = plan.writes.map((write) => {
      const patch = patches.get(write.file);
      const { file, host, parent, recovered } = write;
      if (!patch && !recovered) return write;
      const readPartial = recovered ? () => recovered.selected : () => partialProjection(write, patch, write.readHost(), write.readData());
      const partial = { ...host, hash: hashBytes(readPartial()) };
      const steps = stepsByFile.get(file);
      const [{ group: anchor, record: first }] = steps;
      const { record: last } = steps.at(-1);
      const tracking = plan.initialTracking.get(file);
      const resolved = plan.resolvedPaths.get(file) ?? 0;
      const counterpart = anchor.counterpart?.entries.find((record) => record.file === file);
      const returnVersion = recovered ? { ...host, hash: hashBytes(recovered.opposite) } : counterpart?.change.before ?? host;
      const goal = { ...write.state, mode: write.mode };
      const readReturn = recovered ? () => recovered.opposite : counterpart
        ? () => undoStore.read(project, counterpart.archive ?? anchor.counterpart.id, first.slot, returnVersion.hash)
        : write.readHost;

      for (const { group, record } of steps) {
        group.inverse = group.inverse.filter((entry) => entry !== record);
        group.backups = group.backups.filter(({ slot }) => slot !== record.slot);
      }
      // Keep the remaining and already replayed portions as opposite destinations from the same working version.
      const shared = { file, slot: first.slot, split: true, workerAfter: tracking.version, unobservedAfter: tracking.unobserved };
      anchor.remainder.push({
        ...shared, workerBefore: last.workerAfter, unobserved: last.unobservedAfter, resolution: resolved > 0,
        change: { before: goal, after: partial, parent },
      });
      anchor.remainderBackups.push({ slot: first.slot, host: goal, readHost: write.readData });
      anchor.inverse.push({
        ...shared, workerBefore: first.workerBefore, unobserved: first.unobserved, resolution: counterpart?.resolution ?? false,
        change: { before: returnVersion, after: partial, parent },
      });
      anchor.backups.push({ slot: first.slot, host: returnVersion, readHost: readReturn });
      if (tracking.version) base.files.set(file, tracking.version);
      else base.files.delete(file);
      if (tracking.unobserved) base.unobserved.add(file);
      else base.unobserved.delete(file);
      plan.resolutions -= resolved;
      return { ...write, readData: readPartial, state: fileVersion(partial) };
    });
  }

  function replayResult({ writes, resolutions, skipped }, direction) {
    return direction === 'undo'
      ? { restored: writes.length, reopened: resolutions, skipped }
      : { reapplied: writes.length, resolved: resolutions, skipped };
  }

  function replay(project, id, direction, batchId) {
    const base = loadBase(project);
    const history = scopedHistory(project, base);
    const batch = batchId === undefined
      ? history[direction === 'undo' ? 'findLast' : 'find']((entry) => entry[direction])
      : history.find((entry) => entry.id === batchId);
    if (!batch?.[direction] || batch[direction].id !== id) throw fail('workerChanges.' + direction + 'Stale');
    const plan = planReplay(project, base, history, new Map([[batch.id, id]]), direction);
    commitReplay(project, base, plan);
    return replayResult(plan, direction);
  }

  function replayFingerprint({ files, journals, writes }) {
    return hashBytes(Buffer.from(JSON.stringify({
      files, journals: journals.map(({ journal, counterpart, inverse }) => ({ journal, counterpart, inverse })),
      writes: writes.map(({ file, host, state, mode, parent, recovered }) => ({
        file, host, state, mode, parent, selectedHash: recovered && hashBytes(recovered.selected),
      })),
    })));
  }

  function replayPreviewSummary(preview) {
    const lines = [];
    for (const [path, patch] of preview.patches) {
      if (preview.writes.has(path)) lines.push({
        path, selected: patch.selected.length, total: patch.edits.length,
        ...(patch.inline.size && { textSelections: patch.inline.size }),
      });
    }
    const rebasedFiles = [...preview.writes.values()].filter(({ recovered }) => recovered).map(({ file }) => file);
    const selectionConflicts = [...(preview.selectionConflicts ?? [])].map(([path, info]) => ({ path, ...info }));
    const resolvableConflicts = [];
    for (const [path, recovered] of preview.rebased ?? []) {
      if (recovered.conflictState && canResolveReplayConflict(preview, path)) {
        resolvableConflicts.push({ path, keys: [...recovered.conflictState.regions.keys()] });
      }
    }
    return { id: preview.id, ...preview.summary, lines, rebasedFiles, selectionConflicts, resolvableConflicts,
      unavailableFiles: [...(preview.unavailableFiles ?? [])] };
  }

  function storeReplayPreview(project, plan, options, previous) {
    const id = randomUUID();
    const now = Date.now();
    for (const [projectId, preview] of replayPreviews) {
      if (preview.expires <= now) replayPreviews.delete(projectId);
    }
    const summary = { files: plan.files, selected: options.selection.size, ready: plan.journals.length };
    const writes = new Map(plan.writes.map((write) => [write.file, write]));
    const hunkCatalogs = new Map();
    for (const [file, catalog] of previous?.hunkCatalogs ?? []) {
      if (sameReplayWrite(writes.get(file), previous.writes.get(file))) hunkCatalogs.set(file, catalog);
    }
    const preview = {
      ...options, id, fingerprint: replayFingerprint(plan), expires: now + REPLAY_PREVIEW_TTL,
      writes, summary, hunkCatalogs,
    };
    replayPreviews.set(project.id, preview);
    return replayPreviewSummary(preview);
  }

  function previewReplay(project, direction, items) {
    if (!['undo', 'redo'].includes(direction) || !Array.isArray(items) || !items.length || items.length > MAX_HISTORY) {
      throw fail('workerChanges.historySelection');
    }
    const selection = new Map();
    for (const item of items) {
      if (!validJournalId(item?.batchId) || !validJournalId(item?.id) || selection.has(item.batchId)) {
        throw fail('workerChanges.historySelection');
      }
      selection.set(item.batchId, item.id);
    }
    const base = loadBase(project);
    const history = scopedHistory(project, base);
    const firstJournal = history[0]?.undo ?? history[0]?.redo;
    const plan = planReplay(project, base, history, selection, direction);
    const selectableFiles = new Set(plan.files.filter(({ effect }) => effect).map(({ path }) => path));
    return storeReplayPreview(project, plan, { direction, selection, root: firstJournal.root, selectableFiles, patches: new Map() });
  }

  function findReplayPreview(project, id) {
    const preview = replayPreviews.get(project.id);
    if (!preview || preview.id !== id || directoryIdentity(project.source) !== preview.root) return null;
    return preview;
  }

  function currentReplayPreview(project, id) {
    const preview = findReplayPreview(project, id);
    if (!preview || preview.invalidated || preview.expires <= Date.now()) throw fail('workerChanges.historyPreviewStale');
    return preview;
  }

  function sameReplayWrite(next, previous) {
    return Boolean(next && previous && next.parent === previous.parent && next.mode === previous.mode &&
      sameHostState(next.host, previous.host) && sameState(next.state, previous.state));
  }

  function updateReplayPreview(project, id, paths) {
    const previous = currentReplayPreview(project, id);
    const { direction, selection, root, selectableFiles, patches, rebased, selectionConflicts, unavailableFiles } = previous;
    if (!Array.isArray(paths) || paths.length > selectableFiles.size) throw fail('workerChanges.historyFileSelection');
    const includedFiles = new Set();
    for (const file of paths) {
      if (!validPath(file) || !selectableFiles.has(file) || unavailableFiles?.has(file) || includedFiles.has(file)) {
        throw fail('workerChanges.historyFileSelection');
      }
      includedFiles.add(file);
    }
    const base = loadBase(project);
    const plan = planReplay(project, base, scopedHistory(project, base), selection, direction, includedFiles, rebased);
    for (const write of plan.writes) {
      if (patches.has(write.file)) checkHunkVersions(write, patches.get(write.file));
    }
    const next = storeReplayPreview(project, plan, {
      direction, selection, root, selectableFiles, includedFiles, patches, rebased, selectionConflicts, unavailableFiles,
    }, previous);
    return { ...next, retained: retainedReplayFiles(plan, previous) };
  }

  function retainedReplayFiles(plan, previous) {
    return plan.writes.filter((write) => sameReplayWrite(write, previous.writes.get(write.file))).map(({ file }) => file);
  }

  async function mergeReplayText(base, live, selected, describeConflicts = false) {
    if (!textVersions(base, live) || !textVersions(base, selected)) return null;
    if (base.equals(live)) return { data: selected, conflicts: 0 };
    if (base.equals(selected) || live.equals(selected)) return { data: live, conflicts: 0 };
    const local = replayChanges(base, live, await compare(base, live));
    const intended = replayChanges(base, selected, await compare(base, selected));
    return mergeReplayChanges(base, local, intended, describeConflicts);
  }

  function recoverySize({ original, before, selected, goal, opposite, conflictState }) {
    const buffers = new Set([original, before, selected, goal, opposite]);
    if (conflictState) {
      buffers.add(conflictState.baseline);
      buffers.add(conflictState.goal);
      for (const region of conflictState.regions.values()) buffers.add(region.selected);
      for (const choice of conflictState.choices.values()) if (choice.data) buffers.add(choice.data);
    }
    return [...buffers].reduce((sum, bytes) => sum + bytes.length, 0);
  }

  function verifyReplayRecovery(project, file, recovered) {
    const live = readFileState(project.source, file, true);
    if (!sameHostState(live, recovered.live) || fileParentIdentity(project.source, file) !== recovered.parent) {
      throw fail('workerChanges.historyPreviewStale', file);
    }
  }

  function conflictChoiceData(region, choice) {
    return choice?.strategy === 'selected' ? region.selected : choice?.data;
  }

  async function retainReplayConflicts(recovered, projected, fresh) {
    const state = recovered?.conflictState;
    if (!state) return [];
    const before = recovered.selected;
    const edits = replayChanges(before, projected, before.equals(projected) ? {} : await compare(before, projected));
    if (!edits) return [];
    const retained = [];
    let chosenOffset = 0;
    let liveOffset = 0;
    let index = 0;
    for (const [key, region] of state.regions) {
      const replacement = conflictChoiceData(region, state.choices.get(key));
      if (replacement && !replacement.equals(state.baseline.subarray(region.start, region.end))) {
        chosenOffset += replacement.length - (region.end - region.start);
        continue;
      }
      const start = region.start + chosenOffset;
      const end = region.end + chosenOffset;
      // An insertion on a boundary can change which fragment a resolution belongs to.
      while (index < edits.length && (edits[index].end < start || (edits[index].end === start && edits[index].start < start))) {
        const edit = edits[index++];
        liveOffset += edit.data.length - (edit.end - edit.start);
      }
      const next = edits[index];
      if (next && (next.start < end || (next.start === end && (start === end || next.start === next.end)))) continue;
      const moved = { ...region, start: start + liveOffset, end: end + liveOffset };
      if (fresh.some(({ start, end }) => moved.start <= end && start <= moved.end) ||
          !before.subarray(start, end).equals(projected.subarray(moved.start, moved.end))) continue;
      retained.push([key, moved]);
    }
    return retained;
  }

  async function recoverReplayWrite(project, previous, file, write, drafts) {
    const patch = previous.patches.get(file);
    const catalog = previous.hunkCatalogs.get(file) ?? patch;
    if (!write.recovered && !patch && !drafts) return null;
    const base = write.recovered?.before ?? catalog?.snapshot;
    if (!base || !write.host || !write.state) return null;
    const live = readFileState(project.source, file, true);
    if (!live?.hash || live.mode !== write.host.mode || fileParentIdentity(project.source, file) !== write.parent) return null;
    const full = write.readData();
    let selected = write.recovered?.selected;
    if (!selected) {
      const choices = new Set(patch?.selected ?? catalog.edits.keys());
      const inline = new Map(patch?.inline);
      for (const [line, ranges] of drafts ?? []) {
        applyInlineSelection(choices, inline, reviewInline(catalog, base, full, line), line, ranges);
      }
      selected = partialProjection(write, { ...catalog, selected: [...choices], inline }, base, full);
    }
    const merged = await mergeReplayText(base, live.data, selected, true);
    if (!merged) return null;
    const conflict = merged.conflicts ? { count: merged.conflicts, details: merged.details } : null;
    const fresh = merged.regions ?? [];
    const retained = await retainReplayConflicts(write.recovered, merged.data, fresh);
    if ((merged.data.equals(live.data) && !conflict && !retained.length) || merged.data.length > MAX_FILE) return { conflict };
    // Carry local edits forward through both directions of the split history entry.
    const goal = await mergeReplayText(selected, merged.data, full) ?? { data: merged.data, conflicts: 1 };
    const oldOpposite = write.recovered?.opposite ?? write.oppositeBackup?.();
    const opposite = oldOpposite
      ? await mergeReplayText(base, live.data, oldOpposite) ?? { data: live.data, conflicts: 1 }
      : { data: live.data, conflicts: 0 };
    if (goal.data.length > MAX_FILE || opposite.data.length > MAX_FILE) return { conflict };
    const recovered = {
      origin: write.recovered?.origin ?? write.host, original: write.recovered?.original ?? base,
      live: hostFileVersion(live), parent: write.parent, before: live.data, selected: merged.data,
      goal: goal.data, opposite: opposite.data, limited: Boolean(goal.conflicts || opposite.conflicts || write.recovered?.limited),
    };
    if (conflict || retained.length) {
      const regions = [...retained, ...fresh.map((region) => [randomUUID(), region])];
      regions.sort(([, a], [, b]) => a.start - b.start || a.end - b.end);
      recovered.conflictState = { baseline: merged.data, goal: goal.data, limited: recovered.limited, regions: new Map(regions), choices: new Map() };
    }
    return { recovered, conflict };
  }

  async function refreshReplayPreview(project, id, drafts = [], verifyScope = () => {}) {
    const previous = findReplayPreview(project, id);
    if (!previous) throw fail('workerChanges.historyRestartPreview');
    if (!Array.isArray(drafts) || drafts.length > MAX_SELECTION) throw fail('workerChanges.historyInlineBatchLimit');
    const staged = new Map();
    for (const draft of drafts) {
      const { file, line, ranges } = draft ?? {};
      const { catalog } = inlineFile(previous, file);
      if (!catalog.groups.has(line) || staged.get(file)?.has(line)) throw fail('workerChanges.historyInlineSelection');
      if (!staged.has(file)) staged.set(file, new Map());
      staged.get(file).set(line, ranges);
    }
    const { direction, selection, root, selectableFiles } = previous;
    const includedFiles = new Set(previous.includedFiles ?? selectableFiles);
    const rebased = new Map(previous.rebased);
    const selectionConflicts = new Map(previous.selectionConflicts);
    const unavailableFiles = new Set(previous.unavailableFiles);
    const writesToReview = new Map(previous.writes);
    for (const [file, candidate] of rebased) {
      if (writesToReview.has(file) || (!includedFiles.has(file) && !unavailableFiles.has(file))) continue;
      try { verifyReplayRecovery(project, file, candidate); }
      catch (error) {
        if (error.reviewKey !== 'workerChanges.historyPreviewStale') throw error;
        writesToReview.set(file, { recovered: candidate, host: candidate.live, state: candidate.live,
          parent: candidate.parent, readData: () => candidate.goal });
      }
    }
    const replan = () => {
      const base = loadBase(project);
      return planReplay(project, base, scopedHistory(project, base), selection, direction, includedFiles, rebased);
    };
    let plan = replan();
    const previousEffects = new Map(previous.summary.files.map(({ path, effect }) => [path, effect]));
    const nextWrites = new Map(plan.writes.map((write) => [write.file, write]));
    const recovered = [];
    const conflicts = [];
    const leaveOut = (file) => {
      conflicts.push(file);
      rebased.delete(file);
      includedFiles.delete(file);
      unavailableFiles.add(file);
    };
    let recoveryBytes = [...rebased.values()].reduce((size, result) => size + recoverySize(result), 0);
    for (const [file, write] of writesToReview) {
      if ((!includedFiles.has(file) && !unavailableFiles.has(file)) || sameReplayWrite(nextWrites.get(file), write)) continue;
      if (!previous.patches.has(file) && !staged.has(file) && !write.recovered) continue;
      if (rebased.has(file)) recoveryBytes -= recoverySize(rebased.get(file));
      const { recovered: result, conflict } = await recoverReplayWrite(project, previous, file, write, staged.get(file)) ?? {};
      if (conflict) {
        const prior = selectionConflicts.get(file);
        selectionConflicts.set(file, {
          count: (prior?.count ?? 0) + conflict.count,
          details: [...conflict.details, ...(prior?.details ?? [])].slice(0, MAX_CONFLICT_DETAILS),
        });
      }
      if (!result || recoveryBytes + recoverySize(result) > MAX_BATCH_BYTES) {
        leaveOut(file);
        continue;
      }
      recoveryBytes += recoverySize(result);
      if (result.selected.equals(result.before)) {
        // The file remains available for conflict resolution but has no replayable changes yet.
        includedFiles.delete(file);
        unavailableFiles.add(file);
        conflicts.push(file);
      } else {
        includedFiles.add(file);
        unavailableFiles.delete(file);
        recovered.push(file);
      }
      rebased.set(file, result);
    }
    const omitted = [];
    for (const { path, effect } of plan.files) {
      if (!effect || unavailableFiles.has(path)) continue;
      if (recovered.includes(path)) continue;
      const oldWrite = previous.writes.get(path);
      const newWrite = nextWrites.get(path);
      if (effect !== previousEffects.get(path) || ((oldWrite || newWrite) && !sameReplayWrite(newWrite, oldWrite))) {
        // Changed projections require a fresh selection instead of falling back to a whole file.
        includedFiles.delete(path);
        omitted.push(path);
      }
    }
    if (omitted.length || recovered.length || conflicts.length) plan = replan();
    const accepted = new Set(plan.writes.filter(({ recovered: write }) => write).map(({ file }) => file));
    for (const file of recovered) {
      if (!accepted.has(file)) leaveOut(file);
    }
    if (recovered.some((file) => !accepted.has(file))) plan = replan();
    if (findReplayPreview(project, id) !== previous) throw fail('workerChanges.historyPreviewStale');
    verifyScope();
    const retained = retainedReplayFiles(plan, previous).filter((file) => !recovered.includes(file));
    const patches = new Map(retained.filter((file) => previous.patches.has(file)).map((file) => [file, previous.patches.get(file)]));
    const recoveredWrites = plan.writes.filter(({ file, recovered: write }) => write && recovered.includes(file));
    const next = storeReplayPreview(project, plan, {
      direction, selection, root, selectableFiles, includedFiles, patches, rebased, selectionConflicts, unavailableFiles,
    }, previous);
    const conflictKeys = [...rebased.values()].flatMap(({ conflictState }) => [...(conflictState?.regions.keys() ?? [])]);
    return { ...next, included: [...includedFiles], retained, omitted, conflicts,
      recovered: recoveredWrites.map(({ file }) => file), conflictKeys,
      limited: recoveredWrites.filter(({ recovered: write }) => write.limited).length };
  }

  function replayHost(write) {
    try { return write.readHost(); }
    catch (error) {
      if (error.reviewKey === 'workerChanges.stale') throw fail('workerChanges.historyPreviewStale', write.file);
      throw error;
    }
  }

  function canResolveReplayConflict(preview, file) {
    return preview.includedFiles?.has(file) || preview.unavailableFiles?.has(file);
  }

  function replayConflicts(project, id, file) {
    const preview = currentReplayPreview(project, id);
    if (!validPath(file) || !preview.selectionConflicts?.has(file)) throw fail('workerChanges.historyConflictUnavailable');
    const recovered = preview.rebased?.get(file);
    const state = recovered?.conflictState;
    if (!state) return { regions: [] };
    if (canResolveReplayConflict(preview, file)) verifyReplayRecovery(project, file, recovered);
    return { regions: [...state.regions].map(([key, { start, end, line, selected }]) => {
      const choice = state.choices.get(key);
      return { key, line, local: state.baseline.toString('utf8', start, end), selected: selected.toString('utf8'),
        choice: choice?.strategy ?? 'local', ...(choice?.data && { content: choice.data.toString('utf8') }) };
    }) };
  }

  function manualReplayResolution(file, recovered, { start, end, selected }, content) {
    if (typeof content !== 'string' || content.length > MAX_FILE || !content.isWellFormed() ||
        content.includes('\0') || Buffer.byteLength(content) > MAX_FILE) throw fail('workerChanges.invalidResolution', file);
    const local = recovered.conflictState.baseline.subarray(start, end);
    const normalize = (text) => text.replace(/\r\n?/g, '\n');
    const text = normalize(content);
    const localText = local.toString('utf8');
    const selectedText = selected.toString('utf8');
    if (text === normalize(localText)) return local;
    if (text === normalize(selectedText)) return selected;
    const eol = /\r\n|\r|\n/.exec(localText)?.[0] ?? /\r\n|\r|\n/.exec(recovered.before.toString('utf8'))?.[0] ??
      /\r\n|\r|\n/.exec(selectedText)?.[0] ?? '\n';
    return Buffer.from(text.replace(/\n/g, eol));
  }

  async function replayConflictProjection(file, recovered, choices) {
    const state = recovered.conflictState;
    const edits = [];
    let length = state.baseline.length;
    for (const [key, region] of state.regions) {
      const { start, end } = region;
      const data = conflictChoiceData(region, choices.get(key));
      if (data) {
        length += data.length - (end - start);
        edits.push({ start, end, data });
      }
    }
    if (length > MAX_FILE) throw fail('workerChanges.invalidResolution', file);
    const selected = edits.length ? applyReplayChanges(state.baseline, edits) : state.baseline;
    const goal = await mergeReplayText(state.baseline, selected, state.goal) ?? { data: selected, conflicts: 1 };
    if (goal.data.length > MAX_FILE) throw fail('workerChanges.invalidResolution', file);
    return { ...recovered, selected, goal: goal.data, limited: Boolean(state.limited || goal.conflicts),
      conflictState: { ...state, choices } };
  }

  async function resolveReplayConflicts(project, id, items, verifyScope = () => {}, uniformStrategy) {
    const previous = currentReplayPreview(project, id);
    let limit = 0;
    for (const [file, recovered] of previous.rebased ?? []) {
      if (canResolveReplayConflict(previous, file)) limit += recovered.conflictState?.regions.size ?? 0;
    }
    if (!Array.isArray(items) || !items.length || items.length > limit) throw fail('workerChanges.historyConflictUnavailable');

    const grouped = new Map();
    let manualBytes = 0;
    for (const item of items) {
      const { file, key, content } = item ?? {};
      const strategy = uniformStrategy ?? item?.strategy;
      const recovered = validPath(file) && previous.rebased?.get(file);
      const region = recovered?.conflictState?.regions.get(key);
      if (!region || !canResolveReplayConflict(previous, file) || !['local', 'selected', 'manual'].includes(strategy)) {
        throw fail('workerChanges.historyConflictUnavailable');
      }
      if (!grouped.has(file)) grouped.set(file, new Map());
      const resolutions = grouped.get(file);
      if (resolutions.has(key)) throw fail('workerChanges.historyConflictUnavailable');
      const data = strategy === 'manual' ? manualReplayResolution(file, recovered, region, content) : undefined;
      if (data) {
        manualBytes += data.length;
        if (data.length > MAX_FILE || manualBytes > MAX_BATCH_BYTES) throw fail('workerChanges.invalidResolution', file);
      }
      resolutions.set(key, { strategy, data });
    }
    for (const file of grouped.keys()) verifyReplayRecovery(project, file, previous.rebased.get(file));

    const rebased = new Map(previous.rebased);
    let bytes = [...rebased.values()].reduce((sum, candidate) => sum + recoverySize(candidate), 0);
    for (const [file, resolutions] of grouped) {
      const recovered = rebased.get(file);
      const choices = new Map([...recovered.conflictState.choices, ...resolutions]);
      const revised = await replayConflictProjection(file, recovered, choices);
      bytes += recoverySize(revised) - recoverySize(recovered);
      rebased.set(file, revised);
    }
    if (bytes > MAX_BATCH_BYTES) throw fail('workerChanges.invalidResolution');
    currentReplayPreview(project, id);
    verifyScope();
    for (const file of grouped.keys()) verifyReplayRecovery(project, file, previous.rebased.get(file));
    const { direction, selection, root, selectableFiles, patches, selectionConflicts } = previous;
    const includedFiles = new Set(previous.includedFiles);
    const unavailableFiles = new Set(previous.unavailableFiles);
    const plan = (included, recoveries) => {
      const base = loadBase(project);
      return planReplay(project, base, scopedHistory(project, base), selection, direction, included, recoveries);
    };
    if (replayFingerprint(plan(includedFiles, previous.rebased)) !== previous.fingerprint) throw fail('workerChanges.historyPreviewStale');
    for (const file of grouped.keys()) {
      const { selected, before } = rebased.get(file);
      if (!selected.equals(before)) {
        includedFiles.add(file);
        unavailableFiles.delete(file);
      } else {
        includedFiles.delete(file);
        unavailableFiles.add(file);
      }
    }
    const proposed = plan(includedFiles, rebased);
    const approved = new Map(proposed.writes.map(({ file, recovered }) => [file, recovered]));
    for (const file of grouped.keys()) {
      if (includedFiles.has(file) && approved.get(file) !== rebased.get(file)) throw fail('workerChanges.historyPreviewStale', file);
    }
    const next = storeReplayPreview(project, proposed, {
      direction, selection, root, selectableFiles, includedFiles, patches, rebased, selectionConflicts, unavailableFiles,
    }, previous);
    return { ...next, included: [...includedFiles] };
  }

  function resolveReplayConflict(project, id, item, verifyScope) {
    return resolveReplayConflicts(project, id, [item], verifyScope);
  }

  async function resolveReplayConflictBatch(project, id, batch, verifyScope) {
    const { strategy, items } = batch ?? {};
    if (strategy !== undefined && !['local', 'selected'].includes(strategy)) throw fail('workerChanges.historyConflictUnavailable');
    return resolveReplayConflicts(project, id, items, verifyScope, strategy);
  }

  async function replayDiff(project, id, file) {
    const preview = currentReplayPreview(project, id);
    const write = validPath(file) && preview.writes.get(file);
    if (!write) throw fail('workerChanges.historyDiffUnavailable');
    const before = replayHost(write);
    const after = write.recovered?.selected ?? write.readData();
    const full = textVersions(before, after) ? await compare(before, after) : { binary: true };
    const catalog = write.selectableHunks ? selectableReplayLines(before, after, full) : null;
    const patch = preview.patches.get(file);
    const projected = patch ? partialProjection(write, patch, before, after) : after;
    const result = patch ? await compare(before, projected) : full;
    currentReplayPreview(project, id);
    replayHost(write);
    if (catalog) {
      const existing = preview.hunkCatalogs.get(file);
      const savedBytes = [...preview.hunkCatalogs.values()].reduce((size, item) => size + (item.snapshot?.length ?? 0), 0);
      preview.hunkCatalogs.set(file, {
        hunks: catalog.hunks.map(({ indexes }) => indexes), edits: catalog.edits, groups: catalog.groups,
        beforeHash: write.host.hash, afterHash: write.state.hash, mode: write.mode,
        snapshot: existing?.snapshot ?? (savedBytes + before.length <= MAX_BATCH_BYTES ? before : null),
      });
    }
    return {
      ...result, beforeHash: write.host?.hash, afterHash: patch || write.recovered ? hashBytes(projected) : write.state?.hash,
      modeChanged: platformUsesMode && Boolean(write.host && write.state && write.host.mode !== write.mode),
      ...(catalog && { hunks: describeReplayHunks(catalog, patch), partial: Boolean(patch) }),
    };
  }

  function describeReplayHunks({ hunks, groups }, patch) {
    const selected = patch && new Set(patch.selected);
    const partial = new Set();
    for (const { group } of patch?.inline.values() ?? []) {
      partial.add(group.removed);
      partial.add(group.added);
    }
    return hunks.map(({ caption, rows, indexes }, index) => ({
      index, caption, included: !selected || indexes.every((line) => selected.has(line) && !partial.has(line)),
      rows: rows.map((row) => row.index === undefined ? row : {
        ...row, included: !selected || selected.has(row.index), inline: groups.has(row.index), partial: partial.has(row.index),
      }),
    }));
  }

  function inlineFile(preview, file) {
    const catalog = validPath(file) && preview.hunkCatalogs.get(file);
    const write = catalog && preview.writes.get(file);
    if (!write) throw fail('workerChanges.historyInlineSelection');
    return { catalog, write };
  }

  function reviewInline(catalog, before, after, line) {
    const group = catalog.groups.get(line);
    if (!group) throw fail('workerChanges.historyInlineSelection');
    const review = createInlineReview(before, after, catalog.edits, group);
    if (!review.parts.length) throw fail('workerChanges.historyInlineUnavailable');
    return review;
  }

  function replayInline(project, id, item) {
    const { file, line } = item ?? {};
    const preview = currentReplayPreview(project, id);
    const { catalog, write } = inlineFile(preview, file);
    if (!catalog.groups.has(line)) throw fail('workerChanges.historyInlineSelection');
    const review = reviewInline(catalog, replayHost(write), write.readData(), line);
    const patch = preview.patches.get(file);
    const custom = patch?.inline.get(line);
    const selected = patch && new Set(patch.selected);
    const parts = review.parts.map((part) => {
      const source = part.kind === 'remove' ? review.group.removed : review.group.added;
      const included = !selected || selected.has(source);
      const defaultRanges = included ? [{ start: 0, end: part.text.length }] : [];
      const ranges = custom ? custom.ranges.get(part.index) ?? [] : defaultRanges;
      return { ...part, ranges };
    });
    return { parts };
  }

  function applyInlineSelection(selected, inline, review, line, ranges) {
    const choices = validateInlineRanges(review.parts, ranges);
    if (!choices) throw fail('workerChanges.historyInlineSelection');
    inline.delete(line);
    for (const index of [review.group.removed, review.group.added]) {
      if (index === undefined) continue;
      if (choices.size) selected.add(index);
      else selected.delete(index);
    }
    const full = review.parts.every(({ index, text }) => {
      const intervals = choices.get(index);
      return intervals?.length === 1 && intervals[0].start === 0 && intervals[0].end === text.length;
    });
    if (choices.size && !full) {
      inline.set(line, { group: review.group, projected: projectInlineLine(review, choices), ranges: choices });
    }
  }

  function updateReplayInlineBatch(project, id, items) {
    const preview = currentReplayPreview(project, id);
    if (!Array.isArray(items) || !items.length) throw fail('workerChanges.historyInlineSelection');
    if (items.length > MAX_SELECTION) throw fail('workerChanges.historyInlineBatchLimit');
    const byFile = new Map();
    for (const item of items) {
      const { file, line, ranges } = item ?? {};
      if (!byFile.has(file)) byFile.set(file, { ...inlineFile(preview, file), lines: new Map() });
      const entry = byFile.get(file);
      if (!entry.catalog.groups.has(line) || entry.lines.has(line)) throw fail('workerChanges.historyInlineSelection');
      entry.lines.set(line, ranges);
    }
    const patches = new Map(preview.patches);
    for (const { catalog, write, lines } of byFile.values()) {
      const before = replayHost(write);
      const after = write.readData();
      const old = patches.get(write.file);
      const selected = new Set(old?.selected ?? catalog.edits.keys());
      const inline = new Map(old?.inline);
      for (const [line, ranges] of lines) {
        applyInlineSelection(selected, inline, reviewInline(catalog, before, after, line), line, ranges);
      }
      setReplayFilePatch(patches, write, { ...catalog, selected: [...selected], inline }, before, after);
    }
    // Publish one revision only after every selected file passes validation.
    return publishReplaySelection(project, preview, patches);
  }

  function updateReplaySelection(project, id, item, byHunk) {
    const preview = currentReplayPreview(project, id);
    const { file, indexes, reset = [] } = item ?? {};
    const catalog = validPath(file) && preview.hunkCatalogs.get(file);
    const write = catalog && preview.writes.get(file);
    const limit = byHunk ? catalog?.hunks?.length : catalog?.edits?.length;
    if (!write || !Array.isArray(indexes) || !indexes.length || indexes.length > limit ||
        [...indexes].some((index) => !Number.isSafeInteger(index) || index < 0 || index >= limit) ||
        new Set(indexes).size !== indexes.length || !Array.isArray(reset) || reset.length > catalog.edits.length ||
        [...reset].some((index) => !Number.isSafeInteger(index) || index < 0 || index >= catalog.edits.length)) {
      throw fail(byHunk ? 'workerChanges.historyHunkSelection' : 'workerChanges.historyLineSelection');
    }
    const before = replayHost(write);
    const after = write.readData();
    const old = preview.patches.get(file);
    const wasSelected = new Set(old?.selected ?? catalog.edits.keys());
    const selected = new Set(byHunk ? indexes.flatMap((index) => catalog.hunks[index]) : indexes);
    const resetLines = new Set(reset);
    const inline = new Map();
    if (!byHunk) for (const [line, fragment] of old?.inline ?? []) {
      const { removed, added } = fragment.group;
      if ([removed, added].every((index) => !resetLines.has(index) && wasSelected.has(index) === selected.has(index))) {
        inline.set(line, fragment);
      }
    }
    const patches = new Map(preview.patches);
    setReplayFilePatch(patches, write, { ...catalog, selected: [...selected], inline }, before, after);
    return publishReplaySelection(project, preview, patches);
  }

  function setReplayFilePatch(patches, write, patch, before, after) {
    const { file } = write;
    if (patch.selected.length === patch.edits.length && !patch.inline.size) patches.delete(file);
    else {
      if (partialProjection(write, patch, before, after).equals(before)) throw fail('workerChanges.historyLinesNoEffect', file);
      patches.set(file, patch);
    }
  }

  function publishReplaySelection(project, preview, patches) {
    const next = { ...preview, id: randomUUID(), patches };
    replayPreviews.set(project.id, next);
    return replayPreviewSummary(next);
  }

  function confirmReplay(project, id) {
    const preview = currentReplayPreview(project, id);
    preview.invalidated = true;
    const { direction, selection, includedFiles, fingerprint, patches, rebased, unavailableFiles } = preview;
    const base = loadBase(project);
    const plan = planReplay(project, base, scopedHistory(project, base), selection, direction, includedFiles, rebased);
    if (replayFingerprint(plan) !== fingerprint) throw fail('workerChanges.historyPreviewStale');
    applyPartialSelections(project, base, plan, patches);
    commitReplay(project, base, plan);
    replayPreviews.delete(project.id);
    const skipped = [...new Set([...plan.skipped, ...(unavailableFiles ?? [])])];
    return { ...replayResult(plan, direction), skipped, batches: plan.journals.length };
  }

  return {
    initialize, review, diff, apply, undoStatus, previewReplay, updateReplayPreview, refreshReplayPreview,
    replayDiff, replayConflicts, resolveReplayConflict, resolveReplayConflictBatch, replayInline, updateReplayInlineBatch, confirmReplay,
    updateReplayInline: (project, id, item) => updateReplayInlineBatch(project, id, [item]),
    updateReplayHunks: (project, id, item) => updateReplaySelection(project, id, item, true),
    updateReplayLines: (project, id, item) => updateReplaySelection(project, id, item, false),
    undo: (project, id, batchId) => replay(project, id, 'undo', batchId),
    redo: (project, id, batchId) => replay(project, id, 'redo', batchId),
  };
}

function textVersions(host, worker) {
  const decode = (bytes) => {
    if (!bytes) return null;
    if (bytes.includes(0)) throw Error('binary');
    return utf8.decode(bytes);
  };
  try {
    return { host: decode(host), worker: decode(worker) };
  } catch { return null; }
}

function resolveContent(entry, strategy, content, host, worker) {
  if (strategy === 'host') return { state: fileVersion(host), data: host?.data ?? null };
  if (strategy === 'worker') return { state: entry.proposed, data: worker };
  const texts = textVersions(host?.data, worker);
  if (!texts) throw fail('workerChanges.invalidResolution', entry.file);
  const normalized = editorText(content);
  if (normalized === editorText(texts.host)) return { state: fileVersion(host), data: host.data };
  const format = texts.host ?? texts.worker ?? '';
  const eol = /\r\n|\r|\n/.exec(format)?.[0] ?? '\n';
  const data = Buffer.from((format.startsWith('\uFEFF') ? '\uFEFF' : '') + normalized.replace(/\n/g, eol));
  if (data.length > MAX_FILE) throw fail('workerChanges.invalidResolution', entry.file);
  return { data, state: { hash: hashBytes(data), executable: host?.executable ?? entry.proposed?.executable ?? false } };
}

async function compare(before, after) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-review-'));
  try {
    fs.writeFileSync(path.join(folder, 'before'), before ?? '');
    fs.writeFileSync(path.join(folder, 'after'), after ?? '');
    const output = await exec('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'], {
      cwd: folder, env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    }).catch((error) => {
      if (error.code === 1) return error.stdout;
      throw error;
    });
    const text = output.toString('utf8');
    const index = text.search(/^@@/m);
    return diffPreview(index < 0 ? '' : text.slice(index));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

function applyFiles(root, writes, persist) {
  const created = [];
  const changes = [];
  const retained = new Set();
  let complete = false;
  try {
    for (const write of writes) {
      const target = checkedPath(root, write.file, true);
      if (!target || target.unsafe) throw fail('workerChanges.stale', write.file);
      for (const folder of target.parents) {
        fs.mkdirSync(folder);
        created.push(folder);
      }
      const change = { ...target, write, committed: false, temps: [] };
      changes.push(change);
      const stage = (data, mode) => {
        const temp = path.join(path.dirname(target.file), '.orchestra-' + randomUUID() + '.tmp');
        change.temps.push(temp);
        fs.writeFileSync(temp, data, { flag: 'wx', mode: platformUsesMode ? 0o600 : mode });
        if (platformUsesMode) fs.chmodSync(temp, mode);
        return temp;
      };
      if (write.host) change.backup = stage(write.readHost ? write.readHost() : write.host.data, write.host.mode);
      if (write.state !== null) {
        const mode = write.host?.mode ?? 0o644;
        const execBits = write.state.executable ? (mode & 0o111) || 0o111 : 0;
        const data = write.readData ? write.readData() : write.data;
        change.next = stage(data, write.mode ?? (platformUsesMode ? (mode & ~0o111) | execBits : mode));
      }
    }
    for (const change of changes) {
      const { file, write, next } = change;
      const parent = fileParentIdentity(root, write.file);
      if (!parent || (write.parent && parent !== write.parent) ||
          !sameHostState(readFileState(root, write.file, true), write.host)) throw fail('workerChanges.stale', write.file);
      change.parent = parent;
      if (!next) fs.unlinkSync(file);
      else if (!write.host) fs.linkSync(next, file);
      else fs.renameSync(next, file);
      change.committed = true;
      // An added file has a second link until the staging name is removed.
      if (next && !write.host) fs.unlinkSync(next);
      const applied = readFileState(root, write.file, true);
      if (!sameState(applied, write.state) || (write.mode !== undefined && applied?.mode !== write.mode)) {
        throw fail('workerChanges.stale', write.file);
      }
      change.applied = hostFileVersion(applied);
    }
    persist(changes);
    complete = true;
  } catch (error) {
    let rollbackFailure;
    for (const change of changes.reverse()) {
      if (!change.committed) continue;
      try {
        const target = checkedPath(root, change.write.file);
        const current = readFileState(root, change.write.file, true);
        const unchanged = change.applied === undefined ? sameState(current, change.write.state) : sameHostState(current, change.applied);
        if (!target || target.unsafe || !unchanged || fileParentIdentity(root, change.write.file) !== change.parent) throw Error();
        if (change.backup) fs.renameSync(change.backup, change.file);
        else fs.unlinkSync(change.file);
      } catch {
        if (change.backup) retained.add(change.backup);
        rollbackFailure ??= fail('workerChanges.rollback', change.backup ?? change.write.file);
      }
    }
    throw rollbackFailure ?? error;
  } finally {
    for (const change of changes) for (const file of change.temps) {
      if (!retained.has(file)) try { fs.rmSync(file, { force: true }); } catch {}
    }
    if (!complete) for (const folder of created.reverse()) {
      try { fs.rmdirSync(folder); } catch {}
    }
  }
}

module.exports = { createWorkerChanges };
