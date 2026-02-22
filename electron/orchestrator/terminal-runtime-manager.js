import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCommandSync, spawnShell, appendChunkToLines } from './shell-utils.js';

const DEFAULT_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function splitPathEntries(value) {
  return String(value || '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function buildRuntimePath(originalPath = '') {
  const merged = dedupe([...splitPathEntries(originalPath), ...DEFAULT_BIN_DIRS]);
  return merged.join(':');
}

function isExecutable(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeBashSingleQuotes(text) {
  return String(text || '').replace(/'/g, `'\\''`);
}

function escapeDoubleQuoted(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildCdCommand(cwd, command) {
  const safeCwd = escapeBashSingleQuotes(cwd);
  return `cd '${safeCwd}' && ${command}`;
}

function normalizeTmuxSessionName(sessionId) {
  const base = String(sessionId || 'session').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `sup-${base}`.slice(0, 48);
}

function commandNeedsTty(command) {
  const text = String(command || '').trim();
  return /(^|\s|\/)(codex)(\s|$)/i.test(text);
}

function wrapSubprocessCommand(workspacePath, command) {
  const base = buildCdCommand(workspacePath, command);
  if (!commandNeedsTty(command)) {
    return base;
  }
  const safeBase = escapeBashSingleQuotes(base);
  return `script -q /dev/null bash -lc '${safeBase}'`;
}

export class TerminalRuntimeManager extends EventEmitter {
  constructor() {
    super();
    this.tmuxSessions = new Map();
    this.subprocessSessions = new Map();
    this.runtimeEnv = {
      ...process.env,
      PATH: buildRuntimePath(process.env.PATH || ''),
    };
    this.tmuxBinary = '';
  }

  resolveBinary(commandName, extraCandidates = []) {
    const candidates = [];
    for (const item of extraCandidates) {
      candidates.push(item);
    }
    for (const dir of splitPathEntries(this.runtimeEnv.PATH)) {
      candidates.push(path.join(dir, commandName));
    }

    for (const candidate of dedupe(candidates)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  detectRuntime() {
    const tmuxPath = this.resolveBinary('tmux', ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux']);
    if (!tmuxPath) {
      this.tmuxBinary = '';
      return 'subprocess';
    }

    const tmuxCheck = runCommandSync(tmuxPath, ['-V'], {
      timeout: 3000,
      env: this.runtimeEnv,
    });
    if (tmuxCheck.ok) {
      this.tmuxBinary = tmuxPath;
      return 'tmux';
    }

    this.tmuxBinary = '';
    return 'subprocess';
  }

  startSession({
    sessionId,
    workspacePath,
    workerCount,
    supervisorCommand = 'codex',
    workerCommand = 'codex',
    preferredRuntime = 'hybrid',
  }) {
    const canTmux = this.detectRuntime() === 'tmux';
    const runtime = preferredRuntime === 'subprocess'
      ? 'subprocess'
      : (canTmux ? 'tmux' : 'subprocess');

    if (runtime === 'tmux') {
      return this.startTmuxSession({
        sessionId,
        workspacePath,
        workerCount,
        supervisorCommand,
        workerCommand,
      });
    }

    return this.startSubprocessSession({
      sessionId,
      workspacePath,
      workerCount,
      supervisorCommand,
      workerCommand,
    });
  }

  attachTmuxSession({ sessionId, tmuxSession, targetIds = [] }) {
    const tmuxBinary = this.tmuxBinary || this.resolveBinary('tmux', ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux']);
    if (!tmuxBinary) {
      return {
        ok: false,
        error: '未检测到 tmux 可执行文件',
      };
    }

    const hasSession = runCommandSync(tmuxBinary, ['has-session', '-t', tmuxSession], {
      timeout: 4000,
      env: this.runtimeEnv,
    });
    if (!hasSession.ok) {
      return {
        ok: false,
        error: hasSession.stderr || hasSession.error || `tmux 会话不存在: ${tmuxSession}`,
      };
    }

    this.tmuxBinary = tmuxBinary;
    this.tmuxSessions.set(sessionId, {
      runtime: 'tmux',
      tmuxSession,
      tmuxBinary,
      targets: Array.from(new Set(targetIds.filter(Boolean))),
    });

    return {
      ok: true,
      runtime: 'tmux',
      tmuxSession,
    };
  }

  startTmuxSession({ sessionId, workspacePath, workerCount, supervisorCommand, workerCommand }) {
    const tmuxBinary = this.tmuxBinary || this.resolveBinary('tmux', ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux']);
    if (!tmuxBinary) {
      throw new Error('未检测到 tmux 可执行文件，无法启动 tmux 运行时');
    }

    const tmuxSession = normalizeTmuxSessionName(sessionId);

    runCommandSync(tmuxBinary, ['kill-session', '-t', tmuxSession], {
      timeout: 3000,
      env: this.runtimeEnv,
    });

    const supervisorStartup = buildCdCommand(workspacePath, supervisorCommand);
    const newSessionResult = runCommandSync(
      tmuxBinary,
      ['new-session', '-d', '-s', tmuxSession, '-n', 'supervisor', 'bash', '-lc', supervisorStartup],
      { timeout: 12000, env: this.runtimeEnv },
    );
    if (!newSessionResult.ok) {
      throw new Error(`启动主管窗口失败: ${newSessionResult.stderr || newSessionResult.error || 'unknown'}`);
    }

    const workers = [];
    for (let i = 1; i <= workerCount; i += 1) {
      const workerName = `worker-${i}`;
      const workerStartup = buildCdCommand(workspacePath, workerCommand);
      const createResult = runCommandSync(
        tmuxBinary,
        ['new-window', '-t', tmuxSession, '-n', workerName, 'bash', '-lc', workerStartup],
        { timeout: 12000, env: this.runtimeEnv },
      );
      if (!createResult.ok) {
        throw new Error(`启动执行窗口 ${workerName} 失败: ${createResult.stderr || createResult.error || 'unknown'}`);
      }
      workers.push(workerName);
    }

    this.tmuxSessions.set(sessionId, {
      runtime: 'tmux',
      tmuxSession,
      tmuxBinary,
      targets: ['supervisor', ...workers],
    });

    this.tryOpenTerminalTabs(tmuxBinary, tmuxSession, ['supervisor', ...workers]);

    return {
      runtime: 'tmux',
      supervisorId: 'supervisor',
      workerIds: workers,
      tmuxSession,
    };
  }

  tryOpenTerminalTabs(tmuxBinary, tmuxSession, targets = []) {
    if (process.platform !== 'darwin') {
      return;
    }
    if (String(process.env.SUPERVISOR_OPEN_TERMINALS || '1') === '0') {
      return;
    }

    for (const targetId of targets) {
      const command = `"${escapeDoubleQuoted(tmuxBinary)}" attach -t "${escapeDoubleQuoted(tmuxSession)}" \\; select-window -t "${escapeDoubleQuoted(targetId)}"`;
      const script = [
        'tell application "Terminal"',
        'activate',
        `do script "${command}"`,
        'end tell',
      ].join('\n');
      runCommandSync('/usr/bin/osascript', ['-e', script], { timeout: 5000, env: this.runtimeEnv });
    }
  }

  startSubprocessSession({ sessionId, workspacePath, workerCount, supervisorCommand, workerCommand }) {
    const targets = new Map();
    const startTarget = (targetId, command) => {
      const child = spawnShell(wrapSubprocessCommand(workspacePath, command), {
        cwd: workspacePath,
        env: this.runtimeEnv,
      });
      const record = {
        process: child,
        lines: [''],
        status: 'running',
        exitCode: null,
      };

      child.stdout.on('data', (chunk) => {
        record.lines = appendChunkToLines(record.lines, chunk, 400);
        this.emit('output', {
          sessionId,
          targetId,
          lines: record.lines.slice(-120),
          lastLine: this.pickLastLine(record.lines),
        });
      });

      child.stderr.on('data', (chunk) => {
        record.lines = appendChunkToLines(record.lines, chunk, 400);
        this.emit('output', {
          sessionId,
          targetId,
          lines: record.lines.slice(-120),
          lastLine: this.pickLastLine(record.lines),
        });
      });

      child.on('exit', (code) => {
        record.status = 'stopped';
        record.exitCode = code;
      });

      targets.set(targetId, record);
    };

    startTarget('supervisor', supervisorCommand);

    const workers = [];
    for (let i = 1; i <= workerCount; i += 1) {
      const workerId = `worker-${i}`;
      startTarget(workerId, workerCommand);
      workers.push(workerId);
    }

    this.subprocessSessions.set(sessionId, {
      runtime: 'subprocess',
      targets,
    });

    return {
      runtime: 'subprocess',
      supervisorId: 'supervisor',
      workerIds: workers,
      tmuxSession: '',
    };
  }

  sendInput({ sessionId, targetId, text = '', pressEnter = true }) {
    const tmuxMeta = this.tmuxSessions.get(sessionId);
    if (tmuxMeta) {
      const tmuxTarget = `${tmuxMeta.tmuxSession}:${targetId}`;
      if (text) {
        const textResult = runCommandSync(
          tmuxMeta.tmuxBinary,
          ['send-keys', '-t', tmuxTarget, '-l', text],
          { timeout: 6000, env: this.runtimeEnv },
        );
        if (!textResult.ok) {
          return textResult;
        }
      }
      if (pressEnter) {
        const enterResult = runCommandSync(
          tmuxMeta.tmuxBinary,
          ['send-keys', '-t', tmuxTarget, 'Enter'],
          { timeout: 6000, env: this.runtimeEnv },
        );
        if (!enterResult.ok) {
          return enterResult;
        }

        const longInput = String(text || '').length > 80;
        if (longInput) {
          runCommandSync(
            tmuxMeta.tmuxBinary,
            ['send-keys', '-t', tmuxTarget, 'Enter'],
            { timeout: 6000, env: this.runtimeEnv },
          );
        }
        return enterResult;
      }
      return { ok: true, stdout: '', stderr: '' };
    }

    const subprocessMeta = this.subprocessSessions.get(sessionId);
    if (subprocessMeta) {
      const target = subprocessMeta.targets.get(targetId);
      if (!target || !target.process || target.status !== 'running') {
        return { ok: false, stderr: `目标不可写入: ${targetId}` };
      }
      const content = `${text}${pressEnter ? '\n' : ''}`;
      target.process.stdin.write(content);
      return { ok: true, stdout: '' };
    }

    return { ok: false, stderr: `会话不存在: ${sessionId}` };
  }

  readRecentLines({ sessionId, targetId, lineCount = 120 }) {
    const tmuxMeta = this.tmuxSessions.get(sessionId);
    if (tmuxMeta) {
      const target = `${tmuxMeta.tmuxSession}:${targetId}`;
      const result = runCommandSync(
        tmuxMeta.tmuxBinary,
        ['capture-pane', '-p', '-J', '-t', target, '-S', `-${Math.max(20, lineCount)}`],
        { timeout: 6000, env: this.runtimeEnv },
      );
      if (!result.ok) {
        return {
          ok: false,
          lines: [],
          lastLine: '',
          error: result.stderr || result.error || 'capture failed',
        };
      }
      const lines = String(result.stdout || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trimEnd())
        .slice(-lineCount);
      return {
        ok: true,
        lines,
        lastLine: this.pickLastLine(lines),
      };
    }

    const subprocessMeta = this.subprocessSessions.get(sessionId);
    if (subprocessMeta) {
      const target = subprocessMeta.targets.get(targetId);
      if (!target) {
        return {
          ok: false,
          lines: [],
          lastLine: '',
          error: `target not found: ${targetId}`,
        };
      }
      const lines = target.lines.slice(-lineCount);
      return {
        ok: true,
        lines,
        lastLine: this.pickLastLine(lines),
      };
    }

    return {
      ok: false,
      lines: [],
      lastLine: '',
      error: `session not found: ${sessionId}`,
    };
  }

  pickLastLine(lines) {
    const list = Array.isArray(lines) ? lines : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const line = String(list[i] || '').trim();
      if (line) {
        return line;
      }
    }
    return '';
  }

  stopSession(sessionId) {
    const tmuxMeta = this.tmuxSessions.get(sessionId);
    if (tmuxMeta) {
      runCommandSync(tmuxMeta.tmuxBinary, ['kill-session', '-t', tmuxMeta.tmuxSession], {
        timeout: 6000,
        env: this.runtimeEnv,
      });
      this.tmuxSessions.delete(sessionId);
      return { ok: true };
    }

    const subprocessMeta = this.subprocessSessions.get(sessionId);
    if (subprocessMeta) {
      for (const target of subprocessMeta.targets.values()) {
        if (target.process && target.status === 'running') {
          target.process.kill('SIGTERM');
        }
      }
      this.subprocessSessions.delete(sessionId);
      return { ok: true };
    }

    return { ok: false, error: '会话不存在' };
  }

  getRuntimeMeta(sessionId) {
    if (this.tmuxSessions.has(sessionId)) {
      return this.tmuxSessions.get(sessionId);
    }
    if (this.subprocessSessions.has(sessionId)) {
      return this.subprocessSessions.get(sessionId);
    }
    return null;
  }
}
