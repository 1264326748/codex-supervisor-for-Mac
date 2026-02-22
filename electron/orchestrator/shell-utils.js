import { spawn, spawnSync } from 'node:child_process';

export function runCommandSync(command, args = [], options = {}) {
  const timeout = Number(options.timeout || 15000);
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf-8',
    timeout,
  });

  return {
    ok: result.status === 0,
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : '',
    command,
    args,
  };
}

export function spawnShell(command, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  return spawn('bash', ['-lc', command], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function normalizeLineBuffer(raw, maxLines = 300) {
  const text = String(raw || '');
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd());

  return lines.slice(-maxLines);
}

export function appendChunkToLines(lines, chunk, maxLines = 300) {
  const text = String(chunk || '').replace(/\r/g, '');
  const fragments = text.split('\n');
  const next = [...lines];
  if (next.length === 0) {
    next.push('');
  }

  for (let i = 0; i < fragments.length; i += 1) {
    const fragment = fragments[i];
    const isLast = i === fragments.length - 1;
    if (isLast && text.endsWith('\n')) {
      next[next.length - 1] += fragment;
      next.push('');
      continue;
    }

    if (i === 0) {
      next[next.length - 1] += fragment;
    } else {
      next.push(fragment);
    }
  }

  while (next.length > maxLines) {
    next.shift();
  }

  return next;
}

export function nowIso() {
  return new Date().toISOString();
}
