// Electron entry for ClawDoc. Boots the existing Node server in-process, then
// opens a BrowserWindow pointing at the local URL.
//
// Strategy:
//  - Redirect CLAWDOC_DATA_DIR to Electron's userData so settings.json and
//    index.json live in a writable location when packaged.
//  - On first launch (no settings.json, no CLAWDOC_ROOT), prompt the user for a
//    workspace folder and persist it via CLAWDOC_ROOT before requiring serve.js.
//  - Wait for the HTTP port to accept connections, then open the window.

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// Picked at startup so the packaged app never collides with a dev instance.
let PORT = Number(process.env.CLAWDOC_PORT) || 0;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, host, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.connect(port, host, () => { sock.end(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function pickWorkspaceSync() {
  const result = dialog.showOpenDialogSync({
    title: 'Choose a workspace folder for ClawDoc',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (!result || !result.length) return null;
  return result[0];
}

async function start() {
  await app.whenReady();

  // Redirect serve.js's writable files (settings.json, index.json) to userData.
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.CLAWDOC_DATA_DIR = dataDir;

  // Pick a free port if one wasn't supplied via env, then make it visible to
  // serve.js (which reads process.env.CLAWDOC_PORT at require time).
  if (!PORT) PORT = await pickFreePort();
  process.env.CLAWDOC_PORT = String(PORT);

  // Mirror Electron's log to a file in userData so packaged-app failures are
  // diagnosable even when the helper window flashes and dies.
  const logPath = path.join(dataDir, 'clawdoc.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const tee = (orig) => (...args) => {
    try { logStream.write(args.map(String).join(' ') + '\n'); } catch {}
    orig.apply(console, args);
  };
  console.log = tee(console.log);
  console.error = tee(console.error);
  console.log(`[clawdoc] boot pid=${process.pid} port=${PORT} data=${dataDir}`);

  // Determine workspace root. Order: existing settings.json → CLAWDOC_ROOT env
  // → folder picker.
  const settingsPath = path.join(dataDir, 'settings.json');
  const hasSettings = fs.existsSync(settingsPath);
  if (!hasSettings && !process.env.CLAWDOC_ROOT) {
    const picked = pickWorkspaceSync();
    if (!picked) { app.quit(); return; }
    process.env.CLAWDOC_ROOT = picked;
  }

  // Boot the embedded ClawDoc server. It starts listening on require().
  try {
    require('./serve.js');
  } catch (err) {
    console.error('[clawdoc] serve.js threw on require:', err && err.stack || err);
    throw err;
  }

  const up = await waitForPort(PORT, '127.0.0.1', 10000);
  if (!up) {
    dialog.showErrorBox('ClawDoc', `Server did not start on port ${PORT}.`);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'ClawDoc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the Chromium PDF viewer extension so <embed type="application/pdf">
      // renders inline (off by default in Electron BrowserWindows).
      plugins: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Reopen window on macOS dock click after all windows closed.
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      title: 'ClawDoc',
      webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the Chromium PDF viewer extension so <embed type="application/pdf">
      // renders inline (off by default in Electron BrowserWindows).
      plugins: true,
    },
    });
    win.loadURL(`http://127.0.0.1:${PORT}/`);
  }
});

process.on('uncaughtException', err => {
  try { console.error('[clawdoc] uncaughtException:', err && err.stack || err); } catch {}
});
process.on('unhandledRejection', err => {
  try { console.error('[clawdoc] unhandledRejection:', err && err.stack || err); } catch {}
});

start().catch(err => {
  try { console.error('[clawdoc] start() rejected:', err && err.stack || err); } catch {}
  dialog.showErrorBox('ClawDoc failed to start', String(err && err.stack || err));
  app.quit();
});
