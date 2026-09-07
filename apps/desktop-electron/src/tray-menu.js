import { Tray, Menu, shell, app } from 'electron';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createTray({
  iconPath,
  mainWindow,
  processManager,
  onShowLogs,
  onQuit,
}) {
  const tray = new Tray(iconPath);
  tray.setToolTip('FEAGLE WxBot 微信 AI 智能体');

  const updateMenu = () => {
    const isAutoStart = app.getLoginItemSettings().openAtLogin;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '打开控制台',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: '在外部浏览器打开',
        click: () => {
          const port = processManager.dashboardPort || 6190;
          shell.openExternal(`http://127.0.0.1:${port}`);
        },
      },
      {
        label: '查看运行日志',
        click: () => {
          if (onShowLogs) onShowLogs();
        },
      },
      { type: 'separator' },
      {
        label: '开机自启动',
        type: 'checkbox',
        checked: isAutoStart,
        click: (menuItem) => {
          app.setLoginItemSettings({
            openAtLogin: menuItem.checked,
          });
        },
      },
      {
        label: '重启核心服务',
        click: async () => {
          processManager.stopAll();
          processManager.isShuttingDown = false;
          await processManager.startAll();
        },
      },
      { type: 'separator' },
      {
        label: '退出 FEAGLE WxBot',
        click: () => {
          if (onQuit) onQuit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
  };

  updateMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  return tray;
}
