'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const { AppServerConnection } = require('./appserver');
const { resolveCodexBinary, isBusyThreadError, isFreshThreadError, queueMessage } = require('./codex-cli');
const { RolloutWatcher } = require('./rollout');
const { tailscaleClientInfo, warmTailscaleStatus } = require('./tailscale');
const {
  normalizeMode,
  profileList,
  threadParams: permissionThreadParams,
  turnParams: permissionTurnParams,
  queueArgs: permissionQueueArgs,
  sandboxLabel,
  reviewerLabel,
  modeFromSettings,
  loadPermissionMap,
  savePermissionMap,
} = require('./permissions');

const COOKIE_NAME = 'codex_remote_token';
/* Give the rollout a moment to flush before handing the writer lock back. */
const RELEASE_DELAY_MS = 4000;
/* Grace period before the background sweep may hand a lock back. */
const LOAD_GRACE_MS = 15000;
const UPLOAD_DIR = path.join(os.homedir(), '.codex-remote', 'uploads');
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_PORT = 8787;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.codex-remote', 'token');
const DEFAULT_SOCKET = path.join(
  os.homedir(),
  '.codex',
  'app-server-control',
  'app-server-control.sock'
);
const DEFAULT_NAME_FILE = path.join(os.homedir(), '.codex-remote', 'name');
const DEFAULT_PERMISSION_FILE = path.join(os.homedir(), '.codex-remote', 'permissions.json');
/* turn/steer 的 expectedTurnId 对不上（这一轮刚好跑完、或者已经换轮了）时的报错都长这样；
   这些情况下引导没意义，退回正常发送即可。 */
const STEER_MISS_PATTERN = /expectedturnid|expected turn|no active turn|not active|turn not found|already (?:finished|completed)/i;
const BRIDGE_VERSION = '1.8.4';
/* 延时探测别被 Codex 的忙闲拖住：HTTP 最多等 350ms，超了先用上一次采样；
   采样 1.5 秒内算新鲜，不必重复问 daemon。 */
const DAEMON_PROBE_DEADLINE_MS = 350;
const DAEMON_SAMPLE_TTL_MS = 1500;
/* 临时会话的对话内容不落盘、也不支持 thread/read(includeTurns)，
   所以桥接层自己按序缓存它的事件，重开页面时前端再回放一遍。 */
const EPHEMERAL_EVENT_LIMIT = 4000;

/* 一次实测：某段会话 thread/read 回来 11MB，其中光 MCP 工具结果就有 4.7MB
   （联网搜索、文件读取，单条最大 65KB）。手机上 JSON.parse 这种体积要几百毫秒，
   而 6 秒一次的后台轮询还会反复付这笔钱 —— 表现就是「在输入框里打字特别卡」。
   所以桥接侧就把超长文本剪掉：保留开头和结尾（报错一般在结尾），中间省略。
   完整内容电脑上的 Codex 里还有，不影响那边的显示。 */
const SLIM_TOOL_RESULT_TEXT = 6000;
const SLIM_AGGREGATED_OUTPUT = 8000;
const SLIM_REASONING = 8000;
const SLIM_DIFF = 20000;
/* 兜底：结构里任何别的地方冒出超长字符串（比如内联的 base64 图）也不放过 */
const SLIM_ANY_STRING = 40000;
/* 默认只给手机最近这么多条记录，更早的靠前端「显示更早的」按需再拉。 */
const THREAD_ITEM_LIMIT = 500;
const THREAD_ITEM_LIMIT_MAX = 20000;

function clipForPhone(text, limit) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.5);
  const tail = limit - head;
  return (
    value.slice(0, head) +
    '\n…（已省略 ' +
    (value.length - limit) +
    ' 个字符，完整内容请在电脑上看）…\n' +
    value.slice(value.length - tail)
  );
}

function slimString(value, limit) {
  if (typeof value !== 'string') return value;
  return value.length > limit ? clipForPhone(value, limit) : value;
}

/* 结构里任何地方的超长字符串都剪一刀，防止以后新字段把 payload 撑爆 */
function slimLongStrings(value, depth) {
  if (depth > 8) return value;
  if (typeof value === 'string') return slimString(value, SLIM_ANY_STRING);
  if (Array.isArray(value)) {
    let changed = false;
    const copy = value.map((entry) => {
      const next = slimLongStrings(entry, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? copy : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = slimLongStrings(entry, depth + 1);
      if (next !== entry) changed = true;
      copy[key] = next;
    }
    return changed ? copy : value;
  }
  return value;
}

/* 只处理桥接自己发出去的那份拷贝，绝不改 daemon 传来的原对象。 */
function slimItemForPhone(item) {
  if (!item || typeof item !== 'object') return item;
  const out = Object.assign({}, item);

  if (typeof out.aggregatedOutput === 'string') {
    out.aggregatedOutput = slimString(out.aggregatedOutput, SLIM_AGGREGATED_OUTPUT);
  }
  if (Array.isArray(out.summary)) out.summary = out.summary.map((p) => slimString(p, SLIM_REASONING));
  if (out.type === 'reasoning' && Array.isArray(out.content)) {
    out.content = out.content.map((p) => slimString(p, SLIM_REASONING));
  }
  if (out.result && typeof out.result === 'object' && Array.isArray(out.result.content)) {
    out.result = Object.assign({}, out.result, {
      content: out.result.content.map((part) => {
        if (!part || typeof part !== 'object') return part;
        const copy = Object.assign({}, part);
        if (typeof copy.text === 'string') copy.text = slimString(copy.text, SLIM_TOOL_RESULT_TEXT);
        if (typeof copy.data === 'string') copy.data = slimString(copy.data, SLIM_TOOL_RESULT_TEXT);
        return copy;
      }),
    });
  }
  if (Array.isArray(out.changes)) {
    out.changes = out.changes.map((change) => {
      if (!change || typeof change !== 'object') return change;
      const copy = Object.assign({}, change);
      if (typeof copy.diff === 'string') copy.diff = slimString(copy.diff, SLIM_DIFF);
      return copy;
    });
  }
  return slimLongStrings(out, 0);
}

/* 只保留最近 limit 条记录：daemon 会把整段会话都给出来，31 分钟的会话实测
   2963 条，前端整块重画一次就是 10MB 的 DOM，手机上根本跟不上。 */
function limitThreadTurns(turns, limit) {
  const list = Array.isArray(turns) ? turns : [];
  let remaining = limit;
  let omitted = 0;
  const kept = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    /* 没有 items 字段的 turn（老会话的 bare read）原样留着，别当成「被裁掉」 */
    if (!Array.isArray(turn && turn.items)) {
      kept.unshift(turn);
      continue;
    }
    const items = turn.items;
    const keptItems = [];
    for (let j = items.length - 1; j >= 0; j -= 1) {
      if (remaining > 0) {
        keptItems.unshift(slimItemForPhone(items[j]));
        remaining -= 1;
      } else {
        omitted += 1;
      }
    }
    /* 整轮的记录都被挤出去了就不返回这个 turn */
    if (keptItems.length === 0) continue;
    kept.unshift(Object.assign({}, turn, { items: keptItems }));
  }
  return { turns: kept, omitted };
}

/* 流式通知里也带 item（item/started、item/completed），同样要剪一刀，
   否则一条 65KB 的工具结果照样会塞进手机内存。 */
function slimNotificationParams(params) {
  if (!params || typeof params !== 'object' || !params.item) return params;
  return Object.assign({}, params, { item: slimItemForPhone(params.item) });
}

function clampItemLimit(raw) {
  const value = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isFinite(value) || value <= 0) return THREAD_ITEM_LIMIT;
  return Math.min(value, THREAD_ITEM_LIMIT_MAX);
}

const CLIENT_ACCEPTS_GZIP = Symbol('clientAcceptsGzip');
/* 小于这个体积不值得压：gzip 对短 JSON 反而可能更大。 */
const GZIP_MIN_BYTES = 1024;

/* 手机上的「连接延时」经常高得离谱，根因多半不在程序里，而是手机走了
   Tailscale 之类的远端路径（本机实测过 relay "tok"，单程 200ms 起）。
   这里把客户端是从哪条路进来的算出来，界面才能给出「改用局域网地址」的提示。 */
function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function ipv4Octets(value) {
  const parts = String(value || '').replace(/^::ffff:/, '').split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function isLanIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  /* Clash / Surge 这类代理的 TUN fake-ip 段，落在这里说明是本机直连。 */
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/* Tailscale / CGNAT 段（100.64.0.0/10）。 */
function isTailscaleIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function classifyRemoteAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (!address) return 'unknown';
  if (address === '127.0.0.1' || address === '::1') return 'local';
  if (isTailscaleIpv4(address)) return 'tailscale';
  if (isLanIpv4(address)) return 'lan';
  return 'other';
}

/* 挑一个「真的在局域网里」的地址，跳过 Tailscale 和代理 TUN 的地址。 */
function preferredLanAddress(addresses) {
  const real = addresses.filter(
    (value) => isLanIpv4(value) && !isTailscaleIpv4(value) &&
      !/^198\.1[89]\./.test(value) && !/^169\.254\./.test(value)
  );
  return real[0] || null;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function parseArguments(argv) {
  const options = {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    socketPath: DEFAULT_SOCKET,
    tokenFile: DEFAULT_TOKEN_FILE,
    name: process.env.CODEX_REMOTE_NAME || '',
    nameFile: DEFAULT_NAME_FILE,
    permissionFile: DEFAULT_PERMISSION_FILE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--port' && next) {
      options.port = Number(next);
      index += 1;
    } else if (argument === '--host' && next) {
      options.host = next;
      index += 1;
    } else if (argument === '--socket' && next) {
      options.socketPath = next;
      index += 1;
    } else if (argument === '--token-file' && next) {
      options.tokenFile = next;
      index += 1;
    } else if (argument === '--name' && next) {
      options.name = next;
      index += 1;
    } else if (argument === '--name-file' && next) {
      options.nameFile = next;
      index += 1;
    } else if (argument === '--permission-file' && next) {
      options.permissionFile = next;
      index += 1;
    }
  }

  return options;
}

function roundMs(startedAt) {
  return Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 10) / 10;
}

/* Several machines can run this bridge at once; the name is what tells them
   apart in the browser tab and header. Precedence: --name / CODEX_REMOTE_NAME,
   then the persisted name file, then the machine's hostname. */
/* 手机上手打路径基本都会写 ~/…，而 path.resolve 不认 ~，会把 "~" 当成普通目录名，
   于是会话跑到 …/app/~/Documents/… 这种鬼地方，也就永远归不到项目底下。
   项目创建那里本来就展开了，这里抽出来给新建会话一起用。 */
function expandUserPath(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function sanitizeBridgeName(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function readBridgeName(options) {
  const fromOption = sanitizeBridgeName(options.name);
  if (fromOption) return fromOption;

  try {
    const fromFile = sanitizeBridgeName(fs.readFileSync(options.nameFile, 'utf8'));
    if (fromFile) return fromFile;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return sanitizeBridgeName(os.hostname().replace(/\.local$/i, '')) || 'Codex Remote';
}

function writeBridgeName(nameFile, name) {
  if (!nameFile) return;
  fs.mkdirSync(path.dirname(nameFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(nameFile, `${name}\n`, { mode: 0o600 });
}

function loadOrCreateToken(tokenFile) {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sniffImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if ((buffer[0] === 0x49 && buffer[1] === 0x49) || (buffer[0] === 0x4d && buffer[1] === 0x4d)) return 'image/tiff';
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return 'image/x-icon';
  return null;
}

function detectImageMime(buffer, ext) {
  const sniffed = sniffImageType(buffer);
  if (sniffed) return sniffed;
  if (ext === '.svg') return 'image/svg+xml';
  const generic = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
  return generic[ext] || null;
}

function sendJson(response, statusCode, payload) {
  /* 有些 daemon 方法（比如 turn/interrupt）成功时不带返回体，JSON.stringify(undefined)
     是 undefined，Buffer.from 会直接抛，结果把一个成功的操作报成 500。 */
  const raw = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  /* 一次完整会话读取实测 1.6MB，压完 424KB（level 4，约 14ms）——在中继链路上
     省下的是几秒的传输时间，值得用同步压缩换这点阻塞。 */
  if (response[CLIENT_ACCEPTS_GZIP] && raw.length >= GZIP_MIN_BYTES) {
    const compressed = zlib.gzipSync(raw, { level: 4 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    response.writeHead(statusCode, headers);
    response.end(compressed);
    return;
  }
  headers['Content-Length'] = raw.length;
  response.writeHead(statusCode, headers);
  response.end(raw);
}

async function readJsonBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

class Bridge {
  constructor(options) {
    this.options = options;
    this.token = loadOrCreateToken(options.tokenFile);
    this.bridgeName = readBridgeName(options);
    this.startedAt = Date.now();
    this.codexBinary = resolveCodexBinary();
    this.remoteTarget = options.socketPath === DEFAULT_SOCKET ? null : `unix://${options.socketPath}`;
    this.connection = null;
    this.connectionError = 'starting';
    this.notifications = null;
    this.eventClients = new Set();
    this.pendingApprovals = new Map();
    this.activeTurns = new Map();
    this.daemonTurnIds = new Set();
    /* Threads this bridge caused the daemon to load. The daemon keeps an
       exclusive writer lock on every loaded thread, which is what makes the
       desktop app report "already open in another app". We hand the lock back
       as soon as the thread goes idle. */
    this.loadedThreads = new Map();
    /* 手机端发起的「临时对话」：ephemeral 会话不写盘，所以它不会出现在
       thread/list 里，daemon 只把它记在当前连接的内存中。这里自己留一份
       索引，侧边栏才能把它列出来、也才知道发消息时不能去 resume。 */
    this.ephemeralThreads = new Map();
    /* 每个会话的权限档位（用户显式设置过的才在这里），存在 ~/.codex-remote/permissions.json */
    this.permissions = loadPermissionMap(options.permissionFile);
    /* daemon 报回来的「实际生效」设置，用来在电脑上改过之后仍然显示真实状态 */
    this.threadSettings = new Map();
    this.reconnectTimer = null;
    /* 最近一次「电脑 ↔ Codex」探测结果；busy 时拿它兜底，别让 /api/ping 跟着卡 */
    this.daemonLatency = null;
    this.daemonProbe = null;
    /* 探测失败（Codex 忙/卡住）之后先别连着再问，避免探测本身把 daemon 压得更忙 */
    this.daemonProbeBackoffUntil = 0;
    this.rollout = new RolloutWatcher();
    this.rollout.start((threadId, snapshot, previous) => this._handleRolloutState(threadId, snapshot, previous));
  }

  /* Codex 忙的时候（正跑着好几轮），thread/loaded/list 会被排在后面，三次探测
     可能要好几秒 —— 那是 Codex 忙，不是链路慢。探测放到后台跑（同一时间只有
     一份），HTTP 最多等 deadlineMs，等不到就用上一次的采样，数字照常更新。 */
  async _daemonLatencySample(deadlineMs) {
    /* 上一轮探测刚失败过：先用手里的旧采样，过几秒再试，别在 Codex 忙的时候添乱 */
    if (!this.daemonProbe && Date.now() < this.daemonProbeBackoffUntil && this.daemonLatency) {
      return null;
    }
    if (!this.daemonProbe) {
      const probe = (async () => {
        const samples = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const probeStart = process.hrtime.bigint();
          await this.connection.request('thread/loaded/list', {}, { timeoutMs: 1200 });
          samples.push(roundMs(probeStart));
        }
        return { ok: true, ms: Math.min(...samples), error: null, at: Date.now() };
      })()
        .catch((error) => ({ ok: false, ms: null, error: error.message, at: Date.now() }))
        .then((sample) => {
          if (sample.ok) {
            this.daemonLatency = sample;
            this.daemonProbeBackoffUntil = 0;
          } else {
            /* 保留上一次成功的采样，界面继续显示它；同时退避几秒 */
            this.daemonProbeBackoffUntil = Date.now() + 5000;
          }
          return sample;
        })
        .finally(() => {
          this.daemonProbe = null;
        });
      this.daemonProbe = probe;
    }
    const current = this.daemonProbe;
    let timer = null;
    try {
      return await Promise.race([
        current,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async start() {
    const server = http.createServer((request, response) => {
      this._handleRequest(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else response.end();
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, resolve);
    });

    /* Node 默认空闲 5 秒就关连接，而界面每 5 秒才探一次延时 —— 于是每次探测
       都得新建 TCP 连接，白白多一整个 RTT（远端路径上一两百毫秒）。把连接留热，
       探测数字才是真实往返，其它 API 调用也各少一个 RTT。 */
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;

    this.httpServer = server;
    this._connectToAppServer();

    this.releaseTimer = setInterval(() => {
      for (const threadId of [...this.loadedThreads.keys()]) {
        this.releaseThreadLock(threadId).catch(() => {});
      }
    }, 20000);

    const shutdown = () => {
      this.releaseAllThreadLocks().then(() => process.exit(0)).catch(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
  }

  _connectToAppServer() {
    const connection = new AppServerConnection(this.options.socketPath);
    this.connection = connection;

    connection.on('notification', (message) => this._handleNotification(message));
    connection.on('serverRequest', (message) => this._handleServerRequest(message));
    connection.on('error', (error) => {
      this.connectionError = error.message;
      this._broadcast({ type: 'status', connected: this.connection.ready, error: error.message });
    });
    connection.on('close', () => {
      this.connectionError = 'disconnected';
      this._broadcast({ type: 'status', connected: false, error: 'disconnected' });
      this._scheduleReconnect();
    });

    connection
      .connect()
      .then(() => {
        this.connectionError = null;
        this._broadcast({ type: 'status', connected: true, userAgent: connection.userAgent });
      })
      .catch((error) => {
        this.connectionError = error.message;
        this._broadcast({ type: 'status', connected: false, error: error.message });
        this._scheduleReconnect();
      });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectToAppServer();
    }, 3000);
  }

  rolloutRunningTurns() {
    const result = {};
    for (const [threadId, snapshot] of this.rollout.states) {
      if (snapshot.running) result[threadId] = snapshot.turnId || 'rollout-' + threadId;
    }
    return result;
  }

  _handleRolloutState(threadId, snapshot, previous) {
    const daemonOwns =
      this.activeTurns.has(threadId) ||
      (snapshot.turnId && this.daemonTurnIds.has(snapshot.turnId));
    if (daemonOwns) return;

    const syntheticTurn = {
      id: snapshot.turnId || 'rollout-' + threadId,
      rootTurnId: snapshot.turnId || 'rollout-' + threadId,
      items: [],
      status: snapshot.running ? 'inProgress' : 'completed',
      itemsView: snapshot.running ? 'notLoaded' : 'full',
      error: null,
    };

    const wasRunning = Boolean(previous && previous.running);
    if (snapshot.running && !wasRunning) {
      this._broadcast({ type: 'notification', method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
      this._broadcast({ type: 'notification', method: 'turn/started', params: { threadId, turn: syntheticTurn } });
    } else if (!snapshot.running && wasRunning) {
      this._broadcast({ type: 'notification', method: 'turn/completed', params: { threadId, turn: syntheticTurn } });
      this._broadcast({ type: 'notification', method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
    }
  }

  _handleNotification(message) {
    const params = message.params || {};

    const ephemeralEntry = params.threadId ? this.ephemeralThreads.get(params.threadId) : null;
    if (ephemeralEntry) {
      const events = ephemeralEntry.events || (ephemeralEntry.events = []);
      /* 存剪过的那一份：一条工具结果原始能到 65KB，4000 条事件全留着就是几百 MB
         的常驻内存，而发给手机端的本来就是剪过的。 */
      events.push({ method: message.method, params: slimNotificationParams(params) });
      if (events.length > EPHEMERAL_EVENT_LIMIT) events.splice(0, events.length - EPHEMERAL_EVENT_LIMIT);
    }

    if (message.method === 'turn/started' && params.threadId && params.turn?.id) {
      this.activeTurns.set(params.threadId, params.turn.id);
      this.daemonTurnIds.add(params.turn.id);
      if (this.ephemeralThreads.has(params.threadId)) this._rememberEphemeral(params.threadId);
    } else if (message.method === 'turn/completed' && params.threadId) {
      if (this.activeTurns.get(params.threadId) === params.turn?.id) {
        this.activeTurns.delete(params.threadId);
      }
      const threadId = params.threadId;
      if (this.ephemeralThreads.has(threadId)) this._rememberEphemeral(threadId);
      setTimeout(() => {
        this.releaseThreadLock(threadId).catch(() => {});
      }, RELEASE_DELAY_MS);
    } else if (message.method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? '');
      if (this.pendingApprovals.delete(requestId)) {
        this._broadcast({ type: 'approval-resolved', requestId });
      }
    } else if (message.method === 'thread/settings/updated' && params.threadId) {
      /* 电脑上改了模型/权限，这里跟着更新，手机上的档位显示才不会说谎 */
      this._recordThreadSettings(params.threadId, params.threadSettings);
      this._broadcast({
        type: 'permission',
        threadId: params.threadId,
        permission: this._permissionView(params.threadId),
      });
    }

    this._broadcast({
      type: 'notification',
      method: message.method,
      params: slimNotificationParams(message.params),
    });
  }

  _handleServerRequest(message) {
    const requestId = String(message.id);
    const record = {
      requestId,
      method: message.method,
      params: message.params ?? {},
      receivedAt: Date.now(),
    };
    this.pendingApprovals.set(requestId, record);
    this._broadcast({ type: 'approval', request: record });
  }

  _broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      try {
        client.write(payload);
      } catch (error) {
        this.eventClients.delete(client);
      }
    }
  }

  async _handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    response[CLIENT_ACCEPTS_GZIP] = /\bgzip\b/i.test(request.headers['accept-encoding'] || '');

    const urlToken = url.searchParams.get('token');
    if (urlToken !== null) {
      if (!safeEqual(urlToken, this.token)) {
        sendJson(response, 401, { error: 'invalid token' });
        return;
      }
      url.searchParams.delete('token');
      const location = `${url.pathname}${url.search}`;
      response.writeHead(302, {
        Location: location,
        'Set-Cookie': `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      });
      response.end();
      return;
    }

    if (!this._isAuthorized(request, url)) {
      sendJson(response, 401, { error: 'unauthorized', hint: 'open /?token=<token> once' });
      return;
    }

    if (url.pathname === '/events') {
      this._handleEventStream(request, response);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await this._handleApi(request, response, url);
      return;
    }

    this._serveStatic(response, url.pathname);
  }

  _isAuthorized(request, url) {
    const header = request.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const cookie = readCookie(request.headers.cookie, COOKIE_NAME);
    return (
      safeEqual(bearer, this.token) ||
      safeEqual(cookie, this.token) ||
      safeEqual(url.searchParams.get('token'), this.token)
    );
  }

  _handleEventStream(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    this.eventClients.add(response);
    const helloActiveTurns = Object.assign({}, this.activeTurns, this.rolloutRunningTurns());
    response.write(
      `data: ${JSON.stringify({
        type: 'hello',
        connected: Boolean(this.connection && this.connection.ready),
        userAgent: this.connection?.userAgent ?? null,
        error: this.connectionError,
        pendingApprovals: [...this.pendingApprovals.values()],
        activeTurns: helloActiveTurns,
      })}\n\n`
    );

    const heartbeat = setInterval(() => {
      try {
        response.write(': keepalive\n\n');
      } catch (error) {
        clearInterval(heartbeat);
      }
    }, 25000);

    request.on('close', () => {
      clearInterval(heartbeat);
      this.eventClients.delete(response);
    });
  }

  _markThreadLoaded(threadId) {
    if (threadId) this.loadedThreads.set(threadId, Date.now());
  }

  _rememberEphemeral(threadId, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.ephemeralThreads.get(threadId) || {};
    this.ephemeralThreads.set(threadId, Object.assign({}, existing, extra, {
      id: threadId,
      ephemeral: true,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }));
  }

  /* 临时会话在 thread/list 里不存在，这里把它拼回列表，侧边栏才看得到 */
  _mergeEphemeralThreads(threads) {
    if (this.ephemeralThreads.size === 0) return threads;
    const seen = new Set(threads.map((thread) => thread.id));
    const extras = [];
    for (const entry of this.ephemeralThreads.values()) {
      if (seen.has(entry.id)) continue;
      extras.push({
        id: entry.id,
        cwd: entry.cwd || '',
        name: entry.name || '',
        preview: entry.preview || '',
        ephemeral: true,
        status: this.activeTurns.has(entry.id) ? { type: 'active' } : { type: 'notLoaded' },
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return extras.concat(threads);
  }

  async releaseThreadLock(threadId, options = {}) {
    if (!threadId || !this.loadedThreads.has(threadId)) return false;
    /* 临时会话不写盘，archive/unarchive 那套放锁手法对它没有意义，
       而且它是桥接自己独占的，不需要把写锁让给桌面端。 */
    if (this.ephemeralThreads.has(threadId)) return false;
    if (this.activeTurns.has(threadId)) return false;
    /* Never yank the lock out from under an in-flight resume/turn-start pair. */
    if (!options.force && Date.now() - this.loadedThreads.get(threadId) < LOAD_GRACE_MS) return false;
    const snapshot = this.rollout.states.get(threadId);
    if (snapshot && snapshot.running) return false;
    if (!this.connection || !this.connection.ready) return false;

    this.loadedThreads.delete(threadId);
    try {
      await this.connection.request('thread/archive', { threadId });
      await this.connection.request('thread/unarchive', { threadId });
      console.log(`released writer lock for ${threadId}`);
      return true;
    } catch (error) {
      console.error(`failed to release writer lock for ${threadId}: ${error.message}`);
      return false;
    }
  }

  async releaseAllThreadLocks() {
    const ids = [...this.loadedThreads.keys()];
    for (const threadId of ids) {
      await this.releaseThreadLock(threadId, { force: true });
    }
  }

  _requireConnection() {
    if (!this.connection || !this.connection.ready) {
      const error = new Error(
        `app-server not connected (${this.connectionError || 'unknown'}). Start it with: codex app-server daemon start`
      );
      error.statusCode = 503;
      throw error;
    }
    return this.connection;
  }

  /* A thread that has never been named nor run has no turns in the daemon index
     yet, and `thread/read` with turns fails with "list_turns is not supported
     yet". Fall back to the turn-less read so brand new chats still open. */
  /* daemon 侧实际生效的权限设置。thread/start、thread/resume 的返回值和
     thread/settings/updated 通知里都有，攒起来给手机显示真实状态。 */
  _recordThreadSettings(threadId, settings) {
    if (!threadId || !settings) return;
    const merged = Object.assign({}, this.threadSettings.get(threadId), settings);
    this.threadSettings.set(threadId, merged);
  }

  _permissionView(threadId) {
    const mode = this.permissions[threadId] || 'default';
    const settings = this.threadSettings.get(threadId) || null;
    return {
      mode,
      effective: settings
        ? {
            approvalPolicy: settings.approvalPolicy || null,
            sandbox: sandboxLabel(settings.sandbox || settings.sandboxPolicy),
            reviewer: reviewerLabel(settings.approvalsReviewer),
            mode: modeFromSettings(settings),
          }
        : null,
    };
  }

  _setPermission(threadId, mode) {
    const normalized = normalizeMode(mode);
    if (normalized === 'default') delete this.permissions[threadId];
    else this.permissions[threadId] = normalized;
    try {
      savePermissionMap(this.options.permissionFile, this.permissions);
    } catch (error) {
      /* 落盘失败不该拦住这次设置，内存里已经生效 */
    }
    return this._permissionView(threadId);
  }

  /* 内存里的 activeTurns 只是缓存：daemon 不一定每次都发 turn/completed（实测被中断
     的那一轮就没有），漏一次这里就会一直以为会话还在跑，引导/中断和「跑完自动发」都会
     卡住。每次真读会话都拿服务端的 turn 状态校准一次。 */
  _reconcileActiveTurn(threadId, turns) {
    /* 空数组说明这次读压根没带 turn 信息（临时会话不支持 includeTurns、老会话
       "list_turns is not supported yet"），不能当成「没在跑」——否则会把正在跑的
       会话误判成空闲，引导会退化成再开一轮，两个 turn 并行。 */
    if (!threadId || !Array.isArray(turns) || turns.length === 0) return;
    const running = [...turns].reverse().find((turn) => turn && turn.status === 'inProgress');
    if (running && running.id) this.activeTurns.set(threadId, running.id);
    else if (!running) this.activeTurns.delete(threadId);
  }

  async _readThread(threadId) {
    try {
      const result = await this.connection.request('thread/read', { threadId, includeTurns: true });
      this._reconcileActiveTurn(threadId, result && result.thread && result.thread.turns);
      return result;
    } catch (error) {
      const message = error && error.message ? error.message : '';
      /* 两种情况都要退回「不带 turn」的读取：老会话报 "list_turns is not
         supported yet"，临时会话报 "ephemeral threads do not support
         includeTurns"。临时会话的 turn 由 _mergeEphemeralEvents 之外的事件
         日志补回（见 GET /api/threads/:id）。 */
      if (!/not supported/i.test(message) && !/do not support/i.test(message)) throw error;
      const bare = await this.connection.request('thread/read', { threadId });
      return Object.assign({}, bare, {
        thread: Object.assign({}, bare && bare.thread, {
          turns: (bare && bare.thread && bare.thread.turns) || [],
        }),
      });
    }
  }

  async _handleApi(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      if (segments[1] === 'meta' && segments.length === 2) {
        if (request.method === 'GET') {
          sendJson(response, 200, {
            name: this.bridgeName,
            hostname: os.hostname(),
            host: os.hostname().replace(/\.local$/i, ''),
            platform: process.platform,
            version: BRIDGE_VERSION,
            startedAt: this.startedAt,
            connected: Boolean(this.connection && this.connection.ready),
          });
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request, 8 * 1024);
          const name = sanitizeBridgeName(body.name);
          if (!name) {
            sendJson(response, 400, { error: 'name is required' });
            return;
          }
          try {
            writeBridgeName(this.options.nameFile, name);
          } catch (error) {
            sendJson(response, 500, { error: 'could not persist name: ' + error.message });
            return;
          }
          this.bridgeName = name;
          sendJson(response, 200, { ok: true, name });
          return;
        }
      }

      if (segments[1] === 'status' && segments.length === 2) {
        sendJson(response, 200, {
          connected: Boolean(this.connection && this.connection.ready),
          userAgent: this.connection?.userAgent ?? null,
          socketPath: this.options.socketPath,
          error: this.connectionError,
        });
        return;
      }

      /* 给手机端的「连接延时」按钮用：一次请求同时量出浏览器↔桥接和桥接↔Codex 两段。
         thread/loaded/list 是最便宜的调用（无副作用、通常 1ms 以内），适合当探针。 */
      if (segments[1] === 'ping' && segments.length === 2 && request.method === 'GET') {
        const startedAt = process.hrtime.bigint();
        const payload = {
          ok: true,
          now: Date.now(),
          version: BRIDGE_VERSION,
          connected: Boolean(this.connection && this.connection.ready),
          clients: this.eventClients.size,
          daemon: { ok: false, ms: null, error: null },
        };
        if (payload.connected) {
          const cached = this.daemonLatency;
          if (cached && Date.now() - cached.at < DAEMON_SAMPLE_TTL_MS) {
            payload.daemon = {
              ok: cached.ok,
              ms: cached.ms,
              error: cached.error,
              cached: false,
              busy: false,
            };
          } else {
            /* 连着问三次取最小值：单次调用偶尔会被 daemon 的其它活儿拖慢，
               这不是链路延时，取最小值更接近真实往返。等不到就用上次的。 */
            const sample = await this._daemonLatencySample(DAEMON_PROBE_DEADLINE_MS);
            if (sample && sample.ok) {
              payload.daemon = { ok: true, ms: sample.ms, error: null, cached: false };
            } else if (cached) {
              /* 这次没测到（Codex 忙 / 探测卡住）：显示上次的，并标明「忙」，
                 别让界面误报成 Codex 掉线 */
              payload.daemon = {
                ok: true,
                ms: cached.ms,
                error: null,
                cached: true,
                busy: !(sample && sample.ok),
              };
            } else {
              payload.daemon = {
                ok: false,
                ms: null,
                error: (sample && sample.error) || 'Codex 正忙，稍后再测',
                cached: false,
                busy: true,
              };
            }
          }
        } else {
          payload.daemon.error = this.connectionError || 'app-server not connected';
        }
        /* 手机是从哪条路进来的。走 tailscale 且不是局域网时，顺手给出局域网直连地址
           （带 token，点一下就能免重新登录切过去）。 */
        const remoteAddress = request.socket?.remoteAddress || null;
        const path = classifyRemoteAddress(remoteAddress);
        const lanAddress = preferredLanAddress(localAddresses());
        payload.client = {
          ip: remoteAddress,
          path,
          lanAddress,
          lanUrl:
            lanAddress && path !== 'lan' && path !== 'local'
              ? `http://${lanAddress}:${this.options.port}/?token=${this.token}`
              : null,
        };
        /* 只看 IP 段分不出「Tailscale 直连」和「DERP 中继」；走 Tailscale 时
           顺便读一下 Peer 的真实状态，界面才能说清楚该不该继续折腾。 */
        if (path === 'tailscale') {
          payload.client.tailscale = tailscaleClientInfo(remoteAddress);
        }
        /* 服务端自己处理这次请求花了多久：手机端用它把「链路往返」从总耗时里减掉，
           免得 Codex 一忙，连链路延时也跟着看起来变高。 */
        payload.serverMs = roundMs(startedAt);
        sendJson(response, 200, payload);
        return;
      }

      if (segments[1] === 'upload' && segments.length === 2 && request.method === 'POST') {
        const body = await readJsonBody(request, 32 * 1024 * 1024);
        const dataUrl = String(body.dataUrl || '');
        const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
        if (!match) {
          sendJson(response, 400, { error: 'dataUrl must be a base64 image' });
          return;
        }
        const mime = match[1].toLowerCase();
        const buffer = Buffer.from(match[2], 'base64');
        const ext = detectImageMime(buffer, IMAGE_EXT[mime] || '');
        if (!ext) {
          sendJson(response, 415, { error: 'unsupported or invalid image' });
          return;
        }
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const file = path.join(UPLOAD_DIR, `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${IMAGE_EXT[mime] || '.png'}`);
        fs.writeFileSync(file, buffer);
        sendJson(response, 200, { path: file, bytes: buffer.length, mime });
        return;
      }

      if (segments[1] === 'file' && segments.length === 2 && request.method === 'GET') {
        this._serveImage(request, response, url);
        return;
      }

      /* 档位设置不需要连着 daemon，先把它们处理掉 */
      if (segments[1] === 'permissions' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { profiles: profileList(), modes: this.permissions });
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'permissions' && request.method === 'POST') {
        const body = await readJsonBody(request, 8 * 1024);
        const permission = this._setPermission(segments[2], body.mode);
        /* 立刻生效靠的是下一条消息（_deliverMessage 会把档位带下去）；
           这里只回执，不去 resume——否则会抢走电脑的写锁。 */
        sendJson(response, 200, Object.assign({ ok: true }, permission));
        return;
      }

      const connection = this._requireConnection();

      if (segments[1] === 'new-thread' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        const mode = normalizeMode(body.permission);
        /* 临时对话 = daemon 的 ephemeral 会话：不落盘、不进历史，关掉就没了 */
        const ephemeral = body.ephemeral === true;
        const requested = expandUserPath(body.cwd);
        let cwd = requested ? path.resolve(requested) : path.join(os.homedir(), 'Documents', 'Codex', 'chat');
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (error) {
          /* 用户自己填的路径建不出来就说清楚；默默丢到 home 目录只会让人更困惑 */
          if (requested) {
            const failure = new Error(`工作文件夹不可用：${cwd}（${error.message}）`);
            failure.statusCode = 400;
            throw failure;
          }
          cwd = os.homedir();
        }
        const created = await connection.request(
          'thread/start',
          Object.assign({ cwd }, ephemeral ? { ephemeral: true } : {}, permissionThreadParams(mode))
        );
        const threadId = created?.thread?.id;
        this._markThreadLoaded(threadId);
        if (!threadId) {
          const error = new Error('thread/start did not return a thread id');
          error.statusCode = 502;
          throw error;
        }
        if (ephemeral) this._rememberEphemeral(threadId, { cwd, name });
        if (mode !== 'default') this._setPermission(threadId, mode);
        this._recordThreadSettings(threadId, created);
        if (name) {
          try {
            await connection.request('thread/name/set', { threadId, name });
          } catch (error) {
            /* naming is best-effort */
          }
        }
        /* Nothing is running in a brand new chat, so the writer lock can go
           back right away and the desktop app can open it immediately.
           临时会话桌面端看不到，写锁自己留着。 */
        if (!ephemeral) await this.releaseThreadLock(threadId, { force: true });
        sendJson(response, 200, { thread: Object.assign({}, created.thread, name ? { name } : {}) });
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'name' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        if (!name) {
          sendJson(response, 400, { error: 'name is required' });
          return;
        }
        const result = await connection.request('thread/name/set', { threadId: segments[2], name });
        sendJson(response, 200, Object.assign({ ok: true, name }, result || {}));
        return;
      }

      if (segments[1] === 'threads' && segments.length === 2 && request.method === 'GET') {
        const params = {
          limit: Number(url.searchParams.get('limit') || 30),
          archived: url.searchParams.get('archived') === 'true',
        };
        const searchTerm = url.searchParams.get('search');
        if (searchTerm) params.searchTerm = searchTerm;
        const cursor = url.searchParams.get('cursor');
        if (cursor) params.cursor = cursor;
        const result = await connection.request('thread/list', params);
        const data = this._mergeEphemeralThreads(Array.isArray(result.data) ? result.data : []);
        sendJson(response, 200, Object.assign({}, result, { data }));
        return;
      }

      /* 项目 = daemon 里的一份 {name, roots[]} 记录；会话按 cwd 落在项目根目录下。
         桌面端侧边栏的「项目」分组就是这个。 */
      if (segments[1] === 'projects' && segments.length === 2) {
        if (request.method === 'GET') {
          const result = await connection.request('project/list', {});
          sendJson(response, 200, { data: Array.isArray(result.data) ? result.data : [] });
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
          const raw = typeof body.path === 'string' ? body.path.trim() : '';
          if (!name) {
            sendJson(response, 400, { error: 'name is required' });
            return;
          }
          if (!raw) {
            sendJson(response, 400, { error: 'path is required' });
            return;
          }
          const rootPath = path.resolve(expandUserPath(raw));
          const created = await connection.request('project/create', {
            name,
            roots: [{ path: rootPath }],
            idempotencyKey: crypto.randomUUID(),
          });
          sendJson(response, 200, created);
          return;
        }
      }

      /* 结束临时对话：daemon 那边它本来就是内存里的，断开即可；这里把它从
         侧边栏索引里摘掉。 */
      if (segments[1] === 'ephemeral' && segments[2] === 'close' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const threadId = String(body.threadId || '');
        this.ephemeralThreads.delete(threadId);
        this.activeTurns.delete(threadId);
        try {
          await connection.request('thread/unsubscribe', { threadId });
        } catch (error) {
          /* best-effort：daemon 侧不是所有版本都支持 */
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (segments[1] === 'threads' && segments.length === 3 && request.method === 'GET') {
        const threadId = segments[2];
        const ephemeralEntry = this.ephemeralThreads.get(threadId);
        const result = await this._readThread(threadId);
        const limit = clampItemLimit(url.searchParams.get('limit'));
        const trimmed = limitThreadTurns(result && result.thread && result.thread.turns, limit);
        const trimmedResult = Object.assign({}, result, {
          thread: Object.assign({}, result && result.thread, {
            turns: trimmed.turns,
            omittedItems: trimmed.omitted,
          }),
        });
        const payload = Object.assign({}, trimmedResult, {
          permission: this._permissionView(threadId),
        });
        if (ephemeralEntry) {
          /* daemon 读不回临时会话的内容，把桥接缓存的事件一并交给前端回放 */
          payload.events = (ephemeralEntry.events || []).map((entry) =>
            Object.assign({}, entry, { params: slimNotificationParams(entry.params) })
          );
          if (ephemeralEntry.name && !(payload.thread && payload.thread.name)) {
            payload.thread = Object.assign({}, payload.thread, { name: ephemeralEntry.name });
          }
        }
        sendJson(
          response,
          200,
          payload
        );
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'message' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const threadId = segments[2];
        const text = String(body.text ?? '').trim();
        const images = Array.isArray(body.images)
          ? body.images.filter((value) => typeof value === 'string' && value.length > 0).slice(0, 8)
          : [];
        if (!text && images.length === 0) {
          sendJson(response, 400, { error: 'text or images are required' });
          return;
        }
        const outcome = await this._deliverMessage(threadId, text, images, { steer: body.steer === true });
        sendJson(response, 200, outcome);
        return;
      }

      if (segments[1] === 'threads' && segments[3] === 'interrupt' && request.method === 'POST') {
        const threadId = segments[2];
        const turnId = await this._activeTurnId(threadId);
        if (!turnId) {
          sendJson(response, 409, { error: 'no active turn for this thread' });
          return;
        }
        try {
          const result = await connection.request('turn/interrupt', { threadId, turnId });
          this.activeTurns.delete(threadId);
          sendJson(response, 200, result);
        } catch (error) {
          const message = error && error.message ? error.message : '';
          if (/active writer|thread not found/i.test(message)) {
            sendJson(response, 409, {
              error: '这个会话正在电脑上运行，执行在电脑进程里，手机暂时无法中断；请在电脑上点停止。',
            });
          } else {
            throw error;
          }
        }
        return;
      }

      if (segments[1] === 'approvals' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { data: [...this.pendingApprovals.values()] });
        return;
      }

      if (segments[1] === 'approvals' && segments[3] === 'respond' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const result = this._respondToApproval(segments[2], body);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  }

  /* 这一轮正在跑的 turn id：内存里有就用内存的，没有再读会话找 inProgress 的那轮。
     interrupt 和 steer 都要先知道「现在跑的是哪一轮」。 */
  async _activeTurnId(threadId) {
    const cached = this.activeTurns.get(threadId);
    if (cached) return cached;
    const read = await this._readThread(threadId);
    const turns = read?.thread?.turns ?? [];
    const active = [...turns].reverse().find((turn) => turn.status === 'inProgress');
    if (active?.id) this.activeTurns.set(threadId, active.id);
    return active?.id ?? null;
  }

  async _deliverMessage(threadId, text, imagePaths, options) {
    const connection = this._requireConnection();
    const images = Array.isArray(imagePaths) ? imagePaths : [];
    const mode = this.permissions[threadId] || 'default';
    const input = [];
    if (text) input.push({ type: 'text', text });
    for (const imagePath of images) input.push({ type: 'localImage', path: imagePath });

    /* 「引导」：不新开一轮，把这条输入塞进正在跑的那一轮，让它立刻改按新输入走。
       前提是本地知道当前轮的 id（turn/steer 要 expectedTurnId 对得上）；这一轮刚好
       跑完、或者 daemon 不认这个方法，就退回下面正常的发送流程。 */
    if (options && options.steer) {
      const activeTurnId = await this._activeTurnId(threadId);
      if (activeTurnId) {
        try {
          const result = await connection.request('turn/steer', {
            threadId,
            expectedTurnId: activeTurnId,
            input,
          });
          return {
            mode: 'steered',
            turnId: activeTurnId,
            turn: result?.turn ?? null,
            images: images.length,
          };
        } catch (error) {
          if (!isBusyThreadError(error) && !STEER_MISS_PATTERN.test(error.message || '')) throw error;
          this.activeTurns.delete(threadId);
        }
      }
    }

    /* resume 把档位写到会话设置上（电脑上打开同一个会话也会看到同样的权限），
       turn/start 再带上一次，保证当前这一轮就是用这个档位跑的。 */
    /* 临时会话没有 rollout，resume 必然报 "no rollout found"，跳过它直接开跑。 */
    const ephemeral = this.ephemeralThreads.has(threadId);
    const resumeError = ephemeral
      ? null
      : await this._resumeThread(threadId, permissionThreadParams(mode));
    let busyError = resumeError && !isFreshThreadError(resumeError) ? resumeError : null;

    if (!busyError) {
      try {
        const result = await connection.request(
          'turn/start',
          Object.assign({ threadId, input }, permissionTurnParams(mode))
        );
        if (result?.turn?.id) this.activeTurns.set(threadId, result.turn.id);
        return { mode: 'started', turn: result?.turn ?? null, images: images.length };
      } catch (error) {
        if (!isBusyThreadError(error)) throw error;
        busyError = error;
      }
    }

    if (!isBusyThreadError(busyError)) throw busyError;

    if (ephemeral) {
      const error = new Error('临时对话不能排队，等这一轮跑完再发。');
      error.statusCode = 409;
      throw error;
    }

    if (images.length > 0) {
      const error = new Error('这个会话正在电脑上运行，带图片的消息暂时无法排队；等它跑完再发。');
      error.statusCode = 409;
      throw error;
    }

    try {
      const queued = await queueMessage({
        binary: this.codexBinary,
        threadId,
        text,
        remote: this.remoteTarget,
        permissionArgs: permissionQueueArgs(mode),
      });
      return { mode: 'queued', queueId: queued.queueId, reason: busyError.message };
    } catch (error) {
      const wrapped = new Error(
        `这个会话正在电脑上运行，且排队失败：${error.message}。等它跑完再发，或直接在电脑上操作。`
      );
      wrapped.statusCode = 409;
      throw wrapped;
    }
  }

  async _resumeThread(threadId, extraParams) {
    try {
      const result = await this.connection.request(
        'thread/resume',
        Object.assign({ threadId, excludeTurns: true }, extraParams || {})
      );
      this._markThreadLoaded(threadId);
      this._recordThreadSettings(threadId, result);
      return null;
    } catch (error) {
      return error;
    }
  }

  _respondToApproval(requestId, body) {
    const record = this.pendingApprovals.get(String(requestId));
    if (!record) {
      const error = new Error('no pending approval with that id');
      error.statusCode = 404;
      throw error;
    }

    const result = this._buildApprovalResult(record, body);
    this.connection.respond(Number(record.requestId), result);
    this.pendingApprovals.delete(String(requestId));
    this._broadcast({ type: 'approval-resolved', requestId: String(requestId) });
    return { ok: true, response: result };
  }

  _buildApprovalResult(record, body) {
    const method = record.method;

    if (method === 'item/tool/requestUserInput') {
      return { answers: body.answers ?? {} };
    }

    if (method === 'item/permissions/requestApproval') {
      const result = { permissions: body.permissions ?? {} };
      if (body.scope) result.scope = body.scope;
      return result;
    }

    if (method === 'mcpServer/elicitation/request') {
      return { action: body.action ?? 'decline', content: body.content ?? null };
    }

    const decision = String(body.decision ?? '');

    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      return { decision: this._toLegacyDecision(decision, body) };
    }

    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
      const error = new Error(`unsupported decision: ${decision}`);
      error.statusCode = 400;
      throw error;
    }
    return { decision };
  }

  _toLegacyDecision(decision, body) {
    if (decision === 'accept') return 'approved';
    if (decision === 'acceptForSession') return 'approved_for_session';
    if (decision === 'cancel') return 'abort';
    return { denied: { rejection: String(body.reason ?? '') } };
  }

  _serveImage(request, response, url) {
    const requested = url.searchParams.get('path');
    if (!requested) {
      sendJson(response, 400, { error: 'path is required' });
      return;
    }
    let candidate = requested;
    if (!path.isAbsolute(candidate)) {
      const cwd = url.searchParams.get('cwd');
      if (!cwd || !path.isAbsolute(cwd)) {
        sendJson(response, 400, { error: 'relative path requires an absolute cwd' });
        return;
      }
      candidate = path.resolve(cwd, candidate);
    }

    fs.readFile(candidate, (error, content) => {
      if (error) {
        sendJson(response, 404, { error: 'cannot read file' });
        return;
      }
      const mime = detectImageMime(content, path.extname(candidate).toLowerCase());
      if (!mime) {
        sendJson(response, 415, { error: 'not an image' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=60',
        'Content-Length': content.length,
      });
      response.end(content);
    });
  }

  _serveStatic(response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relative);

    if (!resolved.startsWith(PUBLIC_DIR)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }

    fs.readFile(resolved, (error, content) => {
      if (error) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bridge = new Bridge(options);
  await bridge.start();
  /* 预热一下，手机第一次打开延时面板时不用等 CLI 启动。 */
  warmTailscaleStatus();

  /* 局域网地址排前面：手机该用这个，走 Tailscale 中继会慢一个数量级。 */
  const lan = preferredLanAddress(localAddresses());
  const addresses = localAddresses().sort((left, right) => {
    if (left === lan) return -1;
    if (right === lan) return 1;
    if (isTailscaleIpv4(left) !== isTailscaleIpv4(right)) return isTailscaleIpv4(left) ? 1 : -1;
    return 0;
  });

  console.log('Codex Remote bridge running');
  console.log(`  app-server socket : ${options.socketPath}`);
  console.log(`  listening         : http://${options.host}:${options.port}`);
  console.log(`  token file        : ${options.tokenFile}`);
  console.log('');
  console.log('Open one of these on your phone (once, to set the cookie):');
  if (addresses.length === 0) {
    console.log(`  http://<this-mac-lan-ip>:${options.port}/?token=${bridge.token}`);
  } else {
    for (const address of addresses) {
      console.log(`  http://${address}:${options.port}/?token=${bridge.token}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { Bridge, parseArguments, loadOrCreateToken };
