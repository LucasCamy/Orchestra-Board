const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkerChanges } = require('../electron/workerChanges.cjs');
const { validPath, hashBytes, readFileState } = require('../electron/workerChangePaths.cjs');

function fixture(t, legacy = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-review-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.realpathSync.native(directory);
  const target = { id: 'squad', source };
  const scratch = new Map();
  const volume = { exists: true, initialized: true };
  const host = (file, text) => {
    const targetFile = path.join(source, file);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, text);
  };
  const put = (file, content) => {
    const data = Buffer.from(content);
    scratch.set(file, { hash: hashBytes(data), executable: false, content: data.toString('base64') });
  };
  const adapter = {
    volumeExists: async () => volume.exists,
    workerFiles: async (_project, action, files) => {
      if (action === 'initialize') {
        const names = legacy ? fs.readdirSync(source) : [...scratch.keys()];
        return { legacy, entries: names.map((file) => [file, readFileState(source, file)]),
          unobserved: legacy ? names.filter((file) => !scratch.has(file)) : [] };
      }
      if (!volume.initialized) return { unavailable: true };
      if (action === 'inventory') return [...scratch].map(([file, { hash, executable }]) => [file, { hash, executable }]);
      return files.map((file) => scratch.get(file) ?? null);
    },
  };
  const restart = () => createWorkerChanges(path.join(directory, 'profile'), adapter);
  return { source, service: restart(), restart, target, host, put, scratch, volume };
}

async function applyWorkerBatch(service, target, select = ({ index }) => index) {
  const review = await service.review(target);
  const selected = review.files.map(select).filter((item) => item !== undefined);
  for (const item of selected) await service.diff(target, review.id, item.index ?? item);
  await service.apply(target, review.id, selected);
  return service.undoStatus(target).batches[0];
}

const replaySelection = (batches, direction) => batches.map((batch) => ({ batchId: batch.id, id: batch[direction].id }));

test('review applies only selected file versions and preserves unrelated local changes', async (t) => {
  const { source, service, target, host, put, scratch } = fixture(t);
  host('src/code.js', 'before\n');
  host('src/remove.js', 'delete me\n');
  host('AGENTS.md', 'original rules\n');
  put('src/code.js', 'before\n');
  put('src/remove.js', 'delete me\n');
  await service.initialize(target);
  host('unrelated.js', 'local draft\n');
  host('AGENTS.md', 'architect revision\n');
  put('src/code.js', 'after\n');
  scratch.delete('src/remove.js');
  put('assets/new.js', 'new\n');
  put('skip.js', 'keep in worker only\n');
  const review = await service.review(target);
  const index = (file) => review.files.find(({ path }) => path === file).index;
  const selected = ['src/code.js', 'src/remove.js', 'assets/new.js'].map(index);
  await assert.rejects(service.apply(target, review.id, selected), { reviewKey: 'workerChanges.stale' });
  assert.match((await service.diff(target, review.id, selected[0])).diff, /-before\n\+after/);
  assert.match((await service.diff(target, review.id, selected[1])).diff, /-delete me/);
  assert.match((await service.diff(target, review.id, selected[2])).diff, /\+new/);
  assert.deepEqual(await service.apply(target, review.id, selected), { applied: 3 });
  assert.equal(fs.readFileSync(path.join(source, 'src/code.js'), 'utf8'), 'after\n');
  assert.equal(fs.existsSync(path.join(source, 'src/remove.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'assets/new.js'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(source, 'skip.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'unrelated.js'), 'utf8'), 'local draft\n');
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'architect revision\n');
  assert.deepEqual((await service.review(target)).files.map(({ path }) => path), ['skip.js']);
});

test('adopting an older volume omits historical deletions and guards later host edits', async (t) => {
  const { source, service, target, host, put } = fixture(t, true);
  host('host-only.js', 'missing from the old copy\n');
  host('shared.js', 'host content during adoption\n');
  put('shared.js', 'worker changes from before adoption\n');
  const adopted = await service.review(target);
  assert.equal(adopted.legacy, true);
  assert.deepEqual(adopted.files.map(({ path, blocked }) => [path, blocked]), [['shared.js', null]]);
  await service.diff(target, adopted.id, 0);
  await service.apply(target, adopted.id, [0]);
  host('host-only.js', 'new host content\n');
  put('host-only.js', 'worker added its own version\n');
  const later = await service.review(target);
  assert.equal(later.files.find(({ path }) => path === 'host-only.js').blocked, 'conflict');
  assert.equal(fs.readFileSync(path.join(source, 'host-only.js'), 'utf8'), 'new host content\n');
});

test('stale approvals and divergent local edits stop the whole batch before writing', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  const files = ['one.js', 'two.js'];
  for (const file of files) { host(file, 'initial\n'); put(file, 'initial\n'); }
  await service.initialize(target);
  for (const file of files) put(file, 'proposal\n');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  put('one.js', 'updated after approval\n');
  await assert.rejects(service.apply(target, review.id, [0, 1]), { reviewKey: 'workerChanges.stale', file: 'one.js' });
  put('one.js', 'proposal\n');
  host('two.js', 'local edit after approval\n');
  await assert.rejects(service.apply(target, review.id, [0, 1]), { reviewKey: 'workerChanges.stale', file: 'two.js' });
  assert.equal(fs.readFileSync(path.join(source, 'one.js'), 'utf8'), 'initial\n');
  assert.equal(fs.readFileSync(path.join(source, 'two.js'), 'utf8'), 'local edit after approval\n');
  const fresh = await service.review(target);
  assert.equal(fresh.files.find(({ path }) => path === 'two.js').blocked, 'conflict');
});

test('reviewed conflicts can keep the original, take the worker, or apply an edited result in one batch', async (t) => {
  const { source, service, target, host, put, scratch } = fixture(t);
  const files = ['keep.js', 'manual.js', 'take.bin', 'delete.js', 'absent.js', 'normal.js'];
  for (const file of files) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  host('keep.js', 'keep this local edit\n');
  host('manual.js', '\uFEFFlocal changes\r\n');
  host('take.bin', Buffer.from([0, 1]));
  host('delete.js', 'local edit before worker deletion\n');
  fs.unlinkSync(path.join(source, 'absent.js'));
  for (const file of files) put(file, 'worker code\n');
  put('take.bin', Buffer.from([0, 2]));
  scratch.delete('delete.js');
  const review = await service.review(target);
  const index = (file) => review.files.find(({ path }) => path === file).index;
  const choice = (file, strategy, content) => ({ index: index(file), strategy, content });
  assert.equal(review.files.filter(({ blocked }) => blocked === 'conflict').length, 5);
  await assert.rejects(service.apply(target, review.id, [choice('keep.js', 'host')]), { reviewKey: 'workerChanges.stale' });
  const previews = new Map();
  for (const file of files) previews.set(file, await service.diff(target, review.id, index(file)));
  assert.deepEqual(previews.get('manual.js').conflict.text, { host: 'local changes\n', worker: 'worker code\n' });
  assert.equal(previews.get('delete.js').conflict.workerExists, false);
  assert.equal(previews.get('absent.js').conflict.hostExists, false);
  assert.equal(previews.get('take.bin').conflict.text, undefined);
  await assert.rejects(service.apply(target, review.id, [index('keep.js')]), { reviewKey: 'workerChanges.resolutionRequired' });
  await assert.rejects(service.apply(target, review.id, [choice('take.bin', 'manual', 'text')]), { reviewKey: 'workerChanges.invalidResolution' });
  const merged = 'local changes\nworker code\n';
  assert.deepEqual(await service.apply(target, review.id, [
    choice('keep.js', 'host'), choice('manual.js', 'manual', merged), choice('take.bin', 'worker'),
    choice('delete.js', 'worker'), choice('absent.js', 'host'), index('normal.js'),
  ]), { applied: 4, resolved: 5 });
  assert.equal(fs.readFileSync(path.join(source, 'keep.js'), 'utf8'), 'keep this local edit\n');
  assert.equal(fs.readFileSync(path.join(source, 'manual.js'), 'utf8'), '\uFEFFlocal changes\r\nworker code\r\n');
  assert.deepEqual(fs.readFileSync(path.join(source, 'take.bin')), Buffer.from([0, 2]));
  assert.equal(fs.existsSync(path.join(source, 'delete.js')), false);
  assert.equal(fs.existsSync(path.join(source, 'absent.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'normal.js'), 'utf8'), 'worker code\n');
  assert.equal((await service.review(target)).files.length, 0);
  put('manual.js', 'new worker changes\n');
  const next = await service.review(target);
  assert.deepEqual(next.files, [{ index: 0, path: 'manual.js', status: 'M', blocked: 'conflict' }]);
});

test('a conflict resolution is rejected if either version changes after preview', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  host('conflict.js', 'base\n');
  put('conflict.js', 'base\n');
  await service.initialize(target);
  host('conflict.js', 'host edit\n');
  put('conflict.js', 'worker edit\n');
  const review = await service.review(target);
  await service.diff(target, review.id, 0);
  put('conflict.js', 'worker changed again\n');
  await assert.rejects(service.apply(target, review.id, [{ index: 0, strategy: 'host' }]), { reviewKey: 'workerChanges.stale' });
  put('conflict.js', 'worker edit\n');
  host('conflict.js', 'host changed again\n');
  await assert.rejects(service.apply(target, review.id, [{ index: 0, strategy: 'manual', content: 'merged\n' }]), { reviewKey: 'workerChanges.stale' });
  assert.equal(fs.readFileSync(path.join(source, 'conflict.js'), 'utf8'), 'host changed again\n');
});

test('path aliases, metadata, links, and case collisions cannot be applied', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  for (const candidate of [
    'AGENTS.md', 'agents.MD', 'src/AGENTS.md', 'agents.md.', 'agents.md:stream', '.git/config',
    '../outside', 'src/../AGENTS.md', 'src\\AGENTS.md', '/project.js', 'AGENTS~1.MD', 'COM1.js',
  ]) assert.equal(validPath(candidate), false, candidate);
  assert.equal(validPath('.github/workflows/build.yml'), true);

  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  fs.linkSync(path.join(source, 'AGENTS.md'), path.join(source, 'hardlink.js'));
  fs.symlinkSync(source, path.join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  put('hardlink.js', 'cannot write via hard link\n');
  put('alias/attempt.js', 'cannot follow link\n');
  put('Folder/new.js', 'one spelling\n');
  put('folder/other.js', 'another spelling\n');
  const review = await service.review(target);
  assert.equal(review.files.length, 4);
  assert.ok(review.files.every(({ blocked }) => blocked === 'unsupported'));
  await assert.rejects(service.apply(target, review.id, [0]), { reviewKey: 'workerChanges.stale' });
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'rules\n');
});

test('an interrupted batch restores changes already written and can be retried', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  for (const file of ['a.js', 'b.js']) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  for (const file of ['a.js', 'b.js']) put(file, 'approved\n');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  const rename = fs.renameSync;
  const simulatedLock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(source, 'b.js')) throw Object.assign(Error('locked by editor'), { code: 'EBUSY' });
    return rename(from, to);
  });
  try {
    await assert.rejects(service.apply(target, review.id, [0, 1]), { code: 'EBUSY' });
  } finally { simulatedLock.mock.restore(); }
  for (const file of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'base\n');
  assert.equal(fs.readdirSync(source).some((file) => file.startsWith('.orchestra-')), false);
  assert.deepEqual(await service.apply(target, review.id, [0, 1]), { applied: 2 });
});

test('a missing or empty Docker volume does not propose deletions', async (t) => {
  const { service, target, host, put, volume, scratch } = fixture(t);
  host('keep.js', 'base\n');
  put('keep.js', 'base\n');
  await service.initialize(target);
  scratch.clear();
  volume.exists = false;
  await assert.rejects(service.review(target), { reviewKey: 'workerChanges.notStarted' });
  volume.exists = true;
  volume.initialized = false;
  await assert.rejects(service.review(target), { reviewKey: 'workerChanges.notStarted' });
});

test('undo after restart restores additions, edits, deletions and review decisions while Docker is offline', async (t) => {
  const { source, service, restart, target, host, put, scratch, volume } = fixture(t);
  for (const file of ['edit.js', 'delete.js', 'keep.js']) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  assert.equal(service.undoStatus(target).lastApplication, null);
  host('keep.js', 'local decision\n');
  host('AGENTS.md', 'rules\n');
  put('keep.js', 'worker decision\n');
  put('edit.js', 'edited\n');
  put('nested/add.js', 'new file\n');
  scratch.delete('delete.js');
  if (process.platform !== 'win32') fs.chmodSync(path.join(source, 'delete.js'), 0o751);
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  const selection = review.files.map(({ index, path, blocked }) => blocked === 'conflict'
    ? { index, strategy: path === 'keep.js' ? 'host' : 'worker' }
    : index);
  const resolutions = selection.filter((item) => typeof item === 'object').length;
  await service.apply(target, review.id, selection);
  const id = service.undoStatus(target).lastApplication.id;
  host('keep.js', 'local decision edited after application\n');
  host('AGENTS.md', 'rules edited after application\n');
  volume.exists = false;
  const restored = restart();
  assert.equal(restored.undoStatus(target).lastApplication.id, id);
  assert.deepEqual(restored.undo(target, id), { restored: 3, reopened: resolutions, skipped: [] });
  assert.equal(fs.readFileSync(path.join(source, 'edit.js'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(source, 'delete.js'), 'utf8'), 'base\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(source, 'delete.js')).mode & 0o777, 0o751);
  assert.equal(fs.existsSync(path.join(source, 'nested/add.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'keep.js'), 'utf8'), 'local decision edited after application\n');
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'rules edited after application\n');
  assert.equal(restored.undoStatus(target).lastApplication, null);
  assert.throws(() => restored.undo(target, id), { reviewKey: 'workerChanges.undoStale' });
  volume.exists = true;
  const reopened = await restored.review(target);
  assert.equal(reopened.files.find(({ path }) => path === 'keep.js').blocked, 'conflict');
});

test('partial undo preserves later writes, replacements and permission changes while keeping skipped records pending', async (t) => {
  const { source, service, target, host, put, scratch } = fixture(t);
  for (const file of ['editable.js', 'folder/deleted.js', 'removed.js', 'unchanged.js']) {
    host(file, 'base\n');
    put(file, 'base\n');
  }
  await service.initialize(target);
  put('editable.js', 'applied\n');
  put('unchanged.js', 'applied\n');
  scratch.delete('folder/deleted.js');
  scratch.delete('removed.js');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  await service.apply(target, review.id, review.files.map(({ index }) => index));
  const id = service.undoStatus(target).lastApplication.id;
  host('editable.js', 'later local edit\n');
  host('removed.js', 'later recreation\n');
  host('other.js', 'unrelated local edit\n');
  fs.renameSync(path.join(source, 'folder'), path.join(source, 'previous-folder'));
  fs.mkdirSync(path.join(source, 'folder'));
  const skipped = ['editable.js', 'folder/deleted.js', 'removed.js'];
  assert.deepEqual(service.undo(target, id), { restored: 1, reopened: 0, skipped });
  assert.equal(fs.readFileSync(path.join(source, 'unchanged.js'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(source, 'editable.js'), 'utf8'), 'later local edit\n');
  assert.equal(fs.readFileSync(path.join(source, 'removed.js'), 'utf8'), 'later recreation\n');
  assert.equal(fs.readFileSync(path.join(source, 'other.js'), 'utf8'), 'unrelated local edit\n');
  assert.equal(fs.existsSync(path.join(source, 'folder/deleted.js')), false);
  assert.deepEqual(service.undoStatus(target).lastApplication, { id, count: 3 });
  host('editable.js', 'applied\n');
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(source, 'editable.js'), 0o600);
    assert.deepEqual(service.undo(target, id), { restored: 0, reopened: 0, skipped });
    fs.chmodSync(path.join(source, 'editable.js'), 0o644);
  }
  assert.deepEqual(service.undo(target, id), { restored: 1, reopened: 0, skipped: skipped.slice(1) });
  assert.equal(fs.readFileSync(path.join(source, 'editable.js'), 'utf8'), 'base\n');
});

test('the default undo targets the latest batch and protects AGENTS.md path aliases', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  host('code.js', 'base\n');
  put('code.js', 'base\n');
  await service.initialize(target);
  const apply = async (text) => {
    put('code.js', text);
    const review = await service.review(target);
    await service.diff(target, review.id, 0);
    await service.apply(target, review.id, [0]);
    return service.undoStatus(target).lastApplication.id;
  };
  const first = await apply('first\n');
  const latest = await apply('latest\n');
  assert.throws(() => service.undo(target, first), { reviewKey: 'workerChanges.undoStale' });
  host('AGENTS.md', 'latest\n');
  fs.unlinkSync(path.join(source, 'code.js'));
  fs.linkSync(path.join(source, 'AGENTS.md'), path.join(source, 'code.js'));
  assert.deepEqual(service.undo(target, latest), { restored: 0, reopened: 0, skipped: ['code.js'] });
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'latest\n');
  const manifest = path.join(source, 'profile', 'worker-reviews', 'squad.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  data.history.at(-1).undo.entries[0].file = 'agents.MD';
  fs.writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => service.undo(target, latest), { reviewKey: 'workerChanges.undoUnavailable' });
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'latest\n');
});

test('failed undo and redo operations roll back partial writes and remain available for retry', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  for (const file of ['a.js', 'b.js']) { host(file, 'before\n'); put(file, 'before\n'); }
  await service.initialize(target);
  for (const file of ['a.js', 'b.js']) put(file, 'applied\n');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  await service.apply(target, review.id, [0, 1]);
  const id = service.undoStatus(target).lastApplication.id;
  const rename = fs.renameSync;
  const simulatedLock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(source, 'b.js')) throw Object.assign(Error('locked by editor'), { code: 'EBUSY' });
    return rename(from, to);
  });
  try {
    assert.throws(() => service.undo(target, id), { code: 'EBUSY' });
  } finally { simulatedLock.mock.restore(); }
  for (const file of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'applied\n');
  assert.equal(service.undoStatus(target).lastApplication.id, id);
  assert.deepEqual(service.undo(target, id), { restored: 2, reopened: 0, skipped: [] });
  const redo = service.undoStatus(target).lastUndoneApplication;
  const redoLock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(source, 'b.js')) throw Object.assign(Error('locked by editor'), { code: 'EBUSY' });
    return rename(from, to);
  });
  try {
    assert.throws(() => service.redo(target, redo.id), { code: 'EBUSY' });
  } finally { redoLock.mock.restore(); }
  for (const file of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'before\n');
  assert.deepEqual(service.undoStatus(target).lastUndoneApplication, redo);
  assert.deepEqual(service.redo(target, redo.id), { reapplied: 2, resolved: 0, skipped: [] });
});

test('redo replays the approved bytes and review decisions after restart while Docker is offline', async (t) => {
  const { source, service, restart, target, host, put, scratch, volume } = fixture(t);
  for (const file of ['code.js', 'delete.js', 'keep.js', 'merged.js']) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  host('AGENTS.md', 'rules\n');
  host('keep.js', 'host choice\n');
  host('merged.js', '\uFEFFhost conflict\r\n');
  put('code.js', 'approved version\n');
  put('new.js', 'new file\n');
  put('keep.js', 'worker proposal\n');
  put('merged.js', 'worker conflict\n');
  scratch.delete('delete.js');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  const selection = review.files.map(({ index, path }) => {
    if (path === 'keep.js') return { index, strategy: 'host' };
    if (path === 'merged.js') return { index, strategy: 'manual', content: 'approved merge\n' };
    return index;
  });
  await service.apply(target, review.id, selection);
  assert.deepEqual(service.undo(target, service.undoStatus(target).lastApplication.id), { restored: 4, reopened: 2, skipped: [] });
  host('keep.js', 'later host-only choice\n');
  host('AGENTS.md', 'later rules\n');
  put('code.js', 'different worker revision\n');
  volume.exists = false;
  const restored = restart();
  const redo = restored.undoStatus(target).lastUndoneApplication;
  assert.equal(redo.count, 5);
  assert.deepEqual(restored.redo(target, redo.id), { reapplied: 4, resolved: 2, skipped: [] });
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'approved version\n');
  assert.equal(fs.readFileSync(path.join(source, 'new.js'), 'utf8'), 'new file\n');
  assert.equal(fs.existsSync(path.join(source, 'delete.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'merged.js'), 'utf8'), '\uFEFFapproved merge\r\n');
  assert.equal(fs.readFileSync(path.join(source, 'keep.js'), 'utf8'), 'later host-only choice\n');
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'later rules\n');
  const status = restored.undoStatus(target);
  assert.equal(status.lastUndoneApplication, null);
  assert.equal(status.lastApplication.count, 5);
  volume.exists = true;
  const later = await restored.review(target);
  assert.deepEqual(later.files, [{ index: 0, path: 'code.js', status: 'M', blocked: null }]);
  assert.deepEqual(restored.undo(target, status.lastApplication.id), { restored: 4, reopened: 2, skipped: [] });
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(source, 'merged.js'), 'utf8'), '\uFEFFhost conflict\r\n');
});

test('redo only uses items that were undone, preserves later edits, and combines subsequent partial attempts', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  for (const file of ['a.js', 'b.js', 'c.js']) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  for (const file of ['a.js', 'b.js', 'c.js']) put(file, 'applied\n');
  const review = await service.review(target);
  for (const { index } of review.files) await service.diff(target, review.id, index);
  await service.apply(target, review.id, [0, 1, 2]);
  host('b.js', 'edit before undo\n');
  assert.deepEqual(service.undo(target, service.undoStatus(target).lastApplication.id), { restored: 2, reopened: 0, skipped: ['b.js'] });
  host('c.js', 'edit after undo\n');
  const redo = service.undoStatus(target).lastUndoneApplication;
  assert.equal(redo.count, 2);
  assert.deepEqual(service.redo(target, redo.id), { reapplied: 1, resolved: 0, skipped: ['c.js'] });
  assert.equal(fs.readFileSync(path.join(source, 'a.js'), 'utf8'), 'applied\n');
  assert.equal(fs.readFileSync(path.join(source, 'b.js'), 'utf8'), 'edit before undo\n');
  assert.equal(fs.readFileSync(path.join(source, 'c.js'), 'utf8'), 'edit after undo\n');
  assert.deepEqual(service.undoStatus(target).lastUndoneApplication, { id: redo.id, count: 1 });

  host('b.js', 'applied\n');
  assert.deepEqual(service.undo(target, service.undoStatus(target).lastApplication.id), { restored: 2, reopened: 0, skipped: [] });
  const combined = service.undoStatus(target).lastUndoneApplication;
  assert.equal(combined.count, 3);
  assert.throws(() => service.redo(target, redo.id), { reviewKey: 'workerChanges.redoStale' });
  host('c.js', 'base\n');
  assert.deepEqual(service.redo(target, combined.id), { reapplied: 3, resolved: 0, skipped: [] });
  for (const file of ['a.js', 'b.js', 'c.js']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'applied\n');
  assert.equal(service.undoStatus(target).lastUndoneApplication, null);
});

test('redo protects AGENTS.md aliases and a new application invalidates prior redo', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  host('code.js', 'base\n');
  put('code.js', 'base\n');
  await service.initialize(target);
  const apply = async (text) => {
    put('code.js', text);
    const review = await service.review(target);
    await service.diff(target, review.id, 0);
    await service.apply(target, review.id, [0]);
  };
  await apply('first\n');
  service.undo(target, service.undoStatus(target).lastApplication.id);
  const { id } = service.undoStatus(target).lastUndoneApplication;
  host('AGENTS.md', 'base\n');
  fs.unlinkSync(path.join(source, 'code.js'));
  fs.linkSync(path.join(source, 'AGENTS.md'), path.join(source, 'code.js'));
  assert.deepEqual(service.redo(target, id), { reapplied: 0, resolved: 0, skipped: ['code.js'] });
  const manifest = path.join(source, 'profile', 'worker-reviews', 'squad.json');
  const state = fs.readFileSync(manifest, 'utf8');
  const corrupted = JSON.parse(state);
  corrupted.history.at(-1).redo.entries[0].file = 'agents.MD';
  fs.writeFileSync(manifest, JSON.stringify(corrupted));
  assert.throws(() => service.redo(target, id), { reviewKey: 'workerChanges.undoUnavailable' });
  fs.writeFileSync(manifest, state);
  fs.unlinkSync(path.join(source, 'code.js'));
  host('code.js', 'base\n');
  await apply('new application\n');
  assert.equal(service.undoStatus(target).lastUndoneApplication, null);
  assert.throws(() => service.redo(target, id), { reviewKey: 'workerChanges.redoStale' });
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'new application\n');
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'base\n');
});

test('multiple batches undo newest first and redo oldest first across restarts without the worker', async (t) => {
  const { source, service, restart, target, host, put, scratch, volume } = fixture(t);
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  for (const file of ['shared.js', 'conflict.js', 'removed.js']) {
    host(file, 'base\n');
    put(file, 'base\n');
  }
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);

  put('shared.js', 'first\n');
  const first = await applyWorkerBatch(service, target);
  put('shared.js', 'second\n');
  put('conflict.js', 'worker\n');
  host('conflict.js', 'host\n');
  const second = await applyWorkerBatch(service, target, ({ index, blocked }) => blocked
    ? { index, strategy: 'manual', content: 'merged\n' } : index);
  put('shared.js', 'third\n');
  put('added.js', 'added\n');
  scratch.delete('removed.js');
  const third = await applyWorkerBatch(service, target);

  host('AGENTS.md', 'architect update\n');
  host('draft.js', 'later edit\n');
  volume.exists = volume.initialized = false;
  const offline = restart();
  let status = offline.undoStatus(target);
  assert.deepEqual(status.batches.map(({ id }) => id), [third.id, second.id, first.id]);
  assert.ok(status.batches.every(({ appliedAt, undo, redo }) => Number.isSafeInteger(appliedAt) && undo && !redo));
  const undo = (batch) => offline.undo(target, batch.undo.id);
  assert.deepEqual(undo(third), { restored: 3, reopened: 0, skipped: [] });
  assert.equal(read('shared.js'), 'second\n');
  assert.equal(read('removed.js'), 'base\n');
  assert.equal(fs.existsSync(path.join(source, 'added.js')), false);
  assert.deepEqual(undo(second), { restored: 2, reopened: 1, skipped: [] });
  assert.equal(read('shared.js'), 'first\n');
  assert.equal(read('conflict.js'), 'host\n');
  assert.deepEqual(undo(first), { restored: 1, reopened: 0, skipped: [] });
  assert.equal(read('shared.js'), 'base\n');

  const again = restart();
  status = again.undoStatus(target);
  assert.equal(status.lastApplication, null);
  assert.equal(status.lastUndoneApplication.id, status.batches[2].redo.id);
  for (const [index, batch] of status.batches.toReversed().entries()) {
    const outcome = again.redo(target, batch.redo.id);
    assert.deepEqual(outcome, { reapplied: index + 1, resolved: index === 1 ? 1 : 0, skipped: [] });
    assert.equal(read('shared.js'), ['first\n', 'second\n', 'third\n'][index]);
  }
  assert.equal(read('conflict.js'), 'merged\n');
  assert.equal(read('added.js'), 'added\n');
  assert.equal(fs.existsSync(path.join(source, 'removed.js')), false);
  assert.equal(read('draft.js'), 'later edit\n');
  assert.equal(read('AGENTS.md'), 'architect update\n');
  assert.equal(again.undoStatus(target).lastUndoneApplication, null);
});

test('selected batches skip shared paths out of order and preserve later edits while independent paths advance', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  const status = () => service.undoStatus(target);
  for (const file of ['shared.js', 'first.js', 'second.js']) {
    host(file, 'base\n');
    put(file, 'base\n');
  }
  await service.initialize(target);
  put('shared.js', 'first\n');
  put('first.js', 'first\n');
  const first = await applyWorkerBatch(service, target);
  put('shared.js', 'second\n');
  put('second.js', 'second\n');
  const second = await applyWorkerBatch(service, target);

  host('shared.js', 'first\n');
  assert.deepEqual(service.undo(target, second.undo.id), { restored: 1, reopened: 0, skipped: ['shared.js'] });
  assert.deepEqual(service.undo(target, first.undo.id, first.id), { restored: 1, reopened: 0, skipped: ['shared.js'] });
  assert.equal(read('shared.js'), 'first\n');
  assert.equal(read('first.js'), 'base\n');
  assert.equal(read('second.js'), 'base\n');
  assert.ok(status().batches.every(({ undo, redo }) => undo.count === 1 && redo.count === 1));

  host('shared.js', 'second\n');
  assert.equal(service.undo(target, second.undo.id).restored, 1);
  assert.equal(service.undo(target, first.undo.id).restored, 1);
  const [secondUndone, firstUndone] = status().batches;
  host('shared.js', 'first\n');
  assert.deepEqual(service.redo(target, secondUndone.redo.id, second.id), { reapplied: 1, resolved: 0, skipped: ['shared.js'] });
  assert.deepEqual(service.redo(target, firstUndone.redo.id), { reapplied: 1, resolved: 0, skipped: ['shared.js'] });
  assert.equal(read('shared.js'), 'first\n');
  assert.equal(read('second.js'), 'second\n');
  host('shared.js', 'base\n');
  assert.equal(service.redo(target, firstUndone.redo.id).reapplied, 1);
  assert.equal(service.redo(target, secondUndone.redo.id).reapplied, 1);
  assert.equal(read('shared.js'), 'second\n');
  assert.equal(status().lastUndoneApplication, null);
});

test('a legacy undo or redo remains replayable when the project history is upgraded', async (t) => {
  const { source, service, restart, target, host, put } = fixture(t);
  host('code.js', 'base\n');
  put('code.js', 'base\n');
  await service.initialize(target);
  put('code.js', 'applied\n');
  await applyWorkerBatch(service, target);
  const manifest = path.join(source, 'profile', 'worker-reviews', 'squad.json');
  const downgrade = () => {
    const { history, ...base } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const { undo, redo } = history[0];
    fs.writeFileSync(manifest, JSON.stringify({ ...base, undo, redo }));
  };

  downgrade();
  const firstRestart = restart();
  const { batches: [applied] } = firstRestart.undoStatus(target);
  assert.equal(applied.appliedAt, null);
  assert.equal(firstRestart.undo(target, applied.undo.id).restored, 1);
  downgrade();
  const secondRestart = restart();
  const { batches: [undone] } = secondRestart.undoStatus(target);
  assert.equal(undone.appliedAt, null);
  assert.equal(secondRestart.redo(target, undone.redo.id).reapplied, 1);
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'applied\n');
});

test('history keeps 20 batches, removes expired backups and retains undoable batches on a new branch', async (t) => {
  const { source, service, target, host, put } = fixture(t);
  host('code.js', 'base\n');
  put('code.js', 'base\n');
  await service.initialize(target);
  const batches = [];
  for (let index = 0; index < 21; index++) {
    put('code.js', `change ${index}\n`);
    batches.push(await applyWorkerBatch(service, target));
  }
  const storage = path.join(source, 'profile', 'worker-reviews');
  const backup = (id) => path.join(storage, `squad.undo-${id}`, '0');
  const status = () => service.undoStatus(target);
  assert.deepEqual(status().batches.map(({ id }) => id), batches.slice(1).toReversed().map(({ id }) => id));
  assert.equal(fs.existsSync(backup(batches[0].undo.id)), false);
  assert.equal(fs.existsSync(backup(batches[1].undo.id)), true);

  service.undo(target, status().lastApplication.id);
  const { id } = status().lastUndoneApplication;
  put('code.js', 'new branch\n');
  const branched = await applyWorkerBatch(service, target);
  assert.equal(status().lastUndoneApplication, null);
  assert.equal(status().batches[0].id, branched.id);
  assert.equal(status().batches[1].id, batches[19].id);
  assert.equal(status().batches.length, 20);
  assert.throws(() => service.redo(target, id, batches[20].id), { reviewKey: 'workerChanges.redoStale' });
  assert.equal(service.undo(target, branched.undo.id).restored, 1);
  assert.equal(service.undo(target, batches[19].undo.id).restored, 1);
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'change 18\n');
});

test('a group preview coalesces shared paths, rechecks later edits, and preserves intermediate versions for redo', async (t) => {
  const { source, target, service, restart, host, put, scratch, volume } = fixture(t);
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  for (const file of ['shared.js', 'removed.js', 'conflict.js']) {
    host(file, 'base\n');
    put(file, 'base\n');
  }
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put('shared.js', 'first\n');
  put('added.js', 'added\n');
  const first = await applyWorkerBatch(service, target);
  put('shared.js', 'second\n');
  put('conflict.js', 'worker\n');
  host('conflict.js', 'host\n');
  scratch.delete('removed.js');
  const second = await applyWorkerBatch(service, target, ({ index, blocked }) => blocked
    ? { index, strategy: 'manual', content: 'merged\n' } : index);
  const selection = replaySelection([first, second], 'undo');
  const preview = service.previewReplay(target, 'undo', selection);
  assert.equal(preview.ready, 2);
  assert.deepEqual(preview.files.toSorted((a, b) => a.path.localeCompare(b.path)), [
    { path: 'added.js', effect: 'delete', skipped: null },
    { path: 'conflict.js', effect: 'modify', skipped: null },
    { path: 'removed.js', effect: 'create', skipped: null },
    { path: 'shared.js', effect: 'modify', skipped: null },
  ]);
  const combined = (await service.replayDiff(target, preview.id, 'shared.js')).diff;
  assert.match(combined, /-second\n\+base/);
  assert.doesNotMatch(combined, /first/);
  assert.match((await service.replayDiff(target, preview.id, 'added.js')).diff, /^-added$/m);
  assert.match((await service.replayDiff(target, preview.id, 'removed.js')).diff, /^\+base$/m);
  for (const file of ['AGENTS.md', 'agents.MD', '../AGENTS.md', 'draft.js']) {
    await assert.rejects(service.replayDiff(target, preview.id, file), { reviewKey: 'workerChanges.historyDiffUnavailable' });
  }
  await assert.rejects(service.replayDiff({ ...target, id: 'other-project' }, preview.id, 'shared.js'),
    { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read('shared.js'), 'second\n');
  host('added.js', 'keep this later edit\n');
  host('AGENTS.md', 'architect edit\n');
  await assert.rejects(service.replayDiff(target, preview.id, 'added.js'), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.throws(() => service.confirmReplay(target, preview.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read('shared.js'), 'second\n');
  assert.equal(read('conflict.js'), 'merged\n');
  assert.equal(fs.existsSync(path.join(source, 'removed.js')), false);

  const current = service.previewReplay(target, 'undo', selection);
  assert.deepEqual(current.files.find(({ path }) => path === 'added.js'), { path: 'added.js', effect: null, skipped: 'changed' });
  await assert.rejects(service.replayDiff(target, current.id, 'added.js'), { reviewKey: 'workerChanges.historyDiffUnavailable' });
  assert.throws(() => service.confirmReplay({ ...target, id: 'other-project' }, current.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.deepEqual(service.confirmReplay(target, current.id), { restored: 3, reopened: 1, skipped: ['added.js'], batches: 2 });
  assert.throws(() => service.confirmReplay(target, current.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read('shared.js'), 'base\n');
  assert.equal(read('conflict.js'), 'host\n');
  assert.equal(read('removed.js'), 'base\n');
  assert.equal(read('added.js'), 'keep this later edit\n');

  volume.exists = volume.initialized = false;
  const offline = restart();
  const redo = offline.previewReplay(target, 'redo', replaySelection(offline.undoStatus(target).batches, 'redo'));
  const redoneDiff = (await offline.replayDiff(target, redo.id, 'shared.js')).diff;
  assert.match(redoneDiff, /-base\n\+second/);
  assert.doesNotMatch(redoneDiff, /first/);
  assert.deepEqual(offline.confirmReplay(target, redo.id), { reapplied: 3, resolved: 1, skipped: [], batches: 2 });
  assert.equal(read('shared.js'), 'second\n');
  assert.equal(read('conflict.js'), 'merged\n');
  assert.equal(read('added.js'), 'keep this later edit\n');
  assert.equal(read('AGENTS.md'), 'architect edit\n');
  assert.equal(fs.existsSync(path.join(source, 'removed.js')), false);
  assert.equal(offline.undo(target, offline.undoStatus(target).lastApplication.id).restored, 3);
  assert.equal(read('shared.js'), 'first\n');
});

test('nonconsecutive group selections preserve paths tied to unselected batches and reject unsafe requests', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  host('shared.js', 'base\n');
  put('shared.js', 'base\n');
  host('AGENTS.md', 'protected\n');
  await service.initialize(target);
  put('shared.js', 'change 1\n');
  put('first.js', 'added by first\n');
  const first = await applyWorkerBatch(service, target);
  put('shared.js', 'change 2\n');
  await applyWorkerBatch(service, target);
  put('third.js', 'added by third\n');
  const third = await applyWorkerBatch(service, target);
  const selected = replaySelection([third, first], 'undo');
  assert.throws(() => service.previewReplay(target, '__proto__', selected), { reviewKey: 'workerChanges.historySelection' });
  assert.throws(() => service.previewReplay(target, 'undo', [selected[0], selected[0]]), { reviewKey: 'workerChanges.historySelection' });
  assert.throws(() => service.previewReplay(target, 'undo', [selected[0], { ...selected[1], id: third.undo.id }]), { reviewKey: 'workerChanges.undoStale' });
  fs.unlinkSync(path.join(source, 'third.js'));
  fs.linkSync(path.join(source, 'AGENTS.md'), path.join(source, 'third.js'));

  const preview = service.previewReplay(target, 'undo', selected);
  assert.deepEqual(preview.files, [
    { path: 'first.js', effect: 'delete', skipped: null },
    { path: 'third.js', effect: null, skipped: 'changed' },
    { path: 'shared.js', effect: null, skipped: 'dependency' },
  ]);
  assert.deepEqual(service.confirmReplay(target, preview.id), { restored: 1, reopened: 0, skipped: ['third.js', 'shared.js'], batches: 1 });
  assert.equal(fs.existsSync(path.join(source, 'first.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'shared.js'), 'utf8'), 'change 2\n');
  assert.equal(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), 'protected\n');
});

test('group replay is atomic when a file cannot be written and remains available for retry', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  for (const file of ['a.js', 'b.js']) { host(file, 'base\n'); put(file, 'base\n'); }
  await service.initialize(target);
  put('b.js', 'applied\n');
  await applyWorkerBatch(service, target);
  put('a.js', 'applied\n');
  await applyWorkerBatch(service, target);
  const before = service.undoStatus(target);
  const storage = path.join(source, 'profile', 'worker-reviews');
  const backups = fs.readdirSync(storage).sort();
  const selection = replaySelection(before.batches, 'undo');
  const { id } = service.previewReplay(target, 'undo', selection);
  const rename = fs.renameSync;
  const locked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(source, 'b.js')) throw Object.assign(Error('locked by editor'), { code: 'EBUSY' });
    return rename(from, to);
  });
  try {
    assert.throws(() => service.confirmReplay(target, id), { code: 'EBUSY' });
  } finally { locked.mock.restore(); }
  assert.deepEqual(service.undoStatus(target), before);
  assert.deepEqual(fs.readdirSync(storage).sort(), backups);
  for (const file of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'applied\n');
  const retry = service.previewReplay(target, 'undo', selection);
  assert.deepEqual(service.confirmReplay(target, retry.id), { restored: 2, reopened: 0, skipped: [], batches: 2 });
});

test('group replay records both transitions when several batches cancel out on disk', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  host('code.js', 'base\n');
  put('code.js', 'base\n');
  await service.initialize(target);
  put('code.js', 'intermediate\n');
  await applyWorkerBatch(service, target);
  put('code.js', 'base\n');
  await applyWorkerBatch(service, target);
  const before = service.undoStatus(target);
  const preview = service.previewReplay(target, 'undo', replaySelection(before.batches, 'undo'));
  assert.deepEqual(preview.files, [{ path: 'code.js', effect: 'history', skipped: null }]);
  await assert.rejects(service.replayDiff(target, preview.id, 'code.js'), { reviewKey: 'workerChanges.historyDiffUnavailable' });
  assert.deepEqual(service.confirmReplay(target, preview.id), { restored: 0, reopened: 0, skipped: [], batches: 2 });
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'base\n');
  const redo = service.undoStatus(target).lastUndoneApplication;
  assert.equal(service.redo(target, redo.id).reapplied, 1);
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'intermediate\n');
  assert.equal(service.redo(target, service.undoStatus(target).lastUndoneApplication.id).reapplied, 1);
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), 'base\n');
});

test('combined diffs show the eligible transitions and identify binary versions', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  host('shared.js', 'base\n');
  put('shared.js', 'base\n');
  const before = Buffer.from([0, 128]);
  const after = Buffer.from([0, 255]);
  host('image.bin', before);
  put('image.bin', before);
  await service.initialize(target);
  put('shared.js', 'first\n');
  await applyWorkerBatch(service, target);
  host('shared.js', 'later local edit\n');
  put('shared.js', 'second\n');
  put('image.bin', after);
  await applyWorkerBatch(service, target, ({ index, blocked }) => blocked ? { index, strategy: 'worker' } : index);

  const preview = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  assert.deepEqual(preview.files.find(({ path }) => path === 'shared.js'), { path: 'shared.js', effect: 'modify', skipped: 'changed' });
  assert.match((await service.replayDiff(target, preview.id, 'shared.js')).diff, /-second\n\+later local edit/);
  assert.deepEqual(await service.replayDiff(target, preview.id, 'image.bin'), {
    binary: true, beforeHash: hashBytes(after), afterHash: hashBytes(before), modeChanged: false,
  });
  assert.equal(fs.readFileSync(path.join(source, 'shared.js'), 'utf8'), 'second\n');
  assert.deepEqual(fs.readFileSync(path.join(source, 'image.bin')), after);
  assert.deepEqual(service.confirmReplay(target, preview.id), { restored: 2, reopened: 1, skipped: ['shared.js'], batches: 1 });
  assert.equal(fs.readFileSync(path.join(source, 'shared.js'), 'utf8'), 'later local edit\n');
  assert.deepEqual(fs.readFileSync(path.join(source, 'image.bin')), before);
  await assert.rejects(service.replayDiff(target, preview.id, 'image.bin'), { reviewKey: 'workerChanges.historyPreviewStale' });
});

test('file selection scopes group undo and redo, including history-only resolutions and shared paths', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  for (const file of ['shared.js', 'other.js', 'keep.js']) {
    host(file, 'base\n');
    put(file, 'base\n');
  }
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put('shared.js', 'first\n');
  put('other.js', 'first other\n');
  await applyWorkerBatch(service, target);
  put('shared.js', 'second\n');
  put('other.js', 'second other\n');
  put('keep.js', 'worker proposal\n');
  host('keep.js', 'keep the host version\n');
  await applyWorkerBatch(service, target, ({ index, blocked }) => blocked ? { index, strategy: 'host' } : index);

  const preview = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  for (const paths of [['AGENTS.md'], ['agents.MD'], ['../AGENTS.md'], ['outside.js'], ['shared.js', 'shared.js'], 'shared.js']) {
    assert.throws(() => service.updateReplayPreview(target, preview.id, paths), { reviewKey: 'workerChanges.historyFileSelection' });
  }
  const cleared = service.updateReplayPreview(target, preview.id, []);
  assert.deepEqual(cleared.files, []);
  assert.equal(cleared.ready, 0);
  assert.throws(() => service.confirmReplay(target, preview.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const scoped = service.updateReplayPreview(target, cleared.id, ['shared.js', 'keep.js']);
  assert.equal(scoped.ready, 2);
  assert.deepEqual(scoped.files.toSorted((a, b) => a.path.localeCompare(b.path)), [
    { path: 'keep.js', effect: 'history', skipped: null },
    { path: 'shared.js', effect: 'modify', skipped: null },
  ]);
  await assert.rejects(service.replayDiff(target, cleared.id, 'shared.js'), { reviewKey: 'workerChanges.historyPreviewStale' });
  await assert.rejects(service.replayDiff(target, scoped.id, 'other.js'), { reviewKey: 'workerChanges.historyDiffUnavailable' });
  assert.match((await service.replayDiff(target, scoped.id, 'shared.js')).diff, /-second\n\+base/);
  assert.equal(read('shared.js'), 'second\n');
  host('other.js', 'later edit on the omitted file\n');
  host('AGENTS.md', 'architect update\n');
  assert.deepEqual(service.confirmReplay(target, scoped.id), { restored: 1, reopened: 1, skipped: [], batches: 2 });
  assert.equal(read('shared.js'), 'base\n');
  assert.equal(read('other.js'), 'later edit on the omitted file\n');
  assert.equal(read('keep.js'), 'keep the host version\n');
  assert.deepEqual(service.undoStatus(target).batches.map(({ undo, redo }) => [undo.count, redo.count]), [[1, 2], [1, 1]]);

  const restarted = restart();
  const prepareRedo = () => {
    const all = restarted.previewReplay(target, 'redo', replaySelection(restarted.undoStatus(target).batches, 'redo'));
    return restarted.updateReplayPreview(target, all.id, ['shared.js']);
  };
  const redo = prepareRedo();
  assert.match((await restarted.replayDiff(target, redo.id, 'shared.js')).diff, /-base\n\+second/);
  host('shared.js', 'new local draft\n');
  assert.throws(() => restarted.confirmReplay(target, redo.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read('shared.js'), 'new local draft\n');
  host('shared.js', 'base\n');
  assert.deepEqual(restarted.confirmReplay(target, prepareRedo().id), { reapplied: 1, resolved: 0, skipped: [], batches: 2 });
  assert.equal(read('shared.js'), 'second\n');
  assert.equal(read('other.js'), 'later edit on the omitted file\n');
  assert.equal(read('AGENTS.md'), 'architect update\n');
  assert.equal(restarted.undoStatus(target).batches[0].redo.count, 1);
});

test('updating a file selection rechecks local changes and leaves newly ineligible records pending', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  for (const name of ['first.js', 'second.js']) {
    host(name, 'base\n');
    put(name, 'base\n');
  }
  await service.initialize(target);
  put('first.js', 'worker\n');
  await applyWorkerBatch(service, target);
  put('second.js', 'worker\n');
  await applyWorkerBatch(service, target);
  const initial = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  host('second.js', 'late edit\n');
  const scoped = service.updateReplayPreview(target, initial.id, ['first.js', 'second.js']);
  assert.equal(scoped.ready, 1);
  assert.deepEqual(scoped.files.find(({ path }) => path === 'second.js'), { path: 'second.js', effect: null, skipped: 'changed' });
  await assert.rejects(service.replayDiff(target, scoped.id, 'second.js'), { reviewKey: 'workerChanges.historyDiffUnavailable' });
  assert.deepEqual(service.confirmReplay(target, scoped.id), { restored: 1, reopened: 0, skipped: ['second.js'], batches: 1 });
  assert.equal(fs.readFileSync(path.join(source, 'second.js'), 'utf8'), 'late edit\n');
  assert.equal(service.undoStatus(target).batches[0].undo.count, 1);
});

test('partial group replay preserves the remaining hunks and both directions across restarts', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const file = 'code.js';
  const read = (name = file) => fs.readFileSync(path.join(source, name), 'utf8');
  const code = (left, right) => '\uFEFF' + [left, ...Array.from({ length: 16 }, (_, index) => `context ${index}`), right].join('\r\n');
  const base = code('original left', 'original right');
  const middle = code('worker left', 'original right');
  const full = code('worker left', 'worker right');
  const partial = code('original left', 'worker right');
  host(file, base);
  put(file, base);
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put(file, middle);
  await applyWorkerBatch(service, target);
  put(file, full);
  await applyWorkerBatch(service, target);

  const preview = (instance, direction) => instance.previewReplay(target, direction,
    replaySelection(instance.undoStatus(target).batches.filter((batch) => batch[direction]), direction));
  const undo = preview(service, 'undo');
  const diff = await service.replayDiff(target, undo.id, file);
  assert.equal(diff.hunks.length, 2);
  assert.ok(diff.hunks.every(({ included }) => included));
  for (const item of [{ file, indexes: [] }, { file, indexes: [2] }, { file, indexes: [0, 0] },
    { file: 'AGENTS.md', indexes: [0] }, { file: '../code.js', indexes: [0] }]) {
    assert.throws(() => service.updateReplayHunks(target, undo.id, item), { reviewKey: 'workerChanges.historyHunkSelection' });
  }
  const revised = service.updateReplayHunks(target, undo.id, { file, indexes: [0] });
  assert.deepEqual(revised.lines, [{ path: file, selected: 2, total: 4 }]);
  assert.throws(() => service.confirmReplay(target, undo.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const scoped = service.updateReplayPreview(target, revised.id, [file]);
  const projected = await service.replayDiff(target, scoped.id, file);
  assert.deepEqual(projected.hunks.map(({ included }) => included), [true, false]);
  assert.equal(projected.afterHash, hashBytes(Buffer.from(partial)));
  assert.doesNotMatch(projected.diff, /worker right|original right/);
  assert.equal(read(), full);
  host('AGENTS.md', 'architect rules\n');
  assert.deepEqual(service.confirmReplay(target, scoped.id), { restored: 1, reopened: 0, skipped: [], batches: 2 });
  assert.equal(read(), partial);
  assert.equal(read('AGENTS.md'), 'architect rules\n');

  const continued = restart();
  assert.equal(continued.undoStatus(target).batches[0].pathCount, 1);
  const remaining = preview(continued, 'undo');
  const remainingDiff = await continued.replayDiff(target, remaining.id, file);
  assert.match(remainingDiff.diff, /-worker right[\s\S]*\+original right/);
  assert.equal(continued.confirmReplay(target, remaining.id).restored, 1);
  assert.equal(read(), base);

  const redo = preview(continued, 'redo');
  assert.equal((await continued.replayDiff(target, redo.id, file)).hunks.length, 2);
  const partialRedo = continued.updateReplayHunks(target, redo.id, { file, indexes: [1] });
  assert.equal((await continued.replayDiff(target, partialRedo.id, file)).afterHash, hashBytes(Buffer.from(partial)));
  assert.equal(continued.confirmReplay(target, partialRedo.id).reapplied, 1);
  assert.equal(read(), partial);
  const again = restart();
  assert.equal(again.undo(target, again.undoStatus(target).lastApplication.id).restored, 1);
  assert.equal(read(), base);
  assert.equal(again.redo(target, again.undoStatus(target).lastUndoneApplication.id).reapplied, 1);
  assert.equal(read(), full);

  const priorBranch = preview(again, 'undo');
  await again.replayDiff(target, priorBranch.id, file);
  const split = again.updateReplayHunks(target, priorBranch.id, { file, indexes: [0] });
  again.confirmReplay(target, split.id);
  put('new.js', 'new branch\n');
  await applyWorkerBatch(again, target);
  assert.equal(again.undoStatus(target).lastUndoneApplication, null);
  again.undo(target, again.undoStatus(target).lastApplication.id);
  again.undo(target, again.undoStatus(target).lastApplication.id);
  assert.equal(read(), base);
  again.redo(target, again.undoStatus(target).lastUndoneApplication.id);
  assert.equal(read(), partial);
});

test('a local edit invalidates a selected hunk preview before any writes', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  const text = (start, end) => start + '\n' + 'context\n'.repeat(16) + end + '\n';
  host('code.js', text('original start', 'original end'));
  put('code.js', text('original start', 'original end'));
  await service.initialize(target);
  put('code.js', text('worker start', 'worker end'));
  await applyWorkerBatch(service, target);
  const preview = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  await service.replayDiff(target, preview.id, 'code.js');
  const selected = service.updateReplayHunks(target, preview.id, { file: 'code.js', indexes: [1] });
  const edited = text('worker start', 'worker end') + 'later draft\n';
  host('code.js', edited);
  assert.throws(() => service.confirmReplay(target, selected.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(fs.readFileSync(path.join(source, 'code.js'), 'utf8'), edited);
  assert.equal(service.undoStatus(target).lastUndoneApplication, null);
});

test('group replay selects individual additions and removals in one combined hunk', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const code = 'code.js';
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  const base = '\uFEFFbase header\r\nbase footer';
  const mid = '\uFEFFworker header\r\nbase footer';
  const full = '\uFEFFworker header\r\nworker footer';
  host(code, base);
  put(code, base);
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put(code, mid);
  await applyWorkerBatch(service, target);
  put(code, full);
  await applyWorkerBatch(service, target);

  const preview = (instance, direction) => instance.previewReplay(target, direction,
    replaySelection(instance.undoStatus(target).batches.filter((batch) => batch[direction]), direction));
  const undo = preview(service, 'undo');
  const combined = await service.replayDiff(target, undo.id, code);
  assert.equal(combined.hunks.length, 1);
  const changed = combined.hunks[0].rows.filter(({ index }) => index !== undefined);
  assert.equal(changed.length, 4);
  assert.match(combined.diff, /\\ No newline at end of file/);
  const addedFooter = changed.find(({ text }) => text === '+base footer');
  assert.equal(addedFooter.number, 2);
  for (const item of [{ file: code, indexes: [] }, { file: code, indexes: [4] }, { file: code, indexes: [0, 0] },
    { file: 'AGENTS.md', indexes: [0] }, { file: 'agents.MD', indexes: [0] }, { file: '../code.js', indexes: [0] }]) {
    assert.throws(() => service.updateReplayLines(target, undo.id, item), { reviewKey: 'workerChanges.historyLineSelection' });
  }
  const selected = service.updateReplayLines(target, undo.id, { file: code, indexes: [addedFooter.index] });
  assert.throws(() => service.confirmReplay(target, undo.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const projected = await service.replayDiff(target, selected.id, code);
  const partial = full + '\r\nbase footer';
  assert.equal(projected.afterHash, hashBytes(Buffer.from(partial)));
  assert.deepEqual(projected.hunks[0].rows.filter(({ included }) => included).map(({ text }) => text), ['+base footer']);
  assert.equal(projected.hunks[0].included, false);
  assert.equal(read(code), full);
  host('AGENTS.md', 'architect edit\n');
  assert.deepEqual(service.confirmReplay(target, selected.id), { restored: 1, reopened: 0, skipped: [], batches: 2 });
  assert.equal(read(code), partial);

  const resumed = restart();
  assert.equal(resumed.confirmReplay(target, preview(resumed, 'undo').id).restored, 1);
  assert.equal(read(code), base);
  const redo = preview(resumed, 'redo');
  const redoDiff = await resumed.replayDiff(target, redo.id, code);
  const removedFooter = redoDiff.hunks[0].rows.find(({ text }) => text === '-base footer');
  const redoSelection = resumed.updateReplayLines(target, redo.id, { file: code, indexes: [removedFooter.index] });
  const withoutFooter = '\uFEFFbase header\r\n';
  assert.equal((await resumed.replayDiff(target, redoSelection.id, code)).afterHash, hashBytes(Buffer.from(withoutFooter)));
  assert.equal(resumed.confirmReplay(target, redoSelection.id).reapplied, 1);
  assert.equal(read(code), withoutFooter);
  const pending = preview(resumed, 'redo');
  host(code, withoutFooter + '// later local edit\r\n');
  assert.throws(() => resumed.confirmReplay(target, pending.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read(code), withoutFooter + '// later local edit\r\n');
  assert.equal(read('AGENTS.md'), 'architect edit\n');
});

test('group replay selects disjoint ranges in the same inline fragment while preserving history and later edits', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const file = 'config.js';
  const text = (mode, timeout, label) => `\uFEFFmode=${mode} timeout=${timeout} label=${label}\r\nlast line`;
  const base = text('dev', 10, '👩🏽‍🔬');
  const middle = text('prod', 10, '👩🏽‍🔬');
  const full = text('prod', 20, '🚀');
  const read = (name) => fs.readFileSync(path.join(source, name), 'utf8');
  host(file, base);
  put(file, base);
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put(file, middle);
  await applyWorkerBatch(service, target);
  put(file, full);
  await applyWorkerBatch(service, target);

  async function open(instance, direction) {
    const preview = instance.previewReplay(target, direction, replaySelection(
      instance.undoStatus(target).batches.filter((batch) => batch[direction]), direction));
    const diff = await instance.replayDiff(target, preview.id, file);
    const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
    const { parts } = instance.replayInline(target, preview.id, { file, line });
    return { id: preview.id, item: { file, line }, parts };
  }
  const undo = await open(service, 'undo');
  const removeProd = undo.parts.find(({ text, kind }) => text === 'prod' && kind === 'remove');
  const addDev = undo.parts.find(({ text, kind }) => text === 'dev' && kind === 'add');
  const addEmoji = undo.parts.find(({ text }) => text === '👩🏽‍🔬');
  const partRanges = ({ index, ranges }) => ranges.map((range) => ({ ...range, index }));
  const [fullProd] = partRanges(removeProd);
  for (const item of [
    { ...undo.item, file: 'AGENTS.md', ranges: [fullProd] },
    { ...undo.item, file: '../config.js', ranges: [fullProd] },
    { ...undo.item, line: 100, ranges: [fullProd] },
    { ...undo.item, ranges: [fullProd, fullProd] },
    { ...undo.item, ranges: [fullProd, { index: removeProd.index, start: 1, end: 2 }] },
    { ...undo.item, ranges: [{ index: addEmoji.index, start: 0, end: 2 }] },
  ]) assert.throws(() => service.updateReplayInline(target, undo.id, item), { reviewKey: 'workerChanges.historyInlineSelection' });

  const ranges = [
    { index: removeProd.index, start: 0, end: 1 },
    { index: removeProd.index, start: 2, end: 4 },
    { index: addDev.index, start: 0, end: 1 },
    { index: addDev.index, start: 2, end: 3 },
  ];
  const selected = service.updateReplayInline(target, undo.id, { ...undo.item, ranges: ranges.toReversed() });
  assert.throws(() => service.confirmReplay(target, undo.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const projected = await service.replayDiff(target, selected.id, file);
  const result = text('rdv', 20, '🚀');
  assert.equal(projected.afterHash, hashBytes(Buffer.from(result)));
  assert.equal(projected.hunks[0].included, false);
  const reviewed = service.replayInline(target, selected.id, undo.item);
  assert.deepEqual(reviewed.parts.flatMap(partRanges), ranges);
  assert.equal(read(file), full);
  host('AGENTS.md', 'architect edit\n');
  assert.deepEqual(service.confirmReplay(target, selected.id), { restored: 1, reopened: 0, skipped: [], batches: 2 });
  assert.equal(read(file), result);

  const resumed = restart();
  const remaining = await open(resumed, 'undo');
  assert.equal(resumed.confirmReplay(target, remaining.id).restored, 1);
  assert.equal(read(file), base);
  const redo = await open(resumed, 'redo');
  const removeDev = redo.parts.find(({ text, kind }) => text === 'dev' && kind === 'remove');
  const addProd = redo.parts.find(({ text, kind }) => text === 'prod' && kind === 'add');
  const redone = resumed.updateReplayInline(target, redo.id, {
    ...redo.item, ranges: [...partRanges(removeDev), { index: addProd.index, start: 0, end: 1 }, { index: addProd.index, start: 3, end: 4 }],
  });
  assert.equal((await resumed.replayDiff(target, redone.id, file)).afterHash, hashBytes(Buffer.from(text('pd', 10, '👩🏽‍🔬'))));
  host(file, base + ' // local edit');
  assert.throws(() => resumed.confirmReplay(target, redone.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read(file), base + ' // local edit');
  assert.equal(read('AGENTS.md'), 'architect edit\n');
});

test('inline replay can shorten an inserted line and reset to the full line selection', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  const file = 'config.js';
  host(file, 'first\n');
  put(file, 'first\n');
  await service.initialize(target);
  put(file, 'first\nsecond sentence\n');
  await applyWorkerBatch(service, target);
  service.undo(target, service.undoStatus(target).lastApplication.id);
  const preview = service.previewReplay(target, 'redo', replaySelection(service.undoStatus(target).batches, 'redo'));
  const diff = await service.replayDiff(target, preview.id, file);
  const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
  const { parts: [added] } = service.replayInline(target, preview.id, { file, line });
  const next = service.updateReplayInline(target, preview.id, {
    file, line, ranges: [{ index: added.index, start: 2, end: 6 }, { index: added.index, start: 0, end: 2 }],
  });
  assert.equal((await service.replayDiff(target, next.id, file)).afterHash, hashBytes(Buffer.from('first\nsecond\n')));
  assert.deepEqual(service.replayInline(target, next.id, { file, line }).parts[0].ranges, [{ start: 0, end: 6 }]);
  const reset = service.updateReplayLines(target, next.id, { file, indexes: [line], reset: [line] });
  assert.deepEqual(reset.lines, []);
  assert.equal(service.confirmReplay(target, reset.id).reapplied, 1);
  assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'first\nsecond sentence\n');
});

test('inline batches validate all staged fragments together across lines and files before issuing a revision', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const text = (start, end) => `header ${start}\n` + 'context\n'.repeat(16) + `footer ${end}\n`;
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  const initialA = text('original', 'initial');
  const appliedA = text('abcdef', 'uvwxyz');
  const initialB = 'baseline\n';
  const appliedB = 'changed\n';
  host('a.js', initialA);
  host('b.js', initialB);
  host('AGENTS.md', 'protected\n');
  put('a.js', initialA);
  put('b.js', initialB);
  await service.initialize(target);
  put('a.js', appliedA);
  await applyWorkerBatch(service, target);
  put('b.js', appliedB);
  await applyWorkerBatch(service, target);

  async function prepare(instance, direction) {
    const preview = instance.previewReplay(target, direction, replaySelection(
      instance.undoStatus(target).batches.filter((batch) => batch[direction]), direction));
    const selections = [];
    for (const file of ['a.js', 'b.js']) {
      const diff = await instance.replayDiff(target, preview.id, file);
      for (const { index: line } of diff.hunks.flatMap(({ rows }) => rows).filter(({ inline }) => inline)) {
        const { parts } = instance.replayInline(target, preview.id, { file, line });
        const ranges = parts.flatMap(({ text: part, kind, index }) => kind === 'remove'
          ? [{ index, start: 0, end: part.length }]
          : [{ index, start: 0, end: 1 }, { index, start: part.length - 1, end: part.length }]);
        selections.push({ file, line, ranges });
      }
    }
    return { id: preview.id, selections };
  }

  const undo = await prepare(service, 'undo');
  assert.deepEqual(undo.selections.map(({ file }) => file), ['a.js', 'a.js', 'b.js']);
  const [first, , last] = undo.selections;
  for (const selections of [[first, first], [first, { ...last, file: 'docs/aGeNtS.md' }],
    [first, { ...last, ranges: [{ index: 999, start: 0, end: 1 }] }]]) {
    assert.throws(() => service.updateReplayInlineBatch(target, undo.id, selections), { reviewKey: 'workerChanges.historyInlineSelection' });
    assert.equal((await service.replayDiff(target, undo.id, first.file)).partial, false);
  }
  host('b.js', 'new local draft\n');
  assert.throws(() => service.updateReplayInlineBatch(target, undo.id, undo.selections),
    { reviewKey: 'workerChanges.historyPreviewStale', file: 'b.js' });
  assert.equal((await service.replayDiff(target, undo.id, 'a.js')).partial, false);
  assert.equal(read('b.js'), 'new local draft\n');
  host('b.js', appliedB);

  const combined = service.updateReplayInlineBatch(target, undo.id, undo.selections);
  assert.deepEqual(combined.lines.map(({ path, textSelections }) => [path, textSelections]), [['a.js', 2], ['b.js', 1]]);
  assert.throws(() => service.confirmReplay(target, undo.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal((await service.replayDiff(target, combined.id, 'a.js')).afterHash, hashBytes(Buffer.from(text('ol', 'il'))));
  assert.equal((await service.replayDiff(target, combined.id, 'b.js')).afterHash, hashBytes(Buffer.from('be\n')));
  assert.equal(read('a.js'), appliedA);
  assert.equal(read('b.js'), appliedB);
  assert.deepEqual(service.confirmReplay(target, combined.id), { restored: 2, reopened: 0, skipped: [], batches: 2 });
  assert.equal(read('a.js'), text('ol', 'il'));
  assert.equal(read('b.js'), 'be\n');
  assert.equal(read('AGENTS.md'), 'protected\n');

  const resumed = restart();
  const redo = await prepare(resumed, 'redo');
  const scoped = resumed.updateReplayPreview(target, redo.id, ['a.js']);
  assert.deepEqual(scoped.retained, ['a.js']);
  const expanded = resumed.updateReplayPreview(target, scoped.id, ['a.js', 'b.js']);
  assert.deepEqual(expanded.retained, ['a.js']);
  await resumed.replayDiff(target, expanded.id, 'b.js');
  const redone = resumed.updateReplayInlineBatch(target, expanded.id, redo.selections);
  assert.equal((await resumed.replayDiff(target, redone.id, 'a.js')).afterHash, hashBytes(Buffer.from(text('af', 'uz'))));
  assert.equal((await resumed.replayDiff(target, redone.id, 'b.js')).afterHash, hashBytes(Buffer.from('cd\n')));
  host('b.js', 'later b.js edit\n');
  assert.throws(() => resumed.confirmReplay(target, redone.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read('a.js'), text('ol', 'il'));
  assert.equal(read('b.js'), 'later b.js edit\n');
  assert.equal(read('AGENTS.md'), 'protected\n');
  assert.throws(() => resumed.confirmReplay(target, redone.id), { reviewKey: 'workerChanges.historyPreviewStale' });

  const refreshed = await resumed.refreshReplayPreview(target, redone.id);
  assert.deepEqual(refreshed.retained, ['a.js']);
  assert.deepEqual(refreshed.lines.map(({ path, textSelections }) => [path, textSelections]), [['a.js', 2]]);
  assert.equal((await resumed.replayDiff(target, refreshed.id, 'a.js')).afterHash, hashBytes(Buffer.from(text('af', 'uz'))));
  assert.throws(() => resumed.confirmReplay(target, redone.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.deepEqual(resumed.confirmReplay(target, refreshed.id), { reapplied: 1, resolved: 0, skipped: ['b.js'], batches: 1 });
  assert.equal(read('a.js'), text('af', 'uz'));
  assert.equal(read('b.js'), 'later b.js edit\n');
  assert.equal(read('AGENTS.md'), 'protected\n');
});

test('refresh keeps disjoint inline selections and later edits in both replay directions', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const file = 'settings.js';
  const read = (name = file) => fs.readFileSync(path.join(source, name), 'utf8');
  const text = (mode, count, label, notes = '') => `mode=${mode} count=${count} owner=${label}\r\nend\r\n${notes}`;
  host(file, text('aaaa', '1111', 'original'));
  put(file, read());
  host('AGENTS.md', 'rules\n');
  await service.initialize(target);
  put(file, text('bbbb', '2222', 'original'));
  await applyWorkerBatch(service, target);
  const undo = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  const diff = await service.replayDiff(target, undo.id, file);
  const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
  const { parts } = service.replayInline(target, undo.id, { file, line });
  const ranges = parts.filter(({ text }) => text === 'aaaa' || text === 'bbbb')
    .map(({ index, text }) => ({ index, start: 0, end: text.length }));
  assert.equal(ranges.length, 2);
  const staged = { file, line, ranges };
  await assert.rejects(service.refreshReplayPreview(target, undo.id, [{ ...staged, file: 'nested/aGeNtS.md' }]),
    { reviewKey: 'workerChanges.historyInlineSelection' });
  const live = text('bbbb', '2222', 'local', '// later note\r\n');
  host(file, live);
  host('AGENTS.md', 'architect update\n');
  const refreshed = await service.refreshReplayPreview(target, undo.id, [staged]);
  assert.deepEqual(refreshed.recovered, [file]);
  assert.deepEqual(refreshed.conflicts, []);
  const expected = text('aaaa', '2222', 'local', '// later note\r\n');
  assert.equal((await service.replayDiff(target, refreshed.id, file)).afterHash, hashBytes(Buffer.from(expected)));
  assert.equal(read(), live);
  const secondNote = '// another change\r\n';
  host(file, live + secondNote);
  assert.throws(() => service.confirmReplay(target, refreshed.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const refreshedAgain = await service.refreshReplayPreview(target, refreshed.id);
  assert.deepEqual(refreshedAgain.recovered, [file]);
  assert.equal((await service.replayDiff(target, refreshedAgain.id, file)).afterHash, hashBytes(Buffer.from(expected + secondNote)));
  assert.equal(service.confirmReplay(target, refreshedAgain.id).restored, 1);
  assert.equal(read(), expected + secondNote);
  assert.equal(read('AGENTS.md'), 'architect update\n');

  const resumed = restart();
  resumed.undo(target, resumed.undoStatus(target).lastApplication.id);
  assert.equal(read(), text('aaaa', '1111', 'local', '// later note\r\n') + secondNote);
  resumed.redo(target, resumed.undoStatus(target).lastUndoneApplication.id);
  assert.equal(read(), live + secondNote);
});

test('refresh excludes overlapping selected edits and preserves later edits over overlapping pending changes', async (t) => {
  const { target, source, service, host, put } = fixture(t);
  const file = 'settings.js';
  host(file, 'mode=aaaa count=1111\n');
  put(file, 'mode=aaaa count=1111\n');
  await service.initialize(target);
  put(file, 'mode=bbbb count=2222\n');
  await applyWorkerBatch(service, target);
  const undo = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  const diff = await service.replayDiff(target, undo.id, file);
  const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
  const { parts } = service.replayInline(target, undo.id, { file, line });
  const ranges = parts.filter(({ text }) => text === 'aaaa' || text === 'bbbb')
    .map(({ index, text }) => ({ index, start: 0, end: text.length }));
  const draft = { file, line, ranges };
  assert.equal(ranges.length, 2);
  const selected = service.updateReplayInline(target, undo.id, draft);
  host(file, 'mode=local count=2222\n');
  const overlap = await service.refreshReplayPreview(target, selected.id);
  assert.deepEqual(overlap.conflicts, [file]);
  assert.deepEqual(overlap.unavailableFiles, [file]);
  assert.equal(overlap.selectionConflicts[0].path, file);
  assert.throws(() => service.updateReplayPreview(target, overlap.id, [file]), { reviewKey: 'workerChanges.historyFileSelection' });
  assert.equal(overlap.ready, 0);
  assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'mode=local count=2222\n');

  host(file, 'mode=bbbb count=2222\n');
  const again = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  await service.replayDiff(target, again.id, file);
  const partial = service.updateReplayInline(target, again.id, draft);
  host(file, 'mode=bbbb count=9999\n');
  const kept = await service.refreshReplayPreview(target, partial.id);
  assert.deepEqual(kept.recovered, [file]);
  assert.equal(kept.limited, 1);
  assert.equal(service.confirmReplay(target, kept.id).restored, 1);
  assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'mode=aaaa count=9999\n');
  service.redo(target, service.undoStatus(target).lastUndoneApplication.id);
  assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), 'mode=bbbb count=9999\n');
});

test('refresh keeps compatible selections from a file with conflicts and preserves local text in split history', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const file = 'settings.js';
  const read = (name = file) => fs.readFileSync(path.join(source, name), 'utf8');
  const text = (mode, count, extra) => `mode=${mode} count=${count} extra=${extra}\r\n`;
  host('AGENTS.md', 'rules\n');
  host(file, text('editor', '1111', 'old'));
  put(file, read());
  await service.initialize(target);
  put(file, text('original', '2222', 'new'));
  await applyWorkerBatch(service, target);
  const preview = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  const diff = await service.replayDiff(target, preview.id, file);
  const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
  const { parts } = service.replayInline(target, preview.id, { file, line });
  const ranges = parts.filter(({ text }) => ['editor', 'original', '1111', '2222'].includes(text))
    .map(({ index, text }) => ({ index, start: 0, end: text.length }));
  assert.equal(ranges.length, 4);
  const staged = { file, line, ranges };
  host('AGENTS.md', 'architect update\n');
  const live = text('worker', '2222', 'new');
  host(file, live);

  const refreshed = await service.refreshReplayPreview(target, preview.id, [staged]);
  assert.deepEqual(refreshed.recovered, [file]);
  assert.deepEqual(refreshed.conflicts, []);
  assert.deepEqual(refreshed.unavailableFiles, []);
  assert.deepEqual(refreshed.selectionConflicts, [{ path: file, count: 1,
    details: [{ line: 1, local: 'worker', selected: 'editor' }] }]);
  const scoped = service.updateReplayPreview(target, refreshed.id, []);
  const restoredScope = service.updateReplayPreview(target, scoped.id, [file]);
  assert.deepEqual(restoredScope.selectionConflicts, refreshed.selectionConflicts);
  const expected = text('worker', '1111', 'new');
  assert.equal((await service.replayDiff(target, restoredScope.id, file)).afterHash, hashBytes(Buffer.from(expected)));
  assert.equal(read(), live);

  const note = '// another edit\r\n';
  host(file, note + live);
  assert.throws(() => service.confirmReplay(target, restoredScope.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const next = await service.refreshReplayPreview(target, restoredScope.id);
  assert.deepEqual(next.selectionConflicts, refreshed.selectionConflicts);
  assert.equal((await service.replayDiff(target, next.id, file)).afterHash, hashBytes(Buffer.from(note + expected)));
  assert.equal(service.confirmReplay(target, next.id).restored, 1);
  assert.equal(read(), note + expected);

  const resumed = restart();
  resumed.undo(target, resumed.undoStatus(target).lastApplication.id);
  assert.equal(read(), note + text('worker', '1111', 'old'));
  resumed.redo(target, resumed.undoStatus(target).lastUndoneApplication.id);
  assert.equal(read(), note + live);
  assert.equal(read('AGENTS.md'), 'architect update\n');
});

test('replay resolves multiple conflicts in a file with no compatible selections and restores the local version through history', async (t) => {
  const { target, source, service, restart, host, put } = fixture(t);
  const file = 'settings.js';
  const read = (name = file) => fs.readFileSync(path.join(source, name), 'utf8');
  const text = (mode, count, extra) => `mode=${mode} count=${count} extra=${extra}\r\nend\r\n`;
  host('AGENTS.md', 'rules\n');
  host(file, text('editor', '1111', 'old'));
  put(file, read());
  await service.initialize(target);
  put(file, text('original', '2222', 'new'));
  await applyWorkerBatch(service, target);
  const preview = service.previewReplay(target, 'undo', replaySelection(service.undoStatus(target).batches, 'undo'));
  const original = await service.replayDiff(target, preview.id, file);
  const line = original.hunks[0].rows.find(({ inline }) => inline).index;
  const { parts } = service.replayInline(target, preview.id, { file, line });
  const ranges = parts.filter(({ text }) => ['editor', 'original', '1111', '2222'].includes(text))
    .map(({ index, text }) => ({ index, start: 0, end: text.length }));
  const live = text('worker', '3333', 'new');
  host(file, live);
  const first = await service.refreshReplayPreview(target, preview.id, [{ file, line, ranges }]);
  assert.equal(first.ready, 0);
  const { regions } = service.replayConflicts(target, first.id, file);
  assert.deepEqual(regions.map(({ local, selected, choice }) => [local, selected, choice]), [
    ['worker', 'editor', 'local'], ['3333', '1111', 'local'],
  ]);
  const [mode, count] = regions;
  const select = { file, key: mode.key, strategy: 'selected' };
  const note = '// edit after review\r\n';
  host(file, live + note);
  await assert.rejects(service.resolveReplayConflict(target, first.id, select), { reviewKey: 'workerChanges.historyPreviewStale' });
  const refreshed = await service.refreshReplayPreview(target, first.id);
  assert.deepEqual(service.replayConflicts(target, refreshed.id, file).regions, regions);
  await assert.rejects(service.resolveReplayConflict(target, refreshed.id, { ...select, file: 'nested/aGeNtS.md' }),
    { reviewKey: 'workerChanges.historyConflictUnavailable' });
  await assert.rejects(service.resolveReplayConflict(target, refreshed.id, { ...select, strategy: 'manual', content: '\0' }),
    { reviewKey: 'workerChanges.invalidResolution' });

  const countEdit = { file, key: count.key, strategy: 'manual', content: 'valor🌱' };
  const selected = await service.resolveReplayConflictBatch(target, refreshed.id, { items: [select, countEdit] });
  assert.equal(selected.ready, 1);
  assert.deepEqual(selected.included, [file]);
  assert.equal((await service.replayDiff(target, selected.id, file)).afterHash, hashBytes(Buffer.from(text('editor', 'valor🌱', 'new') + note)));
  const kept = await service.resolveReplayConflictBatch(target, selected.id, { strategy: 'local', items: [
    { file, key: mode.key }, { file, key: count.key },
  ] });
  assert.equal(kept.ready, 0);
  assert.deepEqual(kept.included, []);
  const manual = await service.resolveReplayConflict(target, kept.id, countEdit);
  assert.equal((await service.replayDiff(target, manual.id, file)).afterHash, hashBytes(Buffer.from(text('worker', 'valor🌱', 'new') + note)));
  const notes = note + '// another local edit\r\n';
  host(file, live + notes);
  assert.throws(() => service.confirmReplay(target, manual.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  const refreshedManual = await service.refreshReplayPreview(target, manual.id);
  assert.deepEqual(service.replayConflicts(target, refreshedManual.id, file).regions, [mode]);
  assert.equal((await service.replayDiff(target, refreshedManual.id, file)).afterHash,
    hashBytes(Buffer.from(text('worker', 'valor🌱', 'new') + notes)));
  const combined = await service.resolveReplayConflict(target, refreshedManual.id, select);
  assert.equal((await service.replayDiff(target, combined.id, file)).afterHash, hashBytes(Buffer.from(text('editor', 'valor🌱', 'new') + notes)));
  assert.throws(() => service.confirmReplay(target, manual.id), { reviewKey: 'workerChanges.historyPreviewStale' });
  assert.equal(read(), live + notes);
  assert.equal(service.confirmReplay(target, combined.id).restored, 1);
  assert.equal(read(), text('editor', 'valor🌱', 'new') + notes);

  const resumed = restart();
  resumed.undo(target, resumed.undoStatus(target).lastApplication.id);
  assert.equal(read(), text('editor', 'valor🌱', 'old') + notes);
  resumed.redo(target, resumed.undoStatus(target).lastUndoneApplication.id);
  assert.equal(read(), live + notes);
  assert.equal(read('AGENTS.md'), 'rules\n');
});

for (const direction of ['undo', 'redo']) {
  test(`group ${direction} mixes conflict resolutions across files in one preview revision`, async (t) => {
    const { target, source, service, host, put } = fixture(t);
    const files = ['a.js', 'b.js', 'c.js'];
    const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
    const text = (mode, count, extra) => `mode=${mode} count=${count} extra=${extra}\r\nend\r\n`;
    const original = { mode: 'editor', count: '1111', extra: 'old' };
    const worker = { mode: 'original', count: '2222', extra: 'new' };
    const from = direction === 'undo' ? worker : original;
    const to = direction === 'undo' ? original : worker;
    host('AGENTS.md', 'rules\n');
    for (const file of files) {
      host(file, text(original.mode, original.count, original.extra));
      put(file, read(file));
    }
    await service.initialize(target);
    for (const file of files) put(file, text(worker.mode, worker.count, worker.extra));
    await applyWorkerBatch(service, target);
    if (direction === 'redo') service.undo(target, service.undoStatus(target).lastApplication.id);

    const preview = service.previewReplay(target, direction, replaySelection(service.undoStatus(target).batches, direction));
    const drafts = [];
    for (const file of files) {
      const diff = await service.replayDiff(target, preview.id, file);
      const line = diff.hunks[0].rows.find(({ inline }) => inline).index;
      const { parts } = service.replayInline(target, preview.id, { file, line });
      const words = file === 'b.js' ? [from.mode, to.mode, from.count, to.count] : [from.mode, to.mode];
      const ranges = parts.filter(({ text }) => words.includes(text)).map(({ index, text }) => ({ index, start: 0, end: text.length }));
      assert.equal(ranges.length, words.length);
      drafts.push({ file, line, ranges });
      host(file, text('local', from.count, from.extra));
    }
    const first = await service.refreshReplayPreview(target, preview.id, drafts);
    assert.deepEqual(first.unavailableFiles.toSorted(), ['a.js', 'c.js']);
    assert.deepEqual(first.resolvableConflicts.map(({ path }) => path).toSorted(), files);
    const items = files.map((file) => ({ file, key: service.replayConflicts(target, first.id, file).regions[0].key }));
    const batch = { strategy: 'selected', items };
    const invalid = { reviewKey: 'workerChanges.historyConflictUnavailable' };
    const scoped = service.updateReplayPreview(target, first.id, []);
    assert.deepEqual(scoped.resolvableConflicts.map(({ path }) => path).toSorted(), ['a.js', 'c.js']);
    await assert.rejects(service.resolveReplayConflictBatch(target, scoped.id, batch), invalid);
    const expanded = service.updateReplayPreview(target, scoped.id, ['b.js']);
    await assert.rejects(service.resolveReplayConflictBatch(target, expanded.id,
      { ...batch, items: [items[0], { ...items[1], file: 'nested/aGeNtS.md' }] }), invalid);
    await assert.rejects(service.resolveReplayConflictBatch(target, expanded.id, { ...batch, items: [items[0], items[0]] }), invalid);
    await assert.rejects(service.resolveReplayConflictBatch(target, expanded.id, { ...batch, strategy: 'manual' }), invalid);
    assert.equal(service.replayConflicts(target, expanded.id, 'a.js').regions[0].choice, 'local');

    const note = '// later local edit\r\n';
    host('b.js', read('b.js') + note);
    await assert.rejects(service.resolveReplayConflictBatch(target, expanded.id, batch),
      { reviewKey: 'workerChanges.historyPreviewStale', file: 'b.js' });
    assert.equal(service.replayConflicts(target, expanded.id, 'a.js').regions[0].choice, 'local');
    const refreshed = await service.refreshReplayPreview(target, expanded.id);
    const resolved = await service.resolveReplayConflictBatch(target, refreshed.id, batch);
    assert.deepEqual(resolved.included.toSorted(), files);
    assert.throws(() => service.confirmReplay(target, refreshed.id), { reviewKey: 'workerChanges.historyPreviewStale' });
    const expectedA = text(to.mode, from.count, from.extra);
    const expectedB = text(to.mode, to.count, from.extra) + note;
    assert.equal((await service.replayDiff(target, resolved.id, 'a.js')).afterHash, hashBytes(Buffer.from(expectedA)));
    assert.equal((await service.replayDiff(target, resolved.id, 'b.js')).afterHash, hashBytes(Buffer.from(expectedB)));

    const kept = await service.resolveReplayConflictBatch(target, resolved.id, { ...batch, strategy: 'local' });
    assert.deepEqual(kept.included, ['b.js']);
    assert.equal(service.replayConflicts(target, kept.id, 'a.js').regions[0].choice, 'local');
    assert.equal((await service.replayDiff(target, kept.id, 'b.js')).afterHash,
      hashBytes(Buffer.from(text('local', to.count, from.extra) + note)));
    const manual = 'manual🌱\n// reviewed';
    const strategies = [
      { ...items[0], strategy: 'selected' },
      { ...items[1], strategy: 'local' },
      { ...items[2], strategy: 'manual', content: manual },
    ];
    await assert.rejects(service.resolveReplayConflictBatch(target, kept.id, { items: [strategies[0], items[1]] }), invalid);
    await assert.rejects(service.resolveReplayConflictBatch(target, kept.id,
      { items: [strategies[0], { ...strategies[2], file: 'nested/aGeNtS.md' }] }), invalid);
    await assert.rejects(service.resolveReplayConflictBatch(target, kept.id,
      { items: [strategies[0], { ...strategies[2], content: '\0' }] }), { reviewKey: 'workerChanges.invalidResolution', file: 'c.js' });
    assert.equal(service.replayConflicts(target, kept.id, 'a.js').regions[0].choice, 'local');

    const confirmed = await service.resolveReplayConflictBatch(target, kept.id, { items: strategies });
    assert.deepEqual(confirmed.included.toSorted(), files);
    assert.throws(() => service.confirmReplay(target, kept.id), { reviewKey: 'workerChanges.historyPreviewStale' });
    const mixedB = text('local', to.count, from.extra) + note;
    const mixedC = text(manual.replace('\n', '\r\n'), from.count, from.extra);
    assert.equal((await service.replayDiff(target, confirmed.id, 'a.js')).afterHash, hashBytes(Buffer.from(expectedA)));
    assert.equal((await service.replayDiff(target, confirmed.id, 'b.js')).afterHash, hashBytes(Buffer.from(mixedB)));
    assert.equal((await service.replayDiff(target, confirmed.id, 'c.js')).afterHash, hashBytes(Buffer.from(mixedC)));
    assert.equal(read('a.js'), text('local', from.count, from.extra));
    assert.equal(read('b.js'), text('local', from.count, from.extra) + note);
    assert.equal(read('c.js'), text('local', from.count, from.extra));
    const result = service.confirmReplay(target, confirmed.id);
    assert.equal(result.restored ?? result.reapplied, 3);
    assert.equal(read('a.js'), expectedA);
    assert.equal(read('b.js'), mixedB);
    assert.equal(read('c.js'), mixedC);
    assert.equal(read('AGENTS.md'), 'rules\n');
  });
}
