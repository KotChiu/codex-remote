'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const CHUNK_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

function threadIdFromRolloutPath(filePath) {
  const match = /rollout-[0-9T:-]+-([0-9a-f-]{36})\.jsonl$/.exec(filePath);
  return match ? match[1] : null;
}

// Reads backwards in chunks until an active turn's `task_started` is found,
// so we don't lose the active turn in large session files.
function readTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(handle).size;
    let start = size;
    let text = '';
    let scanned = 0;

    while (start > 0 && scanned < maxBytes) {
      const length = Math.min(CHUNK_BYTES, start);
      start -= length;
      scanned += length;
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, start);
      text = buffer.toString('utf8') + text;
      if (text.includes('"task_started"')) break;
    }
    return text;
  } catch (error) {
    return '';
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch (error) {
        /* ignore */
      }
    }
  }
}

function scanRollout(tailText) {
  const lines = tailText.split('\n');

  const itemTurn = new Map();
  let lastRunTurn = null;
  let lastRunState = 'idle';
  let lastStartOffset = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.indexOf('"type"') === -1) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      continue;
    }
    const payload = record.payload;
    if (!payload) continue;

    const turnId =
      payload.turn_id || payload.turnId || payload.turn_attribution?.turn_id || null;

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      lastRunState = 'running';
      lastRunTurn = turnId;
      lastStartOffset = index;
    } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
      lastRunState = 'idle';
    } else if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
      // An aborted turn never emits task_complete, so without this the thread
      // would look "running" forever.
      lastRunState = 'idle';
    } else if (payload.type === 'item_completed' && payload.item?.id) {
      itemTurn.set(payload.item.id, turnId);
    }
  }

  const running = lastRunState === 'running';
  const items = [];

  if (running) {
    const tail = lines.slice(lastStartOffset + 1);
    for (const line of tail) {
      if (line.indexOf('"type"') === -1) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        continue;
      }
      const payload = record.payload;
      if (!payload || payload.type !== 'item_completed' || !payload.item) continue;
      items.push({ turnId: itemTurn.get(payload.item.id) || lastRunTurn, item: payload.item });
    }
  }

  return { state: lastRunState, running, turnId: lastRunTurn, items };
}

class RolloutWatcher {
  constructor({ rootDir = SESSIONS_ROOT, intervalMs = 2000 } = {}) {
    this.rootDir = rootDir;
    this.intervalMs = intervalMs;
    this.fileToThread = new Map();
    this.states = new Map();
    this.onState = null;
    this.timer = null;
    this.fsWatcher = null;
    this.pending = new Set();
    this.flushScheduled = false;
  }

  start(onState) {
    this.onState = onState;
    this._watchDirectory();
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this._poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch (error) {
        /* ignore */
      }
    }
  }

  _watchDirectory() {
    if (!fs.existsSync(this.rootDir)) return;
    try {
      this.fsWatcher = fs.watch(this.rootDir, { recursive: true }, (eventType, filename) => {
        if (!filename || !String(filename).endsWith('.jsonl')) return;
        const filePath = path.join(this.rootDir, String(filename));
        const threadId = threadIdFromRolloutPath(filePath);
        if (threadId) this._queue(threadId, filePath);
      });
      if (this.fsWatcher.unref) this.fsWatcher.unref();
    } catch (error) {
      this.fsWatcher = null;
    }
  }

  _discoverRecent() {
    const found = [];
    const now = Date.now();
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs < 5 * 60 * 1000) found.push(full);
          } catch (error) {
            /* ignore */
          }
        }
      }
    };
    walk(this.rootDir);
    return found;
  }

  _poll() {
    for (const filePath of this._discoverRecent()) {
      const threadId = threadIdFromRolloutPath(filePath);
      if (threadId) this._queue(threadId, filePath);
    }
  }

  _queue(threadId, filePath) {
    this.fileToThread.set(threadId, filePath);
    this.pending.add(threadId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this._flush();
    });
  }

  _flush() {
    const threadIds = [...this.pending];
    this.pending.clear();
    for (const threadId of threadIds) {
      const filePath = this.fileToThread.get(threadId);
      if (!filePath) continue;
      const snapshot = scanRollout(readTail(filePath));
      const previous = this.states.get(threadId);
      const changed =
        !previous ||
        previous.state !== snapshot.state ||
        previous.turnId !== snapshot.turnId ||
        previous.items.length !== snapshot.items.length;

      this.states.set(threadId, snapshot);
      if (changed && this.onState) this.onState(threadId, snapshot, previous || null);
    }
  }
}

module.exports = { RolloutWatcher, scanRollout, readTail, threadIdFromRolloutPath };
