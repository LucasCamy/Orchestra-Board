const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require('electron');
const ptyManager = require('./ptyManager.cjs');
const fsHandlers = require('./fsHandlers.cjs');
const settingsStore = require('./settingsStore.cjs');
const agentsHandlers = require('./agentsHandlers.cjs');
const workspaceStore = require('./workspaceStore.cjs');
const hookServer = require('./hookServer.cjs');
const claudeHooks = require('./claudeHooks.cjs');
const antigravityHooks = require('./antigravityHooks.cjs');
const claudeTrust = require('./claudeTrust.cjs');
const codexProfile = require('./codexProfile.cjs');
const { createMcpCatalog, validId } = require('./mcpCatalog.cjs');
const agentStatus = require('./agentStatus.cjs');
const gitHandlers = require('./git.cjs');
const linkRelay = require('./linkRelay.cjs');
const delegation = require('./delegation.cjs');
const { createSubagents, isSubagent, isTool: isSubagentTool } = require('./subagents.cjs');
const terminalLink = require('./terminalLink.cjs');
const noteLink = require('./noteLink.cjs');
const visualTests = require('./visualTestRunner.cjs');
const visualTestLink = require('./visualTestLink.cjs');
const { createNoteFiles, registerNoteFiles } = require('./noteFiles.cjs');
const { createWorkerSandbox } = require('./workerSandbox.cjs');
const { createWorkerChanges } = require('./workerChanges.cjs');
const activityLog = require('./activityLog.cjs');
const diagnostics = require('./diagnostics.cjs');
const tasksHandlers = require('./tasksHandlers.cjs');
let taskService;
const updates = require('./updates.cjs');
const usage = require('./usage.cjs');
const { t } = require('./i18n.cjs');
const { canResume, sanitizeSession } = require('./sessionState.cjs');
const teamTemplates = require('./teamTemplates.cjs');
const { createBlockers } = require('./blockers.cjs');
const { createRoleState } = require('./roleState.cjs');
const { createTaskSequences } = require('./taskSequences.cjs');

let win;
let quitConfirmed = false;
let taskSequences;
let sequenceNodes = [];
const mcpCatalog = () => createMcpCatalog(app.getPath('userData'));
const isBoardFrame = (event) => win && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame;

ipcMain.handle('mcp:get', (event, boardId, cardId) => isBoardFrame(event) ? mcpCatalog().get(boardId, cardId) : null);
ipcMain.handle('mcp:save', (event, boardId, cardId, change) => {
  if (!isBoardFrame(event)) return { error: 'invalidScope' };
  try {
    return { config: mcpCatalog().save(boardId, cardId, change) };
  } catch (err) {
    return { error: err.code ? 'saveFailed' : err.message };
  }
});

function sequenceAgents() {
  const agents = settingsStore.load().agents;
  return sequenceNodes.flatMap(({ node, boardName }) => {
    const agent = agents.find((entry) => entry.id === node.data.agentId);
    if (!['claude', 'codex'].includes(agent?.hooks)) return [];
    const info = agentStatus.info(node.id);
    return [{ id: node.id, name: node.data.label || agent.name, boardName, status: info?.status || 'offline', ready: info?.ready === true }];
  });
}
const blockers = createBlockers((entries) => send('blockers:change', entries));
const roleState = createRoleState({ emit: (id, state) => send('roles:change', id, state), running: (id) => Boolean(agentStatus.info(id)) });

// Couleurs de la zone des boutons Windows (réduire, agrandir, fermer) = fond et texte de la barre du haut.
const TITLE_BAR_HEIGHT = 40;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Le projet s'appelait « agent-board » : on reprend une fois ses paramètres, agents et tableaux.
// Une seule fois (fichier témoin) : sans settings.json plus tard (fichier supprimé ou renommé), Orchestra
// repart à neuf au lieu de réimporter les anciennes données.
function migrateOldUserData() {
  const current = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'agent-board');
  const marker = path.join(current, 'agent-board-imported');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(current, { recursive: true });
  if (!fs.existsSync(path.join(current, 'settings.json')) && fs.existsSync(old)) {
    for (const name of ['settings.json', 'workspace.json', 'logos']) {
      const from = path.join(old, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(current, name), { recursive: true });
    }
  }
  fs.writeFileSync(marker, '');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Orchestra',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'), // barre des tâches (généré par npm run build:icon)
    backgroundColor: '#262624', // = fond de l'écran de démarrage (splash.css) : aucun flash au lancement
    show: false, // affichée quand la page est prête, pour ne jamais montrer une fenêtre vide
    // Une seule barre en haut : celle de l'app, avec les boutons Windows dessinés par-dessus à droite.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#262624', symbolColor: '#ece9e2', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform === 'win32') {
    const launcher = path.join(__dirname, '..', 'launcher.exe');
    const development = fs.existsSync(launcher);
    // Identité de la fenêtre et du raccourci épinglé, y compris depuis le lanceur de développement.
    win.setAppDetails({
      appId: 'com.orchestraboard.orchestra',
      appIconPath: development ? path.join(__dirname, '..', 'build', 'icon.ico') : process.execPath,
      appIconIndex: 0,
      relaunchCommand: `"${development ? launcher : process.execPath}"`,
      relaunchDisplayName: 'Orchestra',
    });
  }

  // L'interface ne s'ouvre jamais ailleurs : pas de nouvelle fenêtre, pas de navigation hors de l'app
  // (un lien externe passe par shell.openExternal côté Node).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  // Avec titleBarOverlay, ready-to-show n'arrive pas toujours (fenêtre jamais affichée) : on montre aussi la
  // fenêtre quand la page est chargée. Pas de flash : son fond est déjà celui de l'écran de démarrage.
  const showOnce = () => !win.isDestroyed() && !win.isVisible() && win.show();
  win.once('ready-to-show', showOnce);
  win.webContents.once('did-finish-load', showOnce);
  win.on('close', confirmQuit);

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    // Sans menu, plus de raccourci pour les outils de développement : F12 en mode dev.
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// Fermer la fenêtre pendant qu'un agent travaille (ou attend une permission) : l'interface demande d'abord
// (app:confirmQuit avec la liste des agents), puis répond par app:quit.
function confirmQuit(event) {
  if (quitConfirmed || !settingsStore.load().general.confirmClose) return;
  const agents = [...agentStatus.busy(), ...subagents.busy()];
  if (!agents.length) return;
  event.preventDefault();
  send('app:confirmQuit', agents);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Statut envoyé à la case (pty:status:<id>) et à l'app entière (agent:status), qui gère le son et les
// onglets, y compris pour les cases des tableaux fermés.
function sendStatus(id, info) {
  blockers.onStatus(id, info);
  send(`pty:status:${id}`, info);
  send('agent:status', id, info);
  relayStatus(id, info);
}

// Liens entre agents : une case libérée reçoit la suite de sa file, une case fermée n'est plus attendue.
function relayStatus(id, info) {
  taskSequences?.onStatus(id, info);
  linkRelay.onStatus(id, info);
  delegation.onStatus(id, info);
  if (!info) { try { taskService?.onExit(id); } catch (error) { console.error('Task save failed:', error.message); } }
  send('sequences:agents', sequenceAgents());
}

// Fenêtre pas au premier plan : notification Windows. Un clic ramène l'app et centre la map sur la case.
function notifyFinished(id, info) {
  if (!settingsStore.load().general.notifyDesktop || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused()) return;
  const notification = new Notification({
    title: t('notify.finished', { name: info.name }),
    body: info.cwd ? path.basename(info.cwd) || info.cwd : '',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('agent:focus', id);
  });
  notification.show();
}

agentStatus.init(sendStatus, notifyFinished, (id, reply) => {
  if (reply) linkRelay.onStop(id, { last_assistant_message: reply }, { fallback: true });
});
// Tableau de chaque case (filtres du journal), mis à jour à chaque sauvegarde de workspace.json.
let caseBoards = new Map();
const caseName = (id) => agentStatus.info(id)?.name || noteLink.nameOf(id) || id;
activityLog.init({
  nameOf: caseName,
  boardOf: (id) => caseBoards.get(id) ?? null,
  emit: (entry) => send('log:entry', entry),
  report: (entry) => {
    blockers.onLog(entry);
    try { taskService?.onLog(entry); } catch (error) { console.error('Task save failed:', error.message); }
  },
});

function emitLink(linkId, event) {
  blockers.onLink(linkId, event);
  send('link:event', linkId, event);
}

linkRelay.init({
  beforeDeliver: (taskId) => taskService?.beforeDeliver(taskId),
  deferred: (taskId) => taskService?.deferred(taskId),
  log: activityLog.add,
  nameOf: caseName,
  pending: (list) => send('relay:pending', list),
  write: ptyManager.write,
  status: (id) => agentStatus.info(id)?.status ?? null,
  ready: (id) => agentStatus.info(id)?.ready ?? false,
  arm: agentStatus.arm,
  emit: emitLink,
});

delegation.init({
  log: activityLog.add,
  info: agentStatus.info,
  agent: (agentId) => settingsStore.load().agents.find((a) => a.id === agentId) ?? { name: t('agent.missing'), hooks: null },
  emit: emitLink,
});

terminalLink.init({
  log: activityLog.add,
  write: ptyManager.write,
  buffer: ptyManager.buffer,
  info: agentStatus.info,
  arm: agentStatus.arm,
  emit: emitLink,
});

const workerSandbox = createWorkerSandbox(app.getPath('userData'));
const workerChanges = createWorkerChanges(app.getPath('userData'), workerSandbox);
const noteFiles = createNoteFiles(app.getPath('userData'), (id, state) => {
  send('note:file:change', id, state);
  try { workerSandbox.sync(id, state); }
  catch (error) { console.error('Worker rules synchronization failed:', error.code); }
});
function canWriteBigBrain(caller, noteId) {
  const binding = noteFiles.bigBrain(caseBoards.get(caller));
  return binding?.architectId === caller && binding.noteId === noteId &&
    caseAgents.get(caller) === 'antigravity' && agentStatus.kind(caller) === 'antigravity';
}

noteLink.init({
  log: activityLog.add,
  write: (id, text) => send('note:write', id, text),
  file: noteFiles.getFresh,
  isBigBrain: noteFiles.isBigBrain,
  canWriteBigBrain,
  writeBigBrain: noteFiles.writeBigBrain,
  emit: emitLink,
});

// Outils du serveur MCP d'une case : liens Note, Test visuel, Terminal et Délégation.
function callTool(caller, name, args, signal) {
  if (isSubagentTool(name)) return subagents.callTool(caller, name, args, signal);
  if (isSubagent(caller)) return { text: t('delegate.callerNotRunning'), isError: true };
  if (noteLink.isTool(name)) return noteLink.callTool(caller, name, args);
  if (visualTestLink.isTool(name)) {
    if (!agentStatus.info(caller)) return { text: t('delegate.callerNotRunning'), isError: true };
    return visualTestLink.callTool(workspaceStore.get(), caller, name, args, visualTests.isRunning);
  }
  if (!terminalLink.isTool(name)) return delegation.callTool(caller, name, args, signal);
  if (!agentStatus.info(caller)) return { text: t('delegate.callerNotRunning'), isError: true };
  return terminalLink.callTool(caller, name, args, signal);
}

const caseAgents = new Map(); // agent lancé dans chaque case ; seuls ses hooks peuvent définir la session
const caseModels = new Map();
const sandboxCases = new Set();
const startingCards = new Map();
const configuredAgent = (id) => settingsStore.load().agents.find((agent) => agent.id === id);
function prepareWorker({ id, boardId, owner, cwd, agent, model, servers, cancelled }) {
  const binding = noteFiles.bigBrain(boardId);
  const board = workspaceStore.get().boards.find((entry) => entry.id === boardId);
  if (!binding) {
    if (board?.nodes.some((node) => node.type === 'note' && node.data.readOnlyForWorkers)) throw new Error('workerSandbox.rules');
    return null;
  }
  if (!owner && binding.architectId === id && agent.id === 'antigravity' && agent.hooks === 'antigravity') return null;
  if (noteFiles.readBigBrain(boardId)?.error) throw new Error('workerSandbox.rules');
  return workerChanges.initialize(workerSandbox.target(boardId, cwd)).then(() => {
    if (cancelled()) return null;
    return workerSandbox.prepare({
      id, cwd, boardId, noteId: binding.noteId, state: noteFiles.readBigBrain(boardId), agent,
      model: settingsStore.MODEL.test(model ?? '') ? model : null, servers,
    });
  });
}

function reviewTargets(boardId) {
  const binding = noteFiles.bigBrain(boardId);
  const board = workspaceStore.get().boards.find((entry) => entry.id === boardId);
  if (!binding || !board) return [];
  const folders = new Set([path.dirname(binding.file)]);
  for (const { type, data } of board.nodes) {
    if (type === 'terminal' && (data.worktree || data.cwd)) folders.add(data.worktree || data.cwd);
  }
  const targets = new Map();
  for (const folder of folders) {
    try {
      const project = workerSandbox.target(boardId, folder);
      targets.set(project.id, project);
    } catch { /* Invalid host folders cannot be destinations. */ }
  }
  return [...targets.values()];
}

const resolveReviewTarget = (boardId, targetId) => {
  if (workspaceStore.get().activeBoardId !== boardId) throw Object.assign(Error(), { reviewKey: 'workerChanges.scope' });
  const target = reviewTargets(boardId).find(({ id }) => id === targetId);
  if (!target) throw Object.assign(Error(), { reviewKey: 'workerChanges.scope' });
  return target;
};

ipcMain.handle('workerChanges:targets', (event, boardId) => {
  if (!isBoardFrame(event) || workspaceStore.get().activeBoardId !== boardId) return { error: t('workerChanges.scope') };
  return { targets: reviewTargets(boardId).map(({ id, source }) => ({ id, source })) };
});
for (const action of ['review', 'diff', 'apply', 'undoStatus', 'undo', 'redo', 'previewReplay', 'updateReplayPreview', 'refreshReplayPreview',
  'updateReplayHunks', 'updateReplayLines', 'replayDiff', 'replayConflicts', 'resolveReplayConflict', 'resolveReplayConflictBatch',
  'replayInline', 'updateReplayInline', 'updateReplayInlineBatch', 'confirmReplay']) {
  ipcMain.handle('workerChanges:' + action, async (event, boardId, targetId, snapshot, selection) => {
    if (!isBoardFrame(event)) return { error: t('workerChanges.scope') };
    try {
      const project = resolveReviewTarget(boardId, targetId);
      if (['apply', 'refreshReplayPreview', 'resolveReplayConflict', 'resolveReplayConflictBatch'].includes(action)) {
        return await workerChanges[action](project, snapshot, selection, () => resolveReviewTarget(boardId, targetId));
      }
      const result = await workerChanges[action](project, snapshot, selection);
      if (['replayDiff', 'replayInline', 'replayConflicts'].includes(action)) resolveReviewTarget(boardId, targetId);
      return result;
    } catch (error) {
      const fallback = {
        undo: 'workerChanges.undoFailed', redo: 'workerChanges.redoFailed', undoStatus: 'workerChanges.historyFailed',
        previewReplay: 'workerChanges.historyPreviewFailed', updateReplayPreview: 'workerChanges.historyPreviewFailed',
        refreshReplayPreview: 'workerChanges.historyPreviewFailed',
        updateReplayHunks: 'workerChanges.historyPreviewFailed',
        updateReplayLines: 'workerChanges.historyPreviewFailed',
        updateReplayInline: 'workerChanges.historyPreviewFailed',
        updateReplayInlineBatch: 'workerChanges.historyPreviewFailed',
        confirmReplay: 'workerChanges.historyReplayFailed',
        replayDiff: 'workerChanges.historyDiffFailed',
        replayConflicts: 'workerChanges.historyConflictUnavailable',
        resolveReplayConflict: 'workerChanges.historyPreviewFailed',
        resolveReplayConflictBatch: 'workerChanges.historyPreviewFailed',
        replayInline: 'workerChanges.historyDiffFailed',
      }[action] ?? 'workerChanges.failed';
      return { error: t(error.reviewKey ?? fallback), ...(error.file && { file: error.file }),
        ...(error.reviewKey === 'workerChanges.historyPreviewStale' && { stale: true }) };
    }
  });
}

function stopSubagent(id) {
  try { ptyManager.kill(id); }
  catch (error) { console.warn('Subagent terminal cleanup failed:', error.code); }
  removeSubagentSettings(id);
}

function removeSubagentSettings(id) {
  if (sandboxCases.delete(id)) hookServer.invalidate(id);
  try { claudeHooks.removeSettings(id); }
  catch (error) { console.warn('Subagent hook cleanup failed:', error.code); }
  antigravityHooks.remove(id);
}

const subagents = createSubagents({
  parent: (id) => {
    const agentId = caseAgents.get(id);
    const info = agentStatus.info(id);
    return agentId && info && { agentId, agent: configuredAgent(agentId), cwd: info.cwd, model: caseModels.get(id) };
  },
  agent: configuredAgent,
  launch: async ({ id, cwd, parentId }, agent, model) => {
    const settings = settingsStore.load();
    const shell = settings.general.shell;
    const cancelled = () => !subagents.canLaunch(id);
    const preparation = prepareWorker({ id, cwd, boardId: caseBoards.get(parentId), owner: parentId, agent, model, servers: {}, cancelled });
    const sandbox = preparation ? await preparation : null;
    if (cancelled()) { sandbox?.close(); return; }
    const antigravityLaunch = !sandbox && agent.hooks === 'antigravity' ? antigravityHooks.prepare(id, {}, shell) : null;
    const command = sandbox ? null : buildCommand(id, agent, false, model, {}, antigravityLaunch);
    if (!sandbox && agent.hooks === 'claude' && settings.general.trustFolders) claudeTrust.trustFolder(cwd);
    if (sandbox) sandboxCases.add(id);
    ptyManager.create({
      id, cwd, shell, command, sandbox, exitOnCommand: true,
      env: antigravityLaunch?.env ?? (agent.hooks === 'codex' ? codexProfile.env(id) : null),
    }, (id, data, offset) => {
      send(`pty:data:${id}`, data, offset);
      subagents.onOutput(id, data);
    }, (id, _code, output) => {
      removeSubagentSettings(id);
      subagents.onExit(id, output);
    });
  },
  stop: stopSubagent,
  write: ptyManager.write,
  snapshot: ptyManager.snapshot,
  emit: (id, children) => send(`subagents:change:${id}`, children),
  lastReply: linkRelay.lastReply,
  readDelay: linkRelay.READ_DELAY,
  t,
});

ipcMain.handle('subagents:list', (event, parentId) => isBoardFrame(event) ? subagents.list(parentId) : []);
ipcMain.handle('subagents:close', (event, parentId, id) => Boolean(isBoardFrame(event) && subagents.close(parentId, id)));
ipcMain.handle('pty:snapshot', (event, id) => {
  if (!isBoardFrame(event)) return null;
  return isSubagent(id) ? subagents.snapshot(id) : ptyManager.snapshot(id);
});

function trackSession(id, payload) {
  const agentId = caseAgents.get(id);
  const info = agentStatus.info(id);
  if (!agentId || !info) return;
  const session = sanitizeSession({ id: payload.session_id, transcriptPath: payload.transcript_path, cwd: info.cwd, agentId });
  if (session) workspaceStore.setSession(id, session);
  else if (payload.hook_event_name === 'SessionStart' && ['startup', 'clear'].includes(payload.source)) workspaceStore.setSession(id, null);
}

function bigBrainContext(id, ownerId = id) {
  const boardId = caseBoards.get(ownerId);
  const state = noteFiles.readBigBrain(boardId);
  if (!state) return {};
  if (state.error) return { reason: t('team.bigBrainBlocked') };
  const { noteId } = noteFiles.bigBrain(boardId);
  try { workerSandbox.sync(noteId, state); }
  catch { return { reason: t('team.bigBrainBlocked') }; }
  const canWrite = canWriteBigBrain(id, noteId);
  return { context: t('team.bigBrainContext', {
    access: t(canWrite ? 'team.bigBrainWrite' : 'team.bigBrainReadOnly'),
    document: state.text,
  }) };
}

function hookContext(event, antigravity, context, reason) {
  if (reason) {
    return antigravity ? { terminationBehavior: 'terminate', injectSteps: [{ errorMessage: { userMessage: reason } }] }
      : { decision: 'block', reason };
  }
  if (!context) return {};
  return antigravity ? { injectSteps: [{ systemMessage: { systemMessage: context } }] }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

// Événements des hooks de Claude Code et Codex : statut de la case, et transmission par ses liens quand il a
// fini (Transmission automatique, ou réponse attendue par un agent qui lui a délégué un message).
// Début de session : la réponse au hook dit à l'agent qu'il tourne dans Orchestra et lui donne son rôle
// (même format pour Claude Code et Codex). Ce contexte n'est pas affiché dans le terminal.
function onHook(id, payload) {
  // A sandbox hook can report session output, but cannot name a host file for Orchestra to read.
  if (sandboxCases.has(id)) payload = { ...payload, transcript_path: null, transcriptPath: null };
  if (isSubagent(id)) {
    const isAntigravity = subagents.kind(id) === 'antigravity';
    const hook = isAntigravity ? antigravityHooks.normalize(payload) : payload;
    if (!hook) return {};
    const event = hook.hook_event_name;
    const owner = subagents.parentId(id);
    const { context, reason } = owner && event === 'UserPromptSubmit' ? bigBrainContext(id, owner) : {};
    if (reason) subagents.blockPrompt(id, reason);
    else subagents.onHook(id, hook);
    return hookContext(event, isAntigravity, context, reason);
  }
  if (!agentStatus.info(id)) return {};
  const isAntigravity = agentStatus.kind(id) === 'antigravity';
  if (isAntigravity) {
    payload = antigravityHooks.normalize(payload);
    if (!payload) return {};
  }
  const event = payload.hook_event_name;
  const governance = event === 'UserPromptSubmit' ? bigBrainContext(id) : {};
  if (governance.reason) return hookContext(event, isAntigravity, null, governance.reason);
  const turnOwner = linkRelay.onHook(id, payload);
  taskSequences?.onHook(id, payload);
  diagnostics.onHook(id, payload.hook_event_name);
  try { if (!sandboxCases.has(id)) trackSession(id, payload); }
  catch (error) {
    console.error('Session save failed:', error.message);
    send('workspace:saveError');
  }
  // Capturer la réponse avant que le statut « done » ne puisse libérer le prochain message.
  if (payload.hook_event_name === 'Stop' && turnOwner !== 'sequence') {
    setTimeout(() => {
      try { taskService?.finishOwner(id, linkRelay.lastReply(payload)); }
      catch (error) { console.error('Task save failed:', error.message); }
    }, linkRelay.READ_DELAY);
    delegation.onStop(id, payload);
    linkRelay.onStop(id, payload);
  }
  agentStatus.onHook(id, payload);
  const parts = [];
  if (event === 'SessionStart' || (isAntigravity && event === 'UserPromptSubmit' && !roleState.get(id).known)) {
    if (!agentStatus.info(id)) return {};
    parts.push(t('orchestra.context'));
    const role = roleState.start(id);
    if (role) parts.push(t('role.context', { role }));
  }
  if (governance.context) parts.push(governance.context);
  return hookContext(event, isAntigravity, parts.join('\n\n'));
}

// Nom d'une case choisi dans l'interface (double-clic sur son titre).
const cleanName = (name) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null);

// Les agents à hooks reprennent exclusivement la session persistée de cette case.
function resumeArgs(id, agent, resume) {
  if (!resume) return '';
  const session = workspaceStore.getSession(id);
  if (session && agent.hooks === 'claude') return ` --resume ${session.id}`;
  if (session && agent.hooks === 'codex') return ` resume ${session.id}`;
  if (session && agent.hooks === 'antigravity') return ` --conversation ${session.id}`;
  return agent.hooks || !agent.resumeArgs ? '' : ` ${agent.resumeArgs}`;
}

// Commande à taper dans le shell : celle de l'agent, + profil Orchestra pour Codex, + reprise de conversation, + modèle choisi,
// + hooks et serveur MCP pour Claude Code.
function buildCommand(id, agent, resume, model, mcpServers, antigravityLaunch) {
  if (!agent.command) return null;
  let command = agent.command;
  if (agent.hooks === 'codex') command += ` -p ${codexProfile.profileFor(id, mcpServers)}`;
  command += resumeArgs(id, agent, resume);
  // Après la reprise : « codex resume » prend aussi -m.
  if (typeof model === 'string' && settingsStore.MODEL.test(model)) {
    if (agent.hooks === 'claude' || agent.hooks === 'antigravity') command += ` --model ${model}`;
    if (agent.hooks === 'codex') command += ` -m ${model}`;
  }
  if (agent.hooks === 'claude') {
    command += ` --settings "${claudeHooks.writeSettings(id)}" --mcp-config "${claudeHooks.writeMcpConfig(id, mcpServers)}"`;
  }
  if (antigravityLaunch) command += antigravityLaunch.args;
  return command;
}

// L'interface envoie seulement l'id de l'agent : la commande à lancer vient des paramètres.
// Renvoie { buffer, status } : buffer = dernières sorties si le terminal tournait déjà (case d'un
// autre tableau qu'on rouvre), status = statut actuel de la case.
ipcMain.handle('pty:create', (event, args) => {
  if (!isBoardFrame(event) || !validId(args?.id) || isSubagent(args.id)) return null;
  const { id } = args;
  if (startingCards.has(id)) return startingCards.get(id).promise;
  const attempt = {};
  startingCards.set(id, attempt);
  attempt.promise = launchCard(args, () => startingCards.get(id) !== attempt).finally(() => {
    if (startingCards.get(id) === attempt) startingCards.delete(id);
  });
  return attempt.promise;
});

async function launchCard({ id, boardId, agentId, cwd, label, cols, rows, resume, model }, cancelled) {
  const settings = settingsStore.load();
  const agent = settings.agents.find((a) => a.id === agentId);
  if (!agent) return null;

  const existing = agentStatus.info(id);
  const mcpServers = existing || !agent.hooks ? {} : mcpCatalog().resolve(caseBoards.get(id) ?? boardId, id);
  if (!existing && resume && agent.hooks && !canResume(workspaceStore.getSession(id), agentId, cwd)) {
    return { error: t('session.unavailable') };
  }
  let sandbox;
  if (!existing) {
    try {
      const preparation = prepareWorker({ id, boardId: caseBoards.get(id) ?? boardId, cwd, agent, model, servers: mcpServers, cancelled });
      sandbox = preparation ? await preparation : null;
    }
    catch (error) { return { error: t(error.message.startsWith('workerSandbox.') ? error.message : 'workerSandbox.launch') }; }
    if (cancelled()) { sandbox?.close(); return null; }
    if (sandbox) sandboxCases.add(id);
  }
  const antigravityLaunch = !sandbox && !existing && agent.hooks === 'antigravity' ? antigravityHooks.prepare(id, mcpServers, settings.general.shell) : null;
  const command = existing || sandbox ? null : buildCommand(id, agent, resume, model, mcpServers, antigravityLaunch);
  if (!existing) {
    if (!resume) workspaceStore.setSession(id, null);
    caseAgents.set(id, agentId);
    caseModels.set(id, model);
  }
  if (!sandbox && !existing && agent.hooks === 'claude' && settings.general.trustFolders) claudeTrust.trustFolder(cwd);
  if (!existing) {
    diagnostics.onLaunch(id);
    agentStatus.register(id, agent.hooks ? 'hooks' : 'activity', { name: cleanName(label) ?? agent.name, cwd, notify: Boolean(agent.command), isShell: !agent.command, kind: agent.hooks || null });
    send('agent:status', id, agentStatus.info(id)); // la barre des agents actifs le voit tout de suite
  }
  const options = {
    id,
    command,
    shell: settings.general.shell,
    cwd,
    env: antigravityLaunch?.env ?? (agent.hooks === 'codex' ? codexProfile.env(id) : null),
    cols,
    rows,
    sandbox,
  };
  const onData = (id, data, offset) => {
    agentStatus.onOutput(id, data);
    terminalLink.onOutput(id, data);
    send(`pty:data:${id}`, data, offset);
  };
  const onExit = (id, code) => {
    subagents.closeParent(id);
    agentStatus.unregister(id);
    caseAgents.delete(id);
    caseModels.delete(id);
    if (sandboxCases.delete(id)) hookServer.invalidate(id);
    diagnostics.forget(id);
    roleState.clear(id);
    blockers.onStatus(id, null);
    blockers.onExit(id, code);
    claudeHooks.removeSettings(id);
    antigravityHooks.remove(id);
    send('agent:status', id, null);
    send(`pty:exit:${id}`, code);
    relayStatus(id, null);
  };
  try {
    const result = ptyManager.create(options, onData, onExit);
    blockers.onStatus(id, agentStatus.info(id));
    return { ...result, status: agentStatus.info(id) };
  } catch (error) {
    if (!sandbox) throw error;
    if (sandboxCases.delete(id)) hookServer.invalidate(id);
    caseAgents.delete(id);
    caseModels.delete(id);
    agentStatus.unregister(id);
    diagnostics.forget(id);
    send('agent:status', id, null);
    return { error: t('workerSandbox.launch') };
  }
}
ipcMain.on('pty:write', (_e, id, data) => {
  if (typeof data !== 'string') return;
  if (isSubagent(id)) return subagents.write(id, data);
  agentStatus.onInput(id, data);
  if (!data.startsWith('\x1b') && data.includes('\r')) {
    // Consigne tapée à la main : nouvelle chaîne, compteurs de tours à zéro.
    if (linkRelay.onUserInput(id)) delegation.resetCounters(id);
  }
  ptyManager.write(id, data);
});
// Bouton Accepter / Refuser de l'encoche des permissions : la touche est envoyée dans le terminal de la case.
ipcMain.on('agent:permission', (_e, id, allow) => {
  const key = agentStatus.answerPermission(id, allow === true);
  if (key) ptyManager.write(id, key);
});
ipcMain.on('pty:resize', (_e, id, cols, rows) => ptyManager.resize(id, cols, rows));
ipcMain.on('pty:ack', (_e, id) => agentStatus.acknowledge(id)); // clic sur une case qui a fini
ipcMain.on('pty:rename', (_e, id, name) => {
  const clean = cleanName(name);
  if (!clean || !agentStatus.info(id)) return;
  agentStatus.rename(id, clean); // nom repris par la notification Windows et la barre des agents actifs
  send('agent:status', id, agentStatus.info(id));
});
ipcMain.on('pty:kill', (_e, id) => {
  if (isSubagent(id)) return;
  startingCards.delete(id);
  subagents.closeParent(id);
  ptyManager.kill(id);
  agentStatus.unregister(id);
  caseAgents.delete(id);
  caseModels.delete(id);
  if (sandboxCases.delete(id)) hookServer.invalidate(id);
  diagnostics.forget(id);
  roleState.clear(id);
  blockers.onStatus(id, null);
  claudeHooks.removeSettings(id);
  antigravityHooks.remove(id);
  send('agent:status', id, null);
  relayStatus(id, null);
});

ipcMain.handle('roles:get', (_e, id) => roleState.get(id));
ipcMain.handle('roles:set', (_e, id, role) => {
  if (typeof role !== 'string' || role.length > 2000 || typeof id !== 'string' ||
      !(caseAgents.has(id) || workspaceStore.get().boards.some((board) => board.nodes.some((node) => node.id === id && node.type === 'terminal')))) {
    return { error: t('role.saveFailed') };
  }
  try {
    workspaceStore.setRole(id, role);
    roleState.setSaved(id, role);
    return { value: roleState.get(id) };
  } catch { return { error: t('role.saveFailed') }; }
});
// Messages à valider ou en file (PLAN.md §7, 3.1) : l'interface n'envoie qu'un identifiant et le texte modifié.
const QID = /^[0-9a-f-]{36}$/;
ipcMain.handle('relay:pending', () => linkRelay.pendingList());
ipcMain.handle('relay:approve', (_e, qid, text) => (QID.test(qid) ? linkRelay.approve(qid, text) : { error: t('pending.notFound') }));
ipcMain.handle('relay:discard', (_e, qid) => (QID.test(qid) ? linkRelay.discard(qid) : { error: t('pending.notFound') }));
ipcMain.handle('relay:cancel', (_e, qid) => (QID.test(qid) ? linkRelay.cancel(qid) : { error: t('pending.notFound') }));
// Diagnostic (Paramètres › Diagnostic) : commandes et versions, puis cases lancées et leur dernier hook.
ipcMain.handle('diag:agents', () => diagnostics.checkAgents(settingsStore.load().agents, agentsHandlers.testCommand));
ipcMain.handle('diag:tiles', () => {
  const { agents } = settingsStore.load();
  return diagnostics.tileStates(
    workspaceStore.get().boards.flatMap((board) =>
      board.nodes
        .filter((n) => n.type === 'terminal' && agentStatus.info(n.id))
        .map((n) => ({ id: n.id, agentId: n.data.agentId, name: agentStatus.info(n.id).name, hooks: agents.find((a) => a.id === n.data.agentId)?.hooks ?? null, boardName: board.name })),
    ),
  );
});
ipcMain.handle('blockers:get', () => blockers.snapshot());
ipcMain.handle('blockers:clearResolved', () => { blockers.clearResolved(); return blockers.snapshot(); });

// Réponse à app:confirmQuit : « Quitter quand même ».
// Section « À propos » des paramètres : version de l'app et liens du projet. L'interface envoie un nom de
// lien, jamais une adresse : seules ces pages peuvent s'ouvrir dans le navigateur.
const ABOUT_LINKS = {
  author: 'https://github.com/Adoraay',
  repo: 'https://github.com/Adoraay/Orchestra-Board',
  issues: 'https://github.com/Adoraay/Orchestra-Board/issues/new/choose',
};
ipcMain.handle('about:info', () => ({ version: app.getVersion() }));
ipcMain.handle('visualTest:start', (event, id, data) => isBoardFrame(event)
  ? visualTests.start(id, data, (nodeId, result) => send('visualTest:finished', nodeId, result))
  : { error: 'unavailable' });
ipcMain.handle('visualTest:isRunning', (event, id) => Boolean(isBoardFrame(event) && visualTests.isRunning(id)));
ipcMain.on('visualTest:cancel', (event, id) => { if (isBoardFrame(event)) visualTests.cancel(id); });
ipcMain.on('about:open', (_e, key) => {
  if (Object.hasOwn(ABOUT_LINKS, key)) shell.openExternal(ABOUT_LINKS[key]);
});

ipcMain.on('app:quit', () => {
  if (!win || win.isDestroyed()) return;
  quitConfirmed = true;
  win.close();
});
// Thème changé : la zone des boutons Windows reprend les couleurs de la barre du haut.
ipcMain.on('window:titleBarColors', (_e, color, symbolColor) => {
  if (!win || win.isDestroyed() || !HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return;
  win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
});

// Dossiers des cases de la map (tous tableaux) : l'explorateur refuse de les renommer ou supprimer.
let usedFolders = [];
fsHandlers.register(() => win, {
  usedFolders: () => usedFolders,
  root: () => settingsStore.load().general.rootPath ?? os.homedir(),
});
settingsStore.register();
agentsHandlers.register(() => win);
workspaceStore.register((workspace) => {
  sequenceNodes = workspace.boards.flatMap((board) => board.nodes.filter((node) => node.type === 'terminal').map((node) => ({ node, boardName: board.name })));
  send('sequences:agents', sequenceAgents());
  caseBoards = new Map(workspace.boards.flatMap((b) => b.nodes.map((n) => [n.id, b.id])));
  usedFolders = workspace.boards.flatMap((b) =>
    b.nodes
      .filter((n) => n.type === 'terminal')
      .flatMap((n) => [n.data.cwd, n.data.worktree].filter(Boolean).map((p) => ({ path: p, name: n.data.label || n.data.agentId }))),
  );
  linkRelay.setLinks(workspace);
  delegation.setWorkspace(workspace);
  blockers.setWorkspace(workspace);
  roleState.setWorkspace(workspace);
  terminalLink.setWorkspace(workspace, (agentId) => settingsStore.load().agents.find((a) => a.id === agentId)?.name ?? agentId);
  noteLink.setWorkspace(workspace);
  noteFiles.setWorkspace(workspace);
}, () => {
  startingCards.clear();
  subagents.closeAll();
  for (const id of ptyManager.ids()) {
    ptyManager.kill(id);
    agentStatus.unregister(id);
    roleState.clear(id);
    blockers.onStatus(id, null);
    claudeHooks.removeSettings(id);
    antigravityHooks.remove(id);
    relayStatus(id, null);
    send('agent:status', id, null);
  }
  for (const id of caseAgents.keys()) diagnostics.forget(id);
  caseAgents.clear();
  caseModels.clear();
  for (const id of sandboxCases) hookServer.invalidate(id);
  sandboxCases.clear();
}, (boardId, cards, preset, backlog, persist, event, bigBrain) => {
  if (!isBoardFrame(event)) throw new Error('Invalid board frame');
  const applyBigBrain = () => bigBrain ? noteFiles.applyBigBrain(boardId, bigBrain, persist) : persist();
  return mcpCatalog().applyPreset(boardId, cards, preset, () => backlog
    ? noteFiles.applyProjectBacklog(backlog.noteId, backlog.cwd, backlog.text, applyBigBrain)
    : applyBigBrain());
});
gitHandlers.register(workspaceStore.get);
taskService = tasksHandlers.register(workspaceStore.get, send, linkRelay);
teamTemplates.register(noteFiles.get, noteFiles.bigBrain);
usage.register();
updates.register(() => win);
activityLog.register(() => win);
registerNoteFiles(ipcMain, dialog, () => win, noteFiles);

ipcMain.handle('sequences:list', () => ({ ...(taskSequences?.list() ?? { tasks: [], error: t('sequences.storage') }), agents: sequenceAgents() }));
for (const action of ['save', 'remove', 'start', 'action']) {
  ipcMain.handle(`sequences:${action}`, (_event, ...args) => {
    try {
      if (!taskSequences) throw new Error(t('sequences.storage'));
      return { value: taskSequences[action](...args) };
    } catch (error) { return { error: error.message }; }
  });
}

// Pas de barre de menu File / Edit / View.
Menu.setApplicationMenu(null);
// Identité propre dans la barre des tâches (sinon Windows regroupe la fenêtre sous « Electron »).
app.setAppUserModelId('com.orchestraboard.orchestra');

// Une seule instance : un deuxième lancement ramène la fenêtre existante (même cachée) au lieu d'ouvrir
// une app de plus qui réécrirait les mêmes fichiers.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (!isFirstInstance) return;
  migrateOldUserData();
  taskSequences = createTaskSequences(app.getPath('userData'), {
    t, agents: sequenceAgents, info: agentStatus.info,
    enqueue: linkRelay.enqueue, cancel: linkRelay.cancelSequence,
    lastReply: linkRelay.lastReply, readDelay: linkRelay.READ_DELAY,
    emit: (value) => send('sequences:changed', value),
  });
  claudeHooks.clearAll();
  antigravityHooks.clearAll();
  await hookServer.start(onHook, callTool);
  codexProfile.ensure();
  createWindow();
});

// Pas de processus orphelins : on tue tous les agents en quittant.
app.on('before-quit', () => {
  startingCards.clear();
  visualTests.dispose();
  noteFiles.dispose();
  taskSequences?.dispose();
  linkRelay.dispose();
  subagents.closeAll();
  ptyManager.killAll();
  workerSandbox.dispose();
  antigravityHooks.clearAll();
  usage.stop();
});
app.on('window-all-closed', () => app.quit());
