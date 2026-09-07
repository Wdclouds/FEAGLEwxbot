import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from './process-manager.js';
import { createTray } from './tray-menu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 单例锁：防止多开造成端口冲突
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let logWindow = null;
let tray = null;
const processManager = new ProcessManager(app);

const iconPath = join(__dirname, '../assets/icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'FEAGLE WxBot 微信 AI 智能体',
    icon: iconPath,
    backgroundColor: '#09090b',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 默认加载 Splash 启动画面
  mainWindow.loadFile(join(__dirname, 'splash.html'));

  // 拦截外链点击，使用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口关闭时最小化到系统托盘
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
    return;
  }

  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    title: 'FEAGLE 运行日志',
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  logWindow.loadFile(join(__dirname, 'logs.html'));
}

// 转发子进程日志给窗口渲染层
processManager.on('log', (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feagle:log-entry', entry);
  }
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('feagle:log-entry', entry);
  }
});

// IPC 接口注册
ipcMain.handle('feagle:open-external', async (event, url) => {
  return shell.openExternal(url);
});

ipcMain.handle('feagle:get-logs', async () => {
  return processManager.logs;
});

ipcMain.handle('feagle:restart-services', async () => {
  processManager.stopAll();
  processManager.isShuttingDown = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(join(__dirname, 'splash.html'));
  }
  const ready = await processManager.startAll();
  if (ready && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${processManager.dashboardPort}`);
  }
});

ipcMain.handle('feagle:quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

// 应用生命周期
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  createMainWindow();

  tray = createTray({
    iconPath,
    mainWindow,
    processManager,
    onShowLogs: openLogWindow,
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
  });

  // 异步拉起后端子服务
  const ready = await processManager.startAll();
  if (ready && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${processManager.dashboardPort}`);
  } else if (!ready && mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '服务就绪超时',
      message: 'WeChat Bridge 服务未在预期时间内响应，请点击托盘图标查看运行日志。',
    });
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  processManager.stopAll();
});

app.on('will-quit', () => {
  processManager.stopAll();
});

app.on('window-all-closed', () => {
  // Windows 下保持后台常驻托盘，不退出
});
