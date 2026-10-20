const { contextBridge, ipcRenderer, webUtils } = require('electron');

let saveHandler = null;
let saveAsHandler = null;

contextBridge.exposeInMainWorld('ttlDesktop', {
  save: (text, suggestedName, forceDialog) =>
    ipcRenderer.invoke('ttl:save', { text, suggestedName, forceDialog }),
  getRecentFiles: () => ipcRenderer.invoke('ttl:recent'),
  openPath: (filePath) => ipcRenderer.invoke('ttl:open-path', filePath),
  openDialog: () => ipcRenderer.invoke('ttl:open-dialog'),
  setDocument: (filePath) => ipcRenderer.send('ttl:document', filePath || null),
  setDirty: (dirty) => ipcRenderer.send('ttl:dirty', Boolean(dirty)),

  // SHACL-shapes
  getShapesState: () => ipcRenderer.invoke('shapes:state'),
  setAppliedShapes: (names) => ipcRenderer.invoke('shapes:set-applied', names),
  readShapes: (names) => ipcRenderer.invoke('shapes:read', names),

  // Standaardprefix voor nieuwe resources
  getDefaultPrefix: () => ipcRenderer.invoke('prefix:default'),
  setDefaultPrefix: (name) => ipcRenderer.invoke('prefix:set-default', name),

  registerSaveHandlers: (save, saveAs) => {
    saveHandler = save;
    saveAsHandler = saveAs;
  }
});

function pathOf(file) {
  try {
    return webUtils.getPathForFile(file) || null;
  } catch (err) {
    return null;
  }
}

function loadIntoApp(name, content) {
  const input = document.getElementById('fileInput');
  if (!input) return;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name, { type: 'text/turtle' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    console.error('Kon bestand niet inladen:', err);
  }
}

function syncWindowTitle() {
  const nameEl = document.getElementById('fileName');
  const statusEl = document.getElementById('status');
  const name = nameEl ? nameEl.textContent.trim() : '';
  const status = statusEl ? statusEl.textContent.trim() : '';
  document.title = name ? `${name}${status ? ' — ' + status : ''}` : 'LDEdit';
}

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.on('app:open-file', (_event, payload) => loadIntoApp(payload.name, payload.content));
  ipcRenderer.on('app:new-model', () => document.getElementById('newFileBtn')?.click());
  ipcRenderer.on('app:prefixes', () => document.getElementById('prefixBtn')?.click());
  ipcRenderer.on('app:shapes', () => document.getElementById('shapesBtn')?.click());
  ipcRenderer.on('app:save', () => { if (saveHandler) saveHandler(); });
  ipcRenderer.on('app:save-as', () => { if (saveAsHandler) saveAsHandler(); });
  ipcRenderer.on('app:save-and-close', async () => {
    let outcome = null;
    try {
      if (saveHandler) outcome = await saveHandler();
    } catch (err) {
      outcome = null;
    }
    ipcRenderer.send(outcome && outcome.saved ? 'ttl:close-confirmed' : 'ttl:close-cancelled');
  });

  ['fileName', 'status'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      new MutationObserver(syncWindowTitle).observe(el, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
  });
  syncWindowTitle();
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  const filePath = pathOf(file);
  if (filePath) {
    // via het hoofdproces, zodat ook hier om bevestiging wordt gevraagd
    // wanneer er niet-opgeslagen wijzigingen open staan
    ipcRenderer.invoke('ttl:open-path', filePath);
    return;
  }
  file.text().then((content) => {
    ipcRenderer.send('ttl:document', null);
    loadIntoApp(file.name, content);
  });
});
