const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const APP_NAME = 'LDEdit';
const COPYRIGHT = 'Copyright © 2026 Danny Greefhorst';
const TTL_FILE = /\.(ttl|turtle|txt)$/i;
const SHAPE_FILE = /\.(ttl|turtle|shacl)$/i;
const TTL_FILTERS = [
  { name: 'Turtle / RDF', extensions: ['ttl', 'turtle', 'txt'] },
  { name: 'Alle bestanden', extensions: ['*'] }
];
const MAX_RECENT = 10;

// Meegeleverd met de app: SHACL-shapes voor MIM, NL-SBB, DCAT-AP-NL, FDS-DQV en MDTO.
const BUNDLED_SHAPES_DIR = path.join(__dirname, 'shapes');

let mainWindow = null;
let windowReady = false;
let pendingOpenPath = null;
let currentFilePath = null;
let isDirty = false;
let forceClose = false;
let quitRequested = false;

function send(channel) {
  mainWindow?.webContents.send(channel);
}

function recentStorePath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function stateStorePath() {
  return path.join(app.getPath('userData'), 'ldedit-state.json');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

async function readRecent() {
  const list = await readJson(recentStorePath(), []);
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

async function recordRecent(filePath) {
  const list = await readRecent();
  const next = [filePath, ...list.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  await fs.mkdir(path.dirname(recentStorePath()), { recursive: true });
  await fs.writeFile(recentStorePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function listRecent() {
  const found = [];
  for (const filePath of await readRecent()) {
    try {
      await fs.access(filePath);
      found.push({ path: filePath, name: path.basename(filePath), dir: path.dirname(filePath) });
    } catch (err) {
      continue;
    }
  }
  return found.slice(0, MAX_RECENT);
}

/* ---------------- SHACL-shapes ---------------- */

async function readState() {
  const state = await readJson(stateStorePath(), {});
  return {
    applied: Array.isArray(state.applied) ? state.applied.filter((n) => typeof n === 'string') : [],
    defaultPrefix: typeof state.defaultPrefix === 'string' ? state.defaultPrefix : ''
  };
}

async function writeState(state) {
  await fs.mkdir(path.dirname(stateStorePath()), { recursive: true });
  await fs.writeFile(stateStorePath(), JSON.stringify(state, null, 2), 'utf8');
}

async function listShapeFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && SHAPE_FILE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return [];
  }
}

// Bundels: shapes + bijbehorende ontologie(ën) die als geheel worden gekozen.
// De indeling staat in bundles.json in de shapes-map; bestanden die daar niet in
// voorkomen worden ieder hun eigen bundel.
async function listBundles(dir, files) {
  let manifest = [];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'bundles.json'), 'utf8'));
    if (Array.isArray(raw)) manifest = raw;
  } catch (err) {
    manifest = [];
  }
  const bundles = [];
  const used = new Set();
  for (const entry of manifest) {
    if (!entry || !Array.isArray(entry.files)) continue;
    const list = entry.files.filter((f) => typeof f === 'string' && files.includes(f));
    if (!list.length) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : list[0];
    bundles.push({
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      files: list
    });
    list.forEach((f) => used.add(f));
  }
  files
    .filter((f) => !used.has(f))
    .forEach((f) => bundles.push({ id: f, name: f, description: '', files: [f] }));
  return bundles;
}

// Zet een opgeslagen selectie om naar bundel-id's. Oude selecties bevatten
// bestandsnamen; die worden naar hun bundel vertaald.
function migrateApplied(applied, bundles, files) {
  const ids = new Set(bundles.map((b) => b.id));
  const out = new Set();
  applied.forEach((name) => {
    if (ids.has(name)) {
      out.add(name);
      return;
    }
    if (files.includes(name)) {
      const bundle = bundles.find((b) => b.files.includes(name));
      if (bundle) out.add(bundle.id);
    }
  });
  return [...out];
}

async function shapesState() {
  const state = await readState();
  const dir = BUNDLED_SHAPES_DIR;
  const files = await listShapeFiles(dir);
  const bundles = await listBundles(dir, files);
  return {
    dir,
    files,
    bundles,
    applied: migrateApplied(state.applied, bundles, files)
  };
}

ipcMain.handle('shapes:state', () => shapesState());

ipcMain.handle('shapes:set-applied', async (_event, names) => {
  const state = await readState();
  state.applied = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  await writeState(state);
  return shapesState();
});

ipcMain.handle('shapes:read', async (_event, names) => {
  const state = await shapesState();
  const wanted = Array.isArray(names) ? names : state.applied;
  const out = [];
  for (const name of wanted) {
    if (!state.files.includes(name)) continue;
    try {
      out.push({ name, text: await fs.readFile(path.join(state.dir, name), 'utf8') });
    } catch (err) {
      out.push({ name, text: '', error: err.message });
    }
  }
  return out;
});

/* ---------------- standaardprefix ---------------- */

ipcMain.handle('prefix:default', async () => (await readState()).defaultPrefix);

ipcMain.handle('prefix:set-default', async (_event, name) => {
  const state = await readState();
  state.defaultPrefix = typeof name === 'string' ? name : '';
  await writeState(state);
  return state.defaultPrefix;
});

/* ---------------- document ---------------- */

function documentLabel() {
  return currentFilePath ? path.basename(currentFilePath) : 'dit model';
}

function setDirty(dirty) {
  isDirty = Boolean(dirty);
  mainWindow?.setDocumentEdited(isDirty);
}

function setCurrentFile(filePath) {
  currentFilePath = filePath || null;
  if (currentFilePath) {
    app.addRecentDocument(currentFilePath);
    recordRecent(currentFilePath).then(refreshMenu).catch(() => {});
    mainWindow?.setRepresentedFilename(currentFilePath);
  } else {
    mainWindow?.setRepresentedFilename('');
  }
  setDirty(false);
}

async function writeDocument({ text, suggestedName, forceDialog }) {
  let target = currentFilePath;
  if (forceDialog || !target) {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: forceDialog ? 'Opslaan als' : 'Turtle-bestand opslaan',
      defaultPath: target || path.join(app.getPath('documents'), suggestedName || 'bestand.ttl'),
      filters: TTL_FILTERS
    });
    if (canceled || !filePath) return { saved: false, canceled: true };
    target = filePath;
  }
  try {
    await fs.writeFile(target, text, 'utf8');
  } catch (err) {
    dialog.showErrorBox('Opslaan mislukt', `${target}\n\n${err.message}`);
    return { saved: false, error: err.message };
  }
  setCurrentFile(target);
  return { saved: true, path: target, name: path.basename(target) };
}

ipcMain.handle('ttl:save', (_event, payload) => writeDocument(payload));
ipcMain.handle('ttl:recent', () => listRecent());
// Synchrone vraag van de renderer bij het opstarten: wordt er al een bestand
// geopend (vanuit Finder of via de opdrachtregel)? Zo niet, dan tonen we het
// startscherm met recente bestanden.
ipcMain.on('app:startup-file', (event) => { event.returnValue = pendingOpenPath || null; });
ipcMain.handle('ttl:open-path', (_event, filePath) => openFileInWindow(filePath));
ipcMain.handle('ttl:open-dialog', () => pickAndOpen());
ipcMain.on('ttl:document', (_event, filePath) => setCurrentFile(filePath));
ipcMain.on('ttl:dirty', (_event, dirty) => setDirty(dirty));
ipcMain.on('ttl:close-confirmed', () => {
  forceClose = true;
  mainWindow?.close();
});
ipcMain.on('ttl:close-cancelled', () => { quitRequested = false; });

function fileFromArgv(argv) {
  return argv
    .slice(1)
    .find((arg) => !arg.startsWith('-') && TTL_FILE.test(arg)) || null;
}

function createWindow() {
  windowReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ldedit.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', async () => {
    windowReady = true;
    if (!pendingOpenPath) return;
    const target = pendingOpenPath;
    pendingOpenPath = null;
    const opened = await openFileInWindow(target);
    if (!opened) mainWindow?.webContents.send('app:show-start');
  });

  mainWindow.on('close', (event) => {
    if (forceClose || !isDirty) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Niet opslaan', 'Annuleren', 'Opslaan'],
      defaultId: 2,
      cancelId: 1,
      message: `Wil je de wijzigingen in "${documentLabel()}" opslaan voordat je afsluit?`,
      detail: 'Als je niet opslaat, gaan de wijzigingen verloren.'
    });
    if (choice === 0) {
      forceClose = true;
      mainWindow.close();
    } else if (choice === 1) {
      quitRequested = false;
    } else {
      mainWindow.webContents.send('app:save-and-close');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    windowReady = false;
    if (quitRequested) app.quit();
  });
}

function confirmDiscardChanges() {
  if (!isDirty) return true;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Annuleren', 'Doorgaan zonder opslaan'],
    defaultId: 0,
    cancelId: 0,
    message: `Er zijn niet-opgeslagen wijzigingen in "${documentLabel()}".`,
    detail: 'Als je een ander bestand opent, gaan deze wijzigingen verloren.'
  });
  return choice === 1;
}

async function openFileInWindow(filePath) {
  if (!confirmDiscardChanges()) return false;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    setCurrentFile(filePath);
    if (mainWindow) {
      mainWindow.webContents.send('app:open-file', {
        name: path.basename(filePath),
        content
      });
      mainWindow.focus();
    } else {
      pendingOpenPath = filePath;
    }
    return true;
  } catch (err) {
    dialog.showErrorBox(
      'Kon bestand niet openen',
      `${path.basename(filePath)}\n\n${err.message}`
    );
    return false;
  }
}

async function pickAndOpen() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Turtle-bestand openen',
    properties: ['openFile'],
    filters: TTL_FILTERS
  });
  if (!canceled && filePaths.length) openFileInWindow(filePaths[0]);
}

// Submenu met de recente bestanden; wordt bij elke menubouw opnieuw gevuld.
function recentSubmenu(recents) {
  const items = recents.map((r) => ({
    label: r.name,
    toolTip: r.path,
    click: () => openFileInWindow(r.path)
  }));
  if (!items.length) return [{ label: 'Geen recente bestanden', enabled: false }];
  items.push({ type: 'separator' });
  items.push({ label: 'Wis recente bestanden', click: () => clearRecent() });
  return items;
}

async function clearRecent() {
  try {
    await fs.rm(recentStorePath(), { force: true });
  } catch (err) {
    // negeren: als er niets staat is er niets te wissen
  }
  app.clearRecentDocuments();
  await buildMenu();
}

function refreshMenu() {
  buildMenu().catch(() => {});
}

async function buildMenu() {
  const recents = await listRecent();
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `Over ${APP_NAME}` },
        { type: 'separator' },
        { role: 'services', label: 'Diensten' },
        { type: 'separator' },
        { role: 'hide', label: `Verberg ${APP_NAME}` },
        { role: 'hideOthers', label: 'Verberg andere' },
        { role: 'unhide', label: 'Toon alles' },
        { type: 'separator' },
        { role: 'quit', label: `Stop ${APP_NAME}` }
      ]
    },
    {
      label: 'Bestand',
      submenu: [
        { label: 'Nieuw model', accelerator: 'CmdOrCtrl+N', click: () => send('app:new-model') },
        { label: 'Bestand openen…', accelerator: 'CmdOrCtrl+O', click: pickAndOpen },
        { label: 'Recente bestanden', submenu: recentSubmenu(recents) },
        { type: 'separator' },
        { label: 'Opslaan', accelerator: 'CmdOrCtrl+S', click: () => send('app:save') },
        { label: 'Opslaan als…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('app:save-as') },
        { type: 'separator' },
        { label: 'Turtle-preview…', accelerator: 'Shift+CmdOrCtrl+P', click: () => send('app:ttl-preview') },
        { type: 'separator' },
        { label: 'Prefixen…', accelerator: 'CmdOrCtrl+,', click: () => send('app:prefixes') }
      ]
    },
    {
      label: 'Shapes',
      submenu: [
        { label: 'Bundels…', accelerator: 'Shift+CmdOrCtrl+H', click: () => send('app:shapes') }
      ]
    },
    {
      label: 'Bewerken',
      submenu: [
        { role: 'undo', label: 'Ongedaan maken' },
        { role: 'redo', label: 'Opnieuw' },
        { type: 'separator' },
        { role: 'cut', label: 'Knippen' },
        { role: 'copy', label: 'Kopiëren' },
        { role: 'paste', label: 'Plakken' },
        { role: 'selectAll', label: 'Alles selecteren' }
      ]
    },
    {
      label: 'Beeld',
      submenu: [
        { role: 'reload', label: 'Herladen' },
        { role: 'forceReload', label: 'Geforceerd herladen' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom herstellen' },
        { role: 'zoomIn', label: 'Inzoomen' },
        { role: 'zoomOut', label: 'Uitzoomen' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Volledig scherm' },
        { role: 'toggleDevTools', label: 'Ontwikkelaarstools' }
      ]
    },
    {
      label: 'Venster',
      submenu: [
        { role: 'minimize', label: 'Minimaliseer' },
        { role: 'zoom', label: 'Zoomen' },
        { role: 'front', label: 'Alles naar voren' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('before-quit', () => { quitRequested = true; });

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady() && mainWindow && windowReady) openFileInWindow(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT
  });

  await buildMenu();
  const fromArgv = fileFromArgv(process.argv);
  if (fromArgv) pendingOpenPath = path.resolve(fromArgv);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
