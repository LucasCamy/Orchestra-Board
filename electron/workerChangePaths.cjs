const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 30000;
const excludedDirectory = new Set(['node_modules', '.venv']);
const samePath = (a, b) => path.relative(a, b) === '';
const validPath = (file) => typeof file === 'string' && file.length <= 1024 && file.split('/').every((part) =>
  part && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f<>:"\\|?*]|[. ]$|~\d/i.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part) &&
  !/^(?:agents\.md$|\.git$|\.orchestra(?:[-.]|$))/i.test(part));

const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  return stat?.isDirectory() && samePath(fs.realpathSync.native(directory), directory) ? `${stat.dev}:${stat.ino}` : null;
}

function checkedPath(root, relative, includeParents = false) {
  if (!validPath(relative) || !samePath(fs.realpathSync.native(root), root)) return { unsafe: true };
  const parts = relative.split('/');
  const parents = [];
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) {
      if (!includeParents) return null;
      parents.push(directory);
      continue;
    }
    if (!stat.isDirectory() || !samePath(fs.realpathSync.native(directory), directory)) return { unsafe: true };
  }
  return { file: path.join(directory, parts.at(-1)), parents };
}

function readFileState(root, relative, content = false) {
  try {
    const target = checkedPath(root, relative);
    if (!target || target.unsafe) return target;
    const { file } = target;
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1n || !samePath(fs.realpathSync.native(file), file)) return { unsafe: true };
    if (stat.size > BigInt(MAX_FILE)) return { large: true };
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(file, flags);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || stat.ino !== opened.ino || stat.dev !== opened.dev) return { unsafe: true };
      const size = Number(stat.size);
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (length !== size || after.size !== stat.size || after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs) return { unsafe: true };
      const data = bytes.subarray(0, length);
      return { hash: hashBytes(data), executable: Boolean(stat.mode & 0o111n),
        ...(content && { data, mode: Number(stat.mode & 0o777n) }) };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return { unsafe: true };
    throw error;
  }
}

module.exports = { validPath, checkedPath, readFileState, directoryIdentity, hashBytes, samePath, excludedDirectory, MAX_FILE, MAX_BATCH_BYTES, MAX_ENTRIES };
