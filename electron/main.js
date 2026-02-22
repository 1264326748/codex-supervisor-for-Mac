import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { SessionStore } from './store/session-store.js';
import { TerminalRuntimeManager } from './orchestrator/terminal-runtime-manager.js';
import { SupervisorPlannerService } from './orchestrator/supervisor-planner-service.js';
import { TaskDispatchService } from './orchestrator/task-dispatch-service.js';
import { ApprovalBrokerService } from './orchestrator/approval-broker-service.js';
import { SessionOrchestrator } from './orchestrator/session-orchestrator.js';
import { registerIpcHandlers } from './ipc/register-ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAIN_LOG_FILE = '/tmp/codex-supervisor-desktop-main.log';
const DISABLE_GPU_BY_DEFAULT = String(process.env.SUPERVISOR_DISABLE_GPU || '1') !== '0';

let mainWindow = null;
let orchestrator = null;

function logMain(message, extra = '') {
  const line = `[${new Date().toISOString()}] ${message}${extra ? ` | ${extra}` : ''}`;
  try {
    fs.appendFileSync(MAIN_LOG_FILE, `${line}\n`, 'utf-8');
  } catch {
    // ignore log write errors
  }
}

function showFatalPage(reason, detail = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const escapedReason = String(reason || 'unknown')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escapedDetail = String(detail || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>启动失败</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; background:#f5f7fb; color:#243447; margin:0; padding:24px; }
    .card { max-width:880px; margin:0 auto; background:#fff; border:1px solid #dbe4f1; border-radius:12px; padding:18px; }
    h1 { margin:0 0 10px; font-size:20px; }
    p { margin:8px 0; line-height:1.6; }
    code, pre { background:#f3f6fb; border:1px solid #dbe4f1; border-radius:8px; padding:8px; display:block; white-space:pre-wrap; word-break:break-word; }
  </style>
</head>
<body>
  <section class="card">
    <h1>应用启动失败</h1>
    <p>原因：${escapedReason}</p>
    ${escapedDetail ? `<pre>${escapedDetail}</pre>` : ''}
    <p>请把下面日志内容发给开发者继续定位：</p>
    <code>tail -n 200 /tmp/codex-supervisor-desktop-main.log</code>
  </section>
</body>
</html>`;

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  mainWindow.loadURL(dataUrl);
}

if (DISABLE_GPU_BY_DEFAULT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

function createWindow() {
  logMain('create-window:start');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#f3f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    logMain('window-load-url', devUrl);
  } else {
    const htmlPath = path.join(__dirname, '../dist/renderer/index.html');
    mainWindow.loadFile(htmlPath);
    logMain('window-load-file', htmlPath);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const currentUrl = mainWindow.webContents.getURL();
    logMain('webcontents:did-finish-load', currentUrl);

    if (String(currentUrl || '').startsWith('data:text/html')) {
      return;
    }

    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      try {
        const probe = await mainWindow.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('root');
          return {
            hasDesktopApi: typeof window.desktopApi !== 'undefined',
            rootChildren: root ? root.children.length : -1,
            bodyTextLength: (document.body && document.body.innerText ? document.body.innerText.trim().length : 0)
          };
        })();`);
        logMain('renderer:boot-probe', JSON.stringify(probe));

        const noApi = !probe?.hasDesktopApi;
        const looksBlank = Number(probe?.rootChildren || 0) === 0 && Number(probe?.bodyTextLength || 0) === 0;
        if (noApi || looksBlank) {
          showFatalPage('渲染层未正常完成初始化', JSON.stringify(probe));
        }
      } catch (error) {
        logMain('renderer:boot-probe-failed', String(error?.stack || error));
        showFatalPage('渲染层探测失败', String(error?.message || error));
      }
    }, 1600);
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    logMain('webcontents:did-fail-load', `code=${code} desc=${desc} url=${url} isMainFrame=${isMainFrame}`);
    if (isMainFrame) {
      showFatalPage('页面加载失败', `code=${code} desc=${desc} url=${url}`);
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logMain('renderer:console-message', `level=${level} line=${line} source=${sourceId} message=${message}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logMain('webcontents:render-process-gone', JSON.stringify(details || {}));
    showFatalPage('渲染进程异常退出', JSON.stringify(details || {}));
  });

  mainWindow.on('unresponsive', () => {
    logMain('window:unresponsive');
  });

  mainWindow.on('closed', () => {
    logMain('window:closed');
    mainWindow = null;
  });

  logMain('create-window:done');
}

function bootstrapServices() {
  const dataRoot = path.join(__dirname, '../data');
  const store = new SessionStore({ rootDir: dataRoot });
  const runtimeManager = new TerminalRuntimeManager();

  const pushToRenderer = (_sessionId, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send('session:event', payload);
  };

  const plannerService = new SupervisorPlannerService({
    runtimeManager,
    sessionStore: store,
    onEvent: (sessionId, payload) => pushToRenderer(sessionId, payload),
  });
  const dispatchService = new TaskDispatchService({
    runtimeManager,
    sessionStore: store,
    onEvent: (sessionId, payload) => pushToRenderer(sessionId, payload),
  });
  const approvalBroker = new ApprovalBrokerService({
    runtimeManager,
    sessionStore: store,
    plannerService,
    onEvent: (sessionId, payload) => pushToRenderer(sessionId, payload),
  });

  orchestrator = new SessionOrchestrator({
    sessionStore: store,
    runtimeManager,
    plannerService,
    dispatchService,
    approvalBroker,
    onBroadcast: pushToRenderer,
  });

  registerIpcHandlers({ orchestrator });
  try {
    orchestrator.recoverSessionsOnStartup();
    logMain('services:session-recovery', 'done');
  } catch (error) {
    logMain('services:session-recovery-failed', String(error?.stack || error));
  }
  logMain('services:bootstrapped');
}

process.on('uncaughtException', (error) => {
  logMain('process:uncaughtException', String(error?.stack || error));
});

process.on('unhandledRejection', (reason) => {
  logMain('process:unhandledRejection', String(reason?.stack || reason));
});

app.on('child-process-gone', (_event, details) => {
  logMain('app:child-process-gone', JSON.stringify(details || {}));
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_preloadEvent, preloadPath, error) => {
    logMain('webcontents:preload-error', `${preloadPath} | ${String(error?.stack || error)}`);
  });
});

app.whenReady().then(() => {
  logMain('app:ready');
  logMain('app:gpu-policy', DISABLE_GPU_BY_DEFAULT ? 'disabled-by-default' : 'enabled');
  bootstrapServices();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  logMain('app:window-all-closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  logMain('app:quit');
});
