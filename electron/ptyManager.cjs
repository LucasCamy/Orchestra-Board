const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// Un PTY par nœud de la map, indexé par l'id du nœud.
// Il continue de tourner quand on change de tableau ; ses dernières sorties sont gardées
// pour les réafficher quand la case revient à l'écran.
const terminals = new Map(); // id -> { term, buffer }
const MAX_BUFFER = 256 * 1024; // caractères
const terminalSnapshot = ({ buffer, offset, cols, rows }) => ({ buffer, offset, cols, rows });

// Shell choisi dans les paramètres (Général).
function resolveShell(name) {
  const win = process.platform === 'win32';
  switch (name) {
    case 'powershell': return 'powershell.exe';
    case 'pwsh': return win ? 'pwsh.exe' : 'pwsh';
    case 'cmd': return 'cmd.exe';
    case 'bash': {
      // Sous Windows on préfère Git Bash : « bash.exe » tout court lance souvent WSL.
      const gitBash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
      if (win) return fs.existsSync(gitBash) ? gitBash : 'bash.exe';
      return '/bin/bash';
    }
    default:
      return win ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  }
}

// Le dossier vient de l'interface : on vérifie qu'il existe, sinon dossier personnel.
function safeCwd(cwd) {
  try {
    if (typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return os.homedir();
}

// A dedicated command shell exits with the CLI. Its input never falls back to a shell prompt.
function commandArgs(shell, command) {
  if (/cmd\.exe$/i.test(shell)) return `/d /s /c "${command}"`;
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) {
    return ['-NoLogo', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
  }
  return ['-lc', command];
}

// command et shell viennent des paramètres, lus côté Node (jamais envoyés par l'interface).
// Renvoie { buffer } : vide pour un nouveau terminal, les dernières sorties s'il tournait déjà.
// env : variables ajoutées à celles de l'app (adresse d'Orchestra pour les hooks de Codex).
function create({ id, command, shell, cwd, env, cols = 100, rows = 30, exitOnCommand = false }, onData, onExit) {
  // Déjà lancé (case d'un tableau qu'on rouvre, ou React StrictMode qui monte deux fois).
  if (terminals.has(id)) return { buffer: terminals.get(id).buffer };

  const executable = resolveShell(shell);
  const args = exitOnCommand && command ? commandArgs(executable, command) : [];
  const term = pty.spawn(executable, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: safeCwd(cwd),
    env: env ? { ...process.env, ...env } : process.env,
  });

  const entry = { term, buffer: '', offset: 0, cols, rows };
  term.onData((data) => {
    if (terminals.get(id) !== entry) return;
    entry.buffer = (entry.buffer + data).slice(-MAX_BUFFER);
    entry.offset += data.length;
    onData(id, data, entry.offset);
  });
  term.onExit(({ exitCode }) => {
    // Terminal tué puis relancé sous le même id (changement de branche) : la fin de l'ancien ne compte pas.
    if (terminals.get(id) !== entry) return;
    terminals.delete(id);
    onExit(id, exitCode, terminalSnapshot(entry));
  });

  terminals.set(id, entry);

  // On démarre un shell puis on tape la commande de l'agent :
  // le PATH de l'utilisateur est chargé et le terminal reste ouvert si l'agent quitte.
  if (command && !exitOnCommand) {
    entry.start = setTimeout(() => {
      if (terminals.get(id) === entry) term.write(command + '\r');
    }, 300);
  }
  return { buffer: '' };
}

function write(id, data) {
  terminals.get(id)?.term.write(data);
}

// Dernières sorties d'un terminal lancé, ou null (outil read_terminal d'un lien Terminal).
const buffer = (id) => terminals.get(id)?.buffer ?? null;

function snapshot(id) {
  const entry = terminals.get(id);
  return entry ? terminalSnapshot(entry) : null;
}

function resize(id, cols, rows) {
  const entry = terminals.get(id);
  if (!entry || !(cols > 0 && rows > 0)) return;
  entry.term.resize(cols, rows);
  entry.cols = cols;
  entry.rows = rows;
}

function kill(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  terminals.delete(id);
  clearTimeout(entry.start);
  entry.term.kill();
}

function killAll() {
  for (const id of [...terminals.keys()]) kill(id);
}

module.exports = { create, write, buffer, snapshot, resize, kill, killAll, ids: () => [...terminals.keys()] };
