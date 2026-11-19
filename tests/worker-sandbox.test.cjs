const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { createWorkerSandbox, containerArgs } = require('../electron/workerSandbox.cjs');
const { createWorkerChanges } = require('../electron/workerChanges.cjs');

const image = process.env.ORCHESTRA_TEST_WORKER_IMAGE;
const snapshot = (text) => ({ text, revision: createHash('sha256').update(text).digest('hex') });

test('the worker can write only Docker volumes and receives no extra capabilities', () => {
  const options = {
    name: 'worker-fixture', workVolume: 'project-fixture', homeVolume: 'home-fixture',
    source: '/fixture/project', rules: '/fixture/AGENTS.md', config: '/fixture/config', image: 'worker-fixture:local',
  };
  const args = containerArgs(options);
  const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1]] : []);
  assert.deepEqual(mounts.filter((mount) => mount.startsWith('type=bind')), [
    'type=bind,source=/fixture/project,target=/orchestra/source,readonly,bind-recursive=disabled',
    'type=bind,source=/fixture/AGENTS.md,target=/workspace/AGENTS.md,readonly,bind-recursive=disabled',
    'type=bind,source=/fixture/config,target=/orchestra/config,readonly,bind-recursive=disabled',
  ]);
  assert.ok(mounts.filter((mount) => !mount.startsWith('type=bind')).every((mount) => mount.startsWith('type=volume')));
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.throws(() => containerArgs({ ...options, source: '/fixture,readonly=false' }), /workerSandbox.path/);
});

test('Docker workers cannot write or replace the Big Brain, including alternate-case paths', { skip: !image }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-worker-test-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const file = path.join(project, 'AGENTS.md');
  fs.writeFileSync(file, 'first revision\n');
  fs.writeFileSync(path.join(project, 'main.js'), 'initial code\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const service = createWorkerSandbox(path.join(root, 'profile'));
  const changes = createWorkerChanges(path.join(root, 'profile'), service);
  const target = service.target('squad', project);
  const oldImage = process.env.ORCHESTRA_WORKER_IMAGE;
  process.env.ORCHESTRA_WORKER_IMAGE = image;
  t.after(() => {
    if (oldImage === undefined) delete process.env.ORCHESTRA_WORKER_IMAGE;
    else process.env.ORCHESTRA_WORKER_IMAGE = oldImage;
  });
  await changes.initialize(target);
  const launch = service.prepare({
    id: 'subagent-fixture', cwd: project, boardId: 'squad', noteId: 'brain',
    state: snapshot('first revision\n'), agent: { id: 'shell' }, servers: {},
  });

  t.after(() => {
    launch.close();
    execFileSync(launch.executable, ['--context', 'desktop-linux', 'volume', 'rm', launch.workVolume]);
  });
  const shell = [
    'set -eu',
    'deny() { if "$@"; then printf "Unexpected success: %s\\n" "$*" >&2; exit 1; fi; }',
    'test "$(cat AGENTS.md)" = "first revision"',
    'test "$(cat main.js)" = "initial code"',
    'deny sh -c "printf denied > AGENTS.md"',
    'deny rm -f AGENTS.md',
    'deny mv AGENTS.md moved.md',
    'deny ln AGENTS.md alternate.md',
    'deny sh -c "printf denied > /orchestra/source/AGENTS.md"',
    'deny sh -c "printf denied > /orchestra/source/agents.md"',
    'deny mv /orchestra/source/AGENTS.md /orchestra/source/moved.md',
    'deny rm -f /orchestra/source/AGENTS.md',
    'printf "worker edit" > main.js',
    'printf "worker addition" > added.js',
    'printf "a shadow file" > agents.md',
    'printf "READY\\n"',
    'read -r proceed',
    'test "$(cat AGENTS.md)" = "user and architect revision"',
    'printf "SYNCED\\n"',
  ].join('\n');
  await new Promise((resolve, reject) => {
    const container = spawn(launch.executable, launch.args.filter((arg) => arg !== '--tty'), {
      env: { ...process.env, ...launch.env, ORCHESTRA_AGENT_COMMAND: shell },
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timeout = setTimeout(() => {
      container.kill();
      reject(new Error('Worker container timed out: ' + stderr));
    }, 40_000);
    container.stdout.on('data', (data) => {
      stdout += data;
      if (ready || !stdout.includes('READY\n')) return;
      ready = true;
      try {
        assert.equal(fs.readFileSync(file, 'utf8'), 'first revision\n');
        assert.equal(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), 'initial code\n');
        fs.writeFileSync(file + '.tmp', 'user and architect revision\n');
        fs.renameSync(file + '.tmp', file);
        service.sync('brain', snapshot(fs.readFileSync(file, 'utf8')));
        container.stdin.end('continue\n');
      } catch (error) {
        container.kill();
        reject(error);
      }
    });
    container.stderr.on('data', (data) => { stderr += data; });
    container.once('error', reject);
    container.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.includes('SYNCED\n')) resolve();
      else reject(new Error(`Worker container exited ${code}\n${stdout}\n${stderr}`));
    });
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'user and architect revision\n');
  fs.writeFileSync(path.join(project, 'main.js'), 'local edit\n');
  const review = await changes.review(target);
  assert.deepEqual(review.files.map(({ path }) => path), ['added.js', 'main.js']);
  assert.equal(review.files[1].blocked, 'conflict');
  try {
    for (const item of review.files) assert.match((await changes.diff(target, review.id, item.index)).diff, /\+worker/);
    const resolution = { index: review.files[1].index, strategy: 'manual', content: 'local edit\nworker edit\n' };
    assert.deepEqual(await changes.apply(target, review.id, [review.files[0].index, resolution]), { applied: 2, resolved: 1 });
    assert.equal(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), 'local edit\nworker edit\n');
    assert.equal(fs.readFileSync(path.join(project, 'added.js'), 'utf8'), 'worker addition');
    assert.equal(fs.readFileSync(file, 'utf8'), 'user and architect revision\n');
    fs.writeFileSync(path.join(project, 'added.js'), 'later local edit\n');
    const last = changes.undoStatus(target).lastApplication;
    assert.deepEqual(changes.undo(target, last.id), { restored: 1, reopened: 1, skipped: ['added.js'] });
    assert.equal(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), 'local edit\n');
    assert.equal(fs.readFileSync(path.join(project, 'added.js'), 'utf8'), 'later local edit\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'user and architect revision\n');
    const undone = changes.undoStatus(target).lastUndoneApplication;
    assert.deepEqual(changes.redo(target, undone.id), { reapplied: 1, resolved: 1, skipped: [] });
    assert.equal(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), 'local edit\nworker edit\n');
    assert.equal(fs.readFileSync(path.join(project, 'added.js'), 'utf8'), 'later local edit\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'user and architect revision\n');
  } finally {
    service.dispose();
  }
});
