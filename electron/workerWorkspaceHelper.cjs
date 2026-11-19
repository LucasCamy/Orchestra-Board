// Runs in a separate container. No worker commands, Git settings, or code are executed here.
const fs = require('node:fs');
const path = require('node:path');
const { excludedDirectory, validPath, readFileState, MAX_ENTRIES, MAX_BATCH_BYTES } = require('./workerChangePaths.cjs');

const WORKSPACE = '/workspace';
const SOURCE = '/orchestra/source';
const INITIALIZED = path.join(WORKSPACE, '.orchestra-initialized');
function inventory(root) {
  const entries = [];
  const pending = [''];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    const full = path.join(root, directory);
    if (fs.realpathSync.native(full) !== full) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const name = directory ? directory + '/' + entry.name : entry.name;
      if (!validPath(name) || (entry.isDirectory() && excludedDirectory.has(entry.name))) continue;
      if (++visited > MAX_ENTRIES) throw new Error('workspace too large');
      if (entry.isDirectory()) pending.push(name);
      else {
        const state = readFileState(root, name);
        if (state) entries.push([name, state]);
      }
    }
  }
  return entries;
}

function initialize() {
  const legacy = fs.existsSync(INITIALIZED) || fs.readdirSync(WORKSPACE).some((name) => !/^agents\.md$/i.test(name));
  if (legacy) {
    const current = new Map(inventory(WORKSPACE));
    // Existing volumes have no trustworthy record of old deletions.
    const entries = inventory(SOURCE);
    return { legacy, entries, unobserved: entries.filter(([name]) => !current.has(name)).map(([name]) => name) };
  }
  for (const name of fs.readdirSync(SOURCE)) {
    if (/^(?:agents\.md$|\.orchestra-(?:initialized|init-lock)$)/i.test(name)) continue;
    fs.cpSync(path.join(SOURCE, name), path.join(WORKSPACE, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
  const entries = inventory(WORKSPACE);
  return { legacy, entries };
}

const action = process.argv[2];
if (action === 'initialize') {
  const base = initialize();
  const marker = fs.lstatSync(INITIALIZED, { throwIfNoEntry: false });
  if (!marker) fs.closeSync(fs.openSync(INITIALIZED, 'wx'));
  else if (!marker.isFile()) throw new Error('unsafe workspace marker');
  process.stdout.write(JSON.stringify(base) + '\n');
} else if (!fs.lstatSync(INITIALIZED, { throwIfNoEntry: false })?.isFile()) {
  process.stdout.write('{"unavailable":true}');
} else if (action === 'inventory') {
  process.stdout.write(JSON.stringify(inventory(WORKSPACE)));
} else if (action === 'read') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 256 * 1024) process.exit(1);
  });
  process.stdin.on('end', () => {
    const files = JSON.parse(input);
    if (!Array.isArray(files) || files.length > 200 || !files.every(validPath)) throw new Error('invalid files');
    let bytes = 0;
    const result = [];
    for (const file of files) {
      const state = readFileState(WORKSPACE, file, true);
      if (!state?.data) { result.push(state); continue; }
      const { data, mode, ...entry } = state;
      bytes += data.length;
      if (bytes > MAX_BATCH_BYTES) { process.stdout.write('{"tooLarge":true}'); return; }
      result.push({ ...entry, content: data.toString('base64') });
    }
    process.stdout.write(JSON.stringify(result));
  });
} else {
  throw new Error('unknown action');
}
