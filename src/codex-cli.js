'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUSY_PATTERN = /active writer|already running|thread not found/i;

function resolveCodexBinary() {
  if (process.env.CODEX_REMOTE_CODEX) return process.env.CODEX_REMOTE_CODEX;

  const pathEntries = (process.env.PATH || '').split(':').filter(Boolean);
  const candidates = [
    ...pathEntries.map((entry) => path.join(entry, 'codex')),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.codex', 'bin', 'codex'),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      continue;
    }
  }
  return 'codex';
}

function isBusyThreadError(error) {
  return Boolean(error && BUSY_PATTERN.test(error.message || ''));
}

/* A thread that has not persisted a turn yet cannot be resumed, but it can be
   started: turn/start works fine on it. */
const FRESH_PATTERN = /no rollout found|list_turns is not supported/i;

function isFreshThreadError(error) {
  return Boolean(error && FRESH_PATTERN.test(error.message || ''));
}

function resolveSandboxMode() {
  const mode = process.env.CODEX_REMOTE_SANDBOX || 'danger-full-access';
  return mode;
}

function queueMessage({ binary, threadId, text, remote, permissionArgs, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const args = ['queue', '--thread', threadId, '--message', text];
    /* 手机上给这个会话选过权限档位就按它来；没选过就沿用原来的默认。 */
    if (Array.isArray(permissionArgs) && permissionArgs.length > 0) args.push(...permissionArgs);
    else args.push('--sandbox', resolveSandboxMode());
    if (remote) args.push('--remote', remote);

    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('queueing timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `codex queue exited ${code}`).trim().slice(0, 400)));
        return;
      }
      const match = /Queued message ([0-9a-f-]+)/i.exec(stdout);
      resolve({ queueId: match ? match[1] : null, output: stdout.trim() });
    });
  });
}

module.exports = { resolveCodexBinary, isBusyThreadError, isFreshThreadError, queueMessage };
