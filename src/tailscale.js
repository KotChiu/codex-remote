'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/* GUI 版 Tailscale 的 CLI 不在 PATH 里；先试常见位置，再退回 PATH。
   也可以用 TAILSCALE_CLI 显式指定。 */
const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];
const STATUS_TIMEOUT_MS = 2500;
const STATUS_TTL_MS = 10000;

let resolvedCli;
let cache = { at: 0, value: null, pending: null };

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function resolveOnPath(name) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function findTailscaleCli() {
  if (resolvedCli !== undefined) return resolvedCli;
  const explicit = process.env.TAILSCALE_CLI;
  const candidates = explicit ? [explicit, ...CLI_CANDIDATES] : CLI_CANDIDATES;
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) {
      resolvedCli = candidate;
      return resolvedCli;
    }
  }
  resolvedCli = resolveOnPath('tailscale');
  return resolvedCli;
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '').split('%')[0];
}

function summarizeStatus(payload) {
  const self = payload && payload.Self ? payload.Self : {};
  const selfIps = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(normalizeIp) : [];
  const peers = [];
  for (const peer of Object.values((payload && payload.Peer) || {})) {
    if (!peer || typeof peer !== 'object') continue;
    const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.map(normalizeIp) : [];
    peers.push({
      name: String(peer.HostName || peer.DNSName || ips[0] || 'tailscale peer'),
      ips,
      online: Boolean(peer.Online),
      /* CurAddr 非空 = 已经打通直连；PeerRelay 非空 = 走自己的中继服务器；
         只有 Relay 就是 DERP 中继。 */
      direct: Boolean(peer.CurAddr) && !peer.PeerRelay,
      endpoint: peer.CurAddr || null,
      peerRelay: peer.PeerRelay || null,
      relay: peer.Relay || null,
    });
  }
  return {
    version: payload && payload.Version ? String(payload.Version) : null,
    backendState: payload && payload.BackendState ? String(payload.BackendState) : null,
    self: {
      name: String(self.HostName || self.DNSName || ''),
      ips: selfIps,
    },
    peers,
  };
}

function readStatus() {
  const cli = findTailscaleCli();
  if (!cli) {
    return Promise.resolve({ available: false, error: 'tailscale CLI not found' });
  }
  return new Promise((resolve) => {
    execFile(
      cli,
      ['status', '--json'],
      { timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim();
          const message = error.killed
            ? 'tailscale status timed out'
            : detail || error.message || 'tailscale status failed';
          resolve({ available: false, error: message });
          return;
        }
        try {
          const text = String(stdout || '').trim();
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          const parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
          resolve(Object.assign({ available: true }, summarizeStatus(parsed)));
        } catch (parseError) {
          resolve({ available: false, error: 'invalid tailscale status JSON' });
        }
      }
    );
  });
}

/* 不阻塞 /api/ping：先返回上一次的缓存，过期后在后台刷新。
   这样即使 Tailscale CLI 卡住，延时测量也不会被拖慢。 */
function cachedStatus() {
  if (cache.value && Date.now() - cache.at < STATUS_TTL_MS) return cache.value;
  if (!cache.pending) {
    cache.pending = readStatus()
      .then((value) => {
        cache.value = value;
        cache.at = Date.now();
        return value;
      })
      .finally(() => {
        cache.pending = null;
      });
  }
  return cache.value;
}

function warmTailscaleStatus() {
  cachedStatus();
}

function tailscaleClientInfo(address) {
  const ip = normalizeIp(address);
  const status = cachedStatus();
  if (!status) return { available: false, pending: true };
  if (!status.available) return { available: false, error: status.error };

  const info = {
    available: true,
    version: status.version,
    backendState: status.backendState,
  };
  if (status.self.ips.includes(ip)) {
    info.self = true;
    return info;
  }
  const peer = status.peers.find((entry) => entry.ips.includes(ip));
  if (!peer) return info;
  info.peer = {
    name: peer.name,
    online: peer.online,
    direct: peer.direct,
    endpoint: peer.endpoint,
    peerRelay: peer.peerRelay,
    relay: peer.relay,
  };
  return info;
}

module.exports = {
  findTailscaleCli,
  normalizeIp,
  summarizeStatus,
  tailscaleClientInfo,
  warmTailscaleStatus,
};
