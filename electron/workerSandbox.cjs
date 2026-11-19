const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { hookUrl, toolUrl } = require('./hookServer.cjs');
const claudeHooks = require('./claudeHooks.cjs');
const codexProfile = require('./codexProfile.cjs');
const antigravityHooks = require('./antigravityHooks.cjs');

const DEFAULT_IMAGE = 'orchestra-enterprise-worker:local';
const CONFIG = '/orchestra/config';
const HOME = '/orchestra/home';
const PROJECT = '/workspace';
const SOURCE = '/orchestra/source';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const context = ['--context', 'desktop-linux'];
const desktopUrl = (url) => url.replace('127.0.0.1', 'host.docker.internal');
const scope = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

function exec(executable, args, { input, cwd, timeout = 30000, maxBuffer = 32 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { windowsHide: true, timeout, maxBuffer, cwd, env, encoding: 'buffer' },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        error.stdout = stdout;
        reject(error);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function contains(parent, directory) {
  const relative = path.relative(parent, directory);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function bind(source, target) {
  // Docker parses --mount as CSV, so reject metacharacters in local source paths.
  if (/[,"\r\n]/.test(source)) throw new Error('workerSandbox.path');
  return `type=bind,source=${source},target=${target},readonly,bind-recursive=disabled`;
}

function containerArgs({ name, workVolume, homeVolume, source, rules, config, image, credential }) {
  return [
    ...context, 'run', '--rm', '--interactive', '--tty', '--init', '--pull', 'never', '--name', name,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
    '--mount', bind(source, SOURCE),
    '--mount', bind(rules, PROJECT + '/AGENTS.md'),
    '--mount', bind(config, CONFIG),
    '--mount', `type=volume,source=${workVolume},target=${PROJECT},volume-nocopy`,
    '--mount', `type=volume,${homeVolume ? 'source=' + homeVolume + ',' : ''}target=${HOME},volume-nocopy`,
    '--env', `HOME=${HOME}`, '--env', `CODEX_HOME=${HOME}/.codex`,
    '--env', `CLAUDE_CONFIG_DIR=${HOME}/.claude`, '--env', 'ORCHESTRA_HOOK_URL', '--env', 'ORCHESTRA_URL',
    '--env', 'ORCHESTRA_AGENT_COMMAND', '--env', 'ORCHESTRA_CHILD',
    ...(credential ? ['--env', credential] : []),
    '--workdir', PROJECT, '--entrypoint', '/bin/sh', image, CONFIG + '/worker-start.sh',
  ];
}

function writeConfig(directory, id, agent, model, servers) {
  const file = (name) => path.join(directory, name);
  const json = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 });
  const command = agent.command;
  const env = {
    ORCHESTRA_URL: desktopUrl(toolUrl(id)),
    ORCHESTRA_HOOK_URL: desktopUrl(codexProfile.env(id).ORCHESTRA_HOOK_URL),
    ORCHESTRA_CHILD: id.startsWith('subagent-') ? '1' : '0',
  };
  const mcp = { command: 'node', args: [CONFIG + '/mcpServer.cjs'], env: { ORCHESTRA_URL: env.ORCHESTRA_URL } };
  fs.copyFileSync(claudeHooks.mcpServerPath(), file('mcpServer.cjs'));
  const script = fs.readFileSync(path.join(__dirname, 'worker-start.sh'), 'utf8');
  fs.writeFileSync(file('worker-start.sh'), script.replace(/\r\n/g, '\n'), { mode: 0o600 });
  const modelArg = model ? ` --model ${model}` : '';
  switch (agent.hooks) {
    case 'claude':
      json('claude.json', claudeHooks.settingsFor(desktopUrl(hookUrl(id))));
      json('mcp.json', { mcpServers: { ...servers, orchestra: { ...mcp, type: 'stdio' } } });
      env.ORCHESTRA_AGENT_COMMAND = `${command}${modelArg} --settings ${CONFIG}/claude.json --mcp-config ${CONFIG}/mcp.json`;
      break;
    case 'codex': {
      const config = codexProfile.workerConfig(servers, CONFIG + '/mcpServer.cjs');
      json('hooks.json', { hooks: config.hooks });
      fs.writeFileSync(file('orchestra.config.toml'), config.profile, { mode: 0o600 });
      env.ORCHESTRA_AGENT_COMMAND = `${command} -p orchestra --sandbox danger-full-access${model ? ` -m ${model}` : ''}`;
      break;
    }
    case 'antigravity':
      fs.mkdirSync(file('.agents'));
      json('.agents/hooks.json', antigravityHooks.settingsFor(desktopUrl(hookUrl(id)), 'curl'));
      json('.agents/mcp_config.json', antigravityHooks.mcpConfigFor(servers, mcp));
      env.ORCHESTRA_AGENT_COMMAND = `${command}${modelArg} --add-dir ${CONFIG}`;
      break;
    default:
      env.ORCHESTRA_AGENT_COMMAND = command ?? '';
  }
  return env;
}

function createWorkerSandbox(profile) {
  const runtime = path.join(profile, 'worker-sandbox');
  const mirrors = new Map();
  let sessionDirectory;
  let helperDirectory;

  function workDirectory() {
    if (!sessionDirectory) {
      fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
      sessionDirectory = fs.mkdtempSync(path.join(runtime, 'session-'));
    }
    return sessionDirectory;
  }

  function target(boardId, cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('workerSandbox.path');
    const source = fs.realpathSync.native(cwd);
    const protectedDirectories = [
      runtime, path.join(profile, 'worker-reviews'), path.join(profile, 'hooks'), path.join(profile, 'antigravity-sessions'), path.join(os.homedir(), '.gemini'),
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    ];
    if (!fs.statSync(source).isDirectory() || contains(source, os.homedir()) || contains(source, profile) ||
        protectedDirectories.some((directory) => contains(source, directory) || contains(directory, source))) {
      throw new Error('workerSandbox.path');
    }
    const id = scope(profile, boardId, source);
    return { id, source, workVolume: 'orchestra-project-' + id };
  }

  function imageName() {
    const image = process.env.ORCHESTRA_WORKER_IMAGE || DEFAULT_IMAGE;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}$/.test(image)) throw new Error('workerSandbox.image');
    return image;
  }

  async function workerFiles(project, action, paths) {
    if (!helperDirectory) {
      const directory = fs.mkdtempSync(path.join(workDirectory(), 'review-'));
      for (const file of ['workerWorkspaceHelper.cjs', 'workerChangePaths.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
      helperDirectory = directory;
    }
    const { source, workVolume } = project;
    const writable = action === 'initialize';
    const args = [...context, 'run', '--rm', '-i', '--network', 'none', '--read-only', '--pull', 'never',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${workVolume},target=${PROJECT},volume-nocopy${writable ? '' : ',readonly'}`,
      '--mount', bind(helperDirectory, CONFIG),
      ...(action === 'initialize' ? ['--mount', bind(source, SOURCE)] : []),
      '--entrypoint', 'node', imageName(), CONFIG + '/workerWorkspaceHelper.cjs', action];
    const output = await exec(docker, args, { input: paths ? JSON.stringify(paths) : undefined, timeout: action === 'initialize' ? 180000 : 45000 });
    return JSON.parse(output.toString('utf8'));
  }

  const volumeExists = (project) => exec(docker, [...context, 'volume', 'inspect', project.workVolume]).then(() => true, (error) => {
    if (/no such volume/i.test(error.message)) return false;
    throw error;
  });

  function sync(noteId, state) {
    const mirror = mirrors.get(noteId);
    if (!mirror || mirror.revision === state?.revision) return;
    // Keep the same inode while containers have the mirror mounted.
    fs.writeFileSync(mirror.file, state?.text ?? '', { mode: 0o600 });
    mirror.revision = state?.revision;
  }

  function prepare({ id, cwd, boardId, noteId, state, agent, model, servers }) {
    if (!state || state.error) throw new Error('workerSandbox.rules');
    const image = imageName();
    const { source, workVolume } = target(boardId, cwd);
    const directory = workDirectory();
    if (!mirrors.has(noteId)) {
      const rulesDirectory = fs.mkdtempSync(path.join(directory, 'rules-'));
      mirrors.set(noteId, { file: path.join(rulesDirectory, 'AGENTS.md') });
    }
    sync(noteId, state);
    const name = 'orchestra-worker-' + randomUUID();
    const config = fs.mkdtempSync(path.join(directory, 'card-'));
    try {
      const env = writeConfig(config, id, agent, model, servers);
      const homeVolume = id.startsWith('subagent-') ? undefined : 'orchestra-home-' + scope(profile, id, agent.id);
      const credentials = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', antigravity: 'GEMINI_API_KEY' };
      const args = containerArgs({
        name, workVolume, homeVolume, source, rules: mirrors.get(noteId).file, config, image, credential: credentials[agent.hooks],
      });
      return {
        executable: docker, args, env, workVolume,
        close: () => {
          const stop = spawn(docker, [...context, 'rm', '-fv', name], { windowsHide: true, stdio: 'ignore' });
          const cleanup = () => {
            try { fs.rmSync(config, { recursive: true, force: true }); }
            catch (error) { console.warn('Worker sandbox cleanup failed:', error.code); }
          };
          stop.once('error', cleanup);
          stop.once('exit', cleanup);
        },
      };
    } catch (error) {
      fs.rmSync(config, { recursive: true, force: true });
      throw error;
    }
  }

  function dispose() {
    if (!sessionDirectory) return;
    try { fs.rmSync(sessionDirectory, { recursive: true, force: true }); }
    catch (error) { console.warn('Worker sandbox cleanup failed:', error.code); }
    sessionDirectory = undefined;
    helperDirectory = undefined;
    mirrors.clear();
  }

  return { prepare, sync, dispose, target, workerFiles, volumeExists };
}

module.exports = { createWorkerSandbox, containerArgs, exec };
