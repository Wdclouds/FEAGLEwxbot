import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pushLog } from './terminal-log.js';

export class AstrBotSupervisor {
  constructor({ state }) {
    this.state = state;
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  bootstrap() {
    const result = spawnSync(
      '/app/.venv/bin/python',
      ['/app/src/bootstrap_astrbot.py'],
      {
        cwd: '/app',
        env: {
          ...process.env,
          ASTRBOT_ROOT: '/app',
          PYTHONPATH: '/app/AstrBot',
        },
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `AstrBot 配置初始化失败: ${(result.stderr || result.stdout || '').trim()}`,
      );
    }
  }

  start() {
    this.bootstrap();
    this.spawnProcess();
  }

  spawnProcess() {
    this.state.patch('astrbot', {
      status: 'STARTING',
      detail: '正在启动 AstrBot 4.26.7',
    });
    this.child = spawn(
      '/app/.venv/bin/python',
      ['/app/AstrBot/main.py'],
      {
        cwd: '/app',
        env: {
          ...process.env,
          ASTRBOT_ROOT: '/app',
          PYTHONPATH: '/app/AstrBot',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.state.patch('astrbot', {
      status: 'RUNNING',
      pid: this.child.pid,
      detail: 'AstrBot 进程运行中',
    });

    this.pipeLogs(this.child.stdout, false);
    this.pipeLogs(this.child.stderr, true);

    this.child.on('error', (error) => {
      this.state.addError('astrbot-process', error);
      this.state.patch('astrbot', {
        status: 'ERROR',
        detail: error.message,
      });
    });

    this.child.on('exit', (code, signal) => {
      this.state.patch('astrbot', {
        status: this.stopping ? 'STOPPED' : 'EXITED',
        pid: null,
        detail: `退出 code=${code ?? '-'} signal=${signal ?? '-'}`,
      });
      if (this.stopping) return;
      const restarts = this.state.astrbot.restarts + 1;
      this.state.patch('astrbot', { restarts });
      this.restartTimer = setTimeout(() => this.spawnProcess(), 5_000);
      this.restartTimer.unref();
    });
  }

  pipeLogs(stream, isError) {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      const output = `[AstrBot] ${line}`;
      if (isError) console.error(output);
      else console.log(output);
      pushLog(isError ? 'ERROR' : 'INFO', line);
      if (/adapter.*connected|适配器已连接/i.test(line)) {
        this.state.patch('astrbot', {
          status: 'READY',
          detail: 'OneBot v11 适配器已连接',
        });
      }
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (!this.child || this.child.killed) return;
    this.child.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!this.child?.killed) this.child?.kill('SIGKILL');
    }, 15_000);
    forceTimer.unref();
  }
}
