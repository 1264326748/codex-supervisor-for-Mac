import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../orchestrator/shell-utils.js';

export class SessionStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.sessionsDir = path.join(rootDir, 'sessions');
    this.logsDir = path.join(rootDir, 'logs');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  listSessionIds() {
    const files = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    return files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort((a, b) => b.localeCompare(a));
  }

  listSessions() {
    return this.listSessionIds()
      .map((id) => this.getSession(id))
      .filter(Boolean)
      .map((session) => ({
        sessionId: session.sessionId,
        objective: session.objective,
        runtime: session.runtime,
        status: session.status,
        planningState: session.planning?.state || '',
        planningPhase: session.planning?.phase || '',
        workerCount: Array.isArray(session.workers) ? session.workers.length : 0,
        pendingApprovals: Array.isArray(session.approvals)
          ? session.approvals.filter((item) => item.status === 'pending').length
          : 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }));
  }

  getSessionPath(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  getLogPath(sessionId) {
    return path.join(this.logsDir, `${sessionId}.ndjson`);
  }

  createSession(session) {
    const now = nowIso();
    const next = {
      ...session,
      createdAt: session.createdAt || now,
      updatedAt: now,
    };
    this.saveSession(next);
    this.appendEvent(session.sessionId, {
      type: 'session_created',
      at: now,
      payload: {
        objective: next.objective,
        workerCount: (next.workers || []).length,
        runtime: next.runtime,
      },
    });
    return next;
  }

  getSession(sessionId) {
    const filePath = this.getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveSession(session) {
    const next = {
      ...session,
      updatedAt: nowIso(),
    };
    fs.writeFileSync(this.getSessionPath(session.sessionId), JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }

  updateSession(sessionId, updater) {
    const current = this.getSession(sessionId);
    if (!current) {
      return null;
    }
    const updated = updater({ ...current });
    return this.saveSession(updated);
  }

  appendEvent(sessionId, event) {
    const line = JSON.stringify({
      at: nowIso(),
      ...event,
    });
    fs.appendFileSync(this.getLogPath(sessionId), `${line}\n`, 'utf-8');
  }

  readLogTail(sessionId, limit = 120) {
    const filePath = this.getLogPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: 'unknown', raw: line };
        }
      });
  }
}
