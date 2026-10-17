'use strict';

const state = {
  connected: false,
  bridgeName: '',
  bridgeMeta: null,
  bridgeVersion: null,
  versionNotice: false,
  connectionError: null,
  userAgent: null,
  threads: [],
  currentThreadId: null,
  thread: null,
  turns: [],
  pendingApprovals: new Map(),
  activeTurns: {},
  pendingEchoes: [],
  attachments: [],
  drafts: new Map(),
  /* 运行中按「发送」的消息不立刻发出去，先挂在这（threadId → 待发列表），
     等这一轮跑完自动发；点列表里那条的「引导」就插进正在跑的这一轮。 */
  pending: {},
  flushing: {},
  lastEventAt: 0,
  pinned: [],
  shelvedThreads: [],
  turnDiffs: new Map(),
  planSteps: new Map(),
  pinnedToBottom: true,
  renderScheduled: false,
  latency: null,
  permissionProfiles: [],
  threadModes: {},
  permission: null,
  theme: 'auto',
  /* 一次跟电脑要多少条记录（桥接默认给最近 500 条）。更早的点「显示更早的」再加。 */
  itemLimit: 500,
  omittedItems: 0,
  runStarted: null,
  projects: [],
  collapsedGroups: [],
  foldingEvents: false,
};

const dom = {
  sidebar: document.getElementById('sidebar'),
  sidebarBrand: document.getElementById('sidebar-brand'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarClose: document.getElementById('sidebar-close'),
  sidebarRefresh: document.getElementById('sidebar-refresh'),
  scrim: document.getElementById('scrim'),
  refreshButton: document.getElementById('refresh-button'),
  themeButton: document.getElementById('theme-button'),
  composerLatency: document.getElementById('composer-latency'),
  composerLatencyDot: document.getElementById('composer-latency-dot'),
  composerLatencyIcon: document.getElementById('composer-latency-icon'),
  composerLatencyText: document.getElementById('composer-latency-text'),
  latencyPanel: document.getElementById('latency-panel'),
  latencyLan: document.getElementById('latency-lan'),
  latencyDaemon: document.getElementById('latency-daemon'),
  latencyPath: document.getElementById('latency-path'),
  latencyStream: document.getElementById('latency-stream'),
  latencyAt: document.getElementById('latency-at'),
  latencyVersion: document.getElementById('latency-version'),
  latencyHint: document.getElementById('latency-hint'),
  newChatButton: document.getElementById('new-chat-button'),
  newChatModal: document.getElementById('new-chat-modal'),
  newChatName: document.getElementById('new-chat-name'),
  newChatCwd: document.getElementById('new-chat-cwd'),
  newChatPin: document.getElementById('new-chat-pin'),
  newChatHeading: document.getElementById('new-chat-heading'),
  newChatProject: document.getElementById('new-chat-project'),
  newChatPermission: document.getElementById('new-chat-permission'),
  newChatCancel: document.getElementById('new-chat-cancel'),
  newChatCreate: document.getElementById('new-chat-create'),
  renameButton: document.getElementById('rename-button'),
  pinButton: document.getElementById('pin-button'),
  status: document.getElementById('sidebar-status'),
  statusText: document.getElementById('status-text'),
  titleArea: document.getElementById('title-area'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  threadList: document.getElementById('thread-list'),
  listEmpty: document.getElementById('list-empty'),
  sidebarNewChat: document.getElementById('sidebar-new-chat'),
  sidebarNewEphemeral: document.getElementById('sidebar-new-ephemeral'),
  projectAdd: document.getElementById('project-add'),
  newProjectModal: document.getElementById('new-project-modal'),
  newProjectName: document.getElementById('new-project-name'),
  newProjectPath: document.getElementById('new-project-path'),
  newProjectCancel: document.getElementById('new-project-cancel'),
  newProjectCreate: document.getElementById('new-project-create'),
  cwdOptions: document.getElementById('cwd-options'),
  ephemeralClose: document.getElementById('ephemeral-close'),
  threadMeta: document.getElementById('thread-meta'),
  turns: document.getElementById('turns'),
  composer: document.getElementById('composer'),
  permissionButton: document.getElementById('permission-button'),
  permissionText: document.getElementById('permission-text'),
  permissionDot: document.getElementById('permission-dot'),
  permissionPanel: document.getElementById('permission-panel'),
  permissionOptions: document.getElementById('permission-options'),
  permissionEffective: document.getElementById('permission-effective'),
  approvalSlot: document.getElementById('approval-slot'),
  messageInput: document.getElementById('message-input'),
  attachButton: document.getElementById('attach-button'),
  attachInput: document.getElementById('attach-input'),
  attachStrip: document.getElementById('attach-strip'),
  sendButton: document.getElementById('send-button'),
  stopButton: document.getElementById('stop-button'),
  pendingStrip: document.getElementById('pending-strip'),
  toast: document.getElementById('toast'),
};

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 复制按钮的图标用内联 SVG，不用 emoji：emoji 走系统字体，在手机上会被放大成
   一大坨，夹在 12px 的代码/正文旁边很突兀，也没法跟着文字颜色走。 */
const COPY_ICON =
  '<svg class="copy-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="11" rx="2.5"/>' +
  '<path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H17"/></svg>';
const CHECK_ICON =
  '<svg class="copy-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4.5 12.5l5 5L20 6.5"/></svg>';

/* 链接后面跟一个复制图标：点一下复制的是真实地址，而不是屏幕上那串被截断的显示文字。 */
function linkCopyHtml(url, labelHtml) {
  return (
    '<span class="md-link"><a href="' +
    url +
    '" target="_blank" rel="noopener noreferrer">' +
    labelHtml +
    '</a><button type="button" class="copy-btn copy-link" aria-label="复制链接" title="复制链接">' +
    COPY_ICON +
    '</button></span>'
  );
}

/* 长一点的行内代码（token、路径、命令）也给个复制按钮；太短的标识符就不给了，
   否则「public/app.js:1149」这种到处都挂一个复制图标，满屏都是小图标。 */
const INLINE_COPY_MIN = 20;

function inlineCodeHtml(code) {
  return (
    '<span class="md-code"><code>' +
    code +
    '</code><button type="button" class="copy-btn copy-inline" aria-label="复制" title="复制">' +
    COPY_ICON +
    '</button></span>'
  );
}

function inlineCodeAndBold(value) {
  return String(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/* URL 尾巴上的标点不是地址的一部分（「见 http://x/y，」这种写法很常见） */
const URL_TAIL_CHARS = /[),.;:!?'"，。；：！？、）】」』»]+$/;

function inlineFormat(text, images) {
  /* Markdown 链接和反引号代码先摘出来存成占位符：不这么做的话，
     后面「裸 URL 自动变成可复制链接」那一步会钻进 <a href="…"> 和 <code> 里面，
     把链接拆成两半、把代码里的 URL 莫名变成链接。 */
  const parts = [];
  const hold = (html) => '\u0000P' + (parts.push(html) - 1) + '\u0000';

  let out = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, label, url) =>
    hold(linkCopyHtml(url, inlineCodeAndBold(label)))
  );
  out = out.replace(/`([^`]+)`/g, (match, code) =>
    hold(code.length >= INLINE_COPY_MIN ? inlineCodeHtml(code) : '<code>' + code + '</code>')
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&()*+,;=%]+/g, (match) => {
    const tail = URL_TAIL_CHARS.exec(match);
    const url = tail ? match.slice(0, match.length - tail[0].length) : match;
    if (!url) return match;
    return hold(linkCopyHtml(url, url)) + (tail ? tail[0] : '');
  });

  out = out.replace(/\u0000P(\d+)\u0000/g, (match, index) => parts[Number(index)] || '');
  if (images) out = out.replace(/\u0000I(\d+)\u0000/g, (match, index) => images[Number(index)] || '');
  return out;
}

function isLocalPath(value) {
  return !/^https?:\/\//i.test(value) && /^(?:[a-zA-Z]:[\\/]|\/|~\/)/.test(value);
}

function isImageSource(value) {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)(?:[?#].*)?$/i.test(String(value).trim());
}

function imageUrl(source, cwd) {
  if (!source) return '';
  let value = String(source).trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.toLowerCase().startsWith('file://')) {
    value = value.slice(7);
  }
  try {
    value = decodeURIComponent(value);
  } catch (error) {
    /* keep raw value */
  }
  const params = new URLSearchParams({ path: value });
  if (cwd) params.set('cwd', cwd);
  return '/api/file?' + params.toString();
}

function renderImageTag(source, alt, cwd) {
  const url = imageUrl(source, cwd);
  if (!url) return '';
  return (
    '<img class="chat-image" src="' +
    escapeHtml(url) +
    '" data-path="' +
    escapeHtml(source) +
    '" alt="' +
    escapeHtml(alt || '图片') +
    '" loading="lazy" />'
  );
}

function imageError(img) {
  const label = img.dataset.path || img.alt || '图片';
  const note = document.createElement('div');
  note.className = 'image-note';
  note.textContent = '🖼 图片无法显示：' + label;
  if (img.parentNode) img.parentNode.replaceChild(note, img);
}

/* ---------- 表格 ---------- */

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line) {
  const compact = line.replace(/\s+/g, '');
  return /^\|?[:|\-]+$/.test(compact) && compact.includes('-') && compact.includes('|');
}

function splitTableRow(line) {
  /* \| 是单元格里的竖线，先藏起来再切 */
  const guarded = line.trim().replace(/\\\|/g, '\u0000P\u0000');
  let row = guarded;
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.replace(/\u0000P\u0000/g, '|').trim());
}

function tableAlign(cell) {
  const value = cell.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return '';
}

function renderTable(headers, aligns, rows, images) {
  const style = (index) => (aligns[index] ? ' style="text-align:' + aligns[index] + '"' : '');
  const head = headers
    .map((cell, index) => '<th' + style(index) + '>' + inlineFormat(cell, images) + '</th>')
    .join('');
  const body = rows
    .map((row) => {
      const cells = [];
      for (let index = 0; index < headers.length; index += 1) {
        cells.push('<td' + style(index) + '>' + inlineFormat(row[index] || '', images) + '</td>');
      }
      return '<tr>' + cells.join('') + '</tr>';
    })
    .join('');
  return (
    '<div class="md-table"><table><thead><tr>' +
    head +
    '</tr></thead><tbody>' +
    body +
    '</tbody></table></div>'
  );
}

function renderMarkdown(raw, cwd) {
  const fences = [];
  const images = [];
  let text = String(raw === undefined || raw === null ? '' : raw).replace(
    /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g,
    (match, code) => {
      fences.push(code.replace(/\n$/, ''));
      return '\u0000F' + (fences.length - 1) + '\u0000';
    }
  );

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, alt, src) => {
    const remote = /^https?:\/\//i.test(src);
    const local = isLocalPath(src) || src.toLowerCase().startsWith('file://');
    if (!(remote || local) || !isImageSource(src)) return match;
    images.push(renderImageTag(src, alt, cwd));
    return '\u0000I' + (images.length - 1) + '\u0000';
  });
  text = text.replace(/(^|\s)(\/(?:Users|Volumes|private|tmp|var)\/[^\s)\]"'`<>]+)/g, (match, lead, src) => {
    if (!/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(src)) return match;
    images.push(renderImageTag(src, '', cwd));
    return lead + '\u0000I' + (images.length - 1) + '\u0000';
  });

  const output = [];
  let listBuffer = [];
  let listTag = 'ul';
  const flushList = () => {
    if (listBuffer.length > 0) {
      output.push('<' + listTag + '>' + listBuffer.join('') + '</' + listTag + '>');
      listBuffer = [];
    }
  };
  const pushListItem = (tag, html) => {
    if (listBuffer.length > 0 && listTag !== tag) flushList();
    listTag = tag;
    listBuffer.push(html);
  };

  const lines = escapeHtml(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\u0000F(\d+)\u0000$/.exec(line);
    if (fence) {
      flushList();
      output.push(
        '<div class="code-block">' +
          '<button type="button" class="copy-btn copy-code" aria-label="复制代码" title="复制代码">' +
            COPY_ICON + '复制</button>' +
          '<pre><code>' + escapeHtml(fences[Number(fence[1])]) + '</code></pre>' +
          '</div>'
      );
      continue;
    }
    const imageOnly = /^\u0000I(\d+)\u0000$/.exec(line);
    if (imageOnly) {
      flushList();
      output.push(images[Number(imageOnly[1])]);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      output.push('<h3>' + inlineFormat(heading[1], images) + '</h3>');
      continue;
    }
    /* 表格：表头那行的下一行是 |---|---| 分隔行才算，避免把普通的 | 文本当表格 */
    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushList();
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[index + 1]).map((cell) => tableAlign(cell));
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && isTableRow(lines[cursor])) {
        rows.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }
      output.push(renderTable(headers, aligns, rows, images));
      index = cursor - 1;
      continue;
    }
    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      pushListItem('ul', '<li>' + inlineFormat(listItem[1], images) + '</li>');
      continue;
    }
    const orderedItem = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (orderedItem) {
      pushListItem('ol', '<li>' + inlineFormat(orderedItem[1], images) + '</li>');
      continue;
    }
    if (line.trim() === '') {
      flushList();
      continue;
    }
    flushList();
    output.push('<p>' + inlineFormat(line, images) + '</p>');
  }
  flushList();
  return output.join('');
}

function relativeTime(unixSeconds) {
  if (!unixSeconds) return '';
  const minutes = Math.floor((Date.now() - unixSeconds * 1000) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' 天前';
  return new Date(unixSeconds * 1000).toLocaleDateString('zh-CN');
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status);
  return payload;
}

/* options.action：需要用户点一下才有效的提示（例如「电脑端已更新，点我刷新」），
   这种不自动消失，点一下才执行并收起。 */
function toast(message, options) {
  const action = (options && options.action) || null;
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  dom.toast.classList.toggle('actionable', Boolean(action));
  toast.action = action;
  clearTimeout(toast.timer);
  if (action) return;
  toast.timer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 2600);
}

/* 一键复制。手机访问的是 http://192.168.x.x:8787，不是安全上下文，
   navigator.clipboard 在那儿压根不存在，所以必须有 execCommand 的兜底，
   否则「复制」按钮在手机上一个都点不动。
   readonly + 屏幕外定位：iOS 不会弹键盘、也不会把页面滚走。 */
async function copyText(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return false;
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      /* 落到下面的兜底 */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '0';
    area.style.fontSize = '16px';
    document.body.appendChild(area);
    area.focus();
    area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (error) {
    return false;
  }
}

/* 复制按钮要复制的东西：代码块/命令输出取整段 pre 文本，链接取真实 href
   （href 属性里存的是转义过的 &amp;，用 DOM 的 href 取回来才是能直接用的地址）。 */
function copyValueFor(button) {
  const wrapper =
    button.closest('.code-block') || button.closest('.md-link') || button.closest('.md-code');
  if (!wrapper) return '';
  const pre = wrapper.querySelector('pre');
  if (pre) return pre.textContent || '';
  const code = wrapper.querySelector('code');
  if (code) return code.textContent || '';
  const anchor = wrapper.querySelector('a');
  if (anchor) return anchor.href || anchor.getAttribute('href') || '';
  return '';
}

function dismissToast() {
  clearTimeout(toast.timer);
  toast.action = null;
  dom.toast.classList.remove('actionable');
  dom.toast.hidden = true;
}

function setStatus(text, className) {
  dom.statusText.textContent = text;
  dom.status.className = className === 'online' ? 'online' : className === 'offline' ? 'offline' : '';
}

function isNarrow() {
  return window.matchMedia('(max-width: 767px)').matches;
}

function openSidebar() {
  if (!isNarrow()) return;
  document.body.classList.add('sidebar-open');
  dom.scrim.hidden = false;
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  dom.scrim.hidden = true;
}

function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) closeSidebar();
  else openSidebar();
}

function isNearBottom() {
  return dom.turns.scrollHeight - dom.turns.scrollTop - dom.turns.clientHeight < 120;
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    const shouldPin = state.pinnedToBottom;
    renderThread();
    if (shouldPin) {
      requestAnimationFrame(() => {
        dom.turns.scrollTop = dom.turns.scrollHeight;
      });
    }
  });
}

/* 流式输出里最费 CPU 的两件事：agent 正文每来一小段就要重排一次 markdown、
   思考过程每来一小段就要整块重画。要是每个 delta 都同步重排，长对话下主线程
   会被占满 —— 表现就是「正在回复的时候在输入框里打字特别卡」。
   所以这里只把「这个 item 脏了」记下来，最多每 120ms 刷一次对应的那个元素。 */
const DELTA_FLUSH_MS = 120;
const dirtyDeltas = new Map();

function scheduleDeltaFlush(item) {
  const key = item.id;
  if (!key || dirtyDeltas.has(key)) return;
  dirtyDeltas.set(
    key,
    setTimeout(() => {
      dirtyDeltas.delete(key);
      flushItemDelta(item);
    }, DELTA_FLUSH_MS)
  );
}

function flushItemDelta(item) {
  const root = dom.turns.querySelector('[data-item-id="' + CSS.escape(item.id || '') + '"]');
  /* 这个 item 还没画出来（比如序号对不上、刚切了会话），退回整块重画最稳 */
  if (!root) {
    scheduleRender();
    return;
  }
  if (item.type === 'agentMessage') {
    const md = root.querySelector('.md');
    if (!md) {
      scheduleRender();
      return;
    }
    md.innerHTML = renderMarkdown(item.text || '', currentCwd());
    return;
  }
  if (item.type === 'reasoning') {
    const reasoning = reasoningText(item);
    const summary = root.querySelector('summary');
    if (summary) {
      summary.textContent = '思考过程 · ' + reasoning.text.replace(/\s+/g, ' ').slice(0, 48);
    }
    const body = root.querySelector('.reasoning-body');
    if (body) body.textContent = reasoning.text;
    return;
  }
  if (item.type === 'commandExecution') {
    const out = root.querySelector('.out');
    if (out) out.textContent = clipForDisplay(item.aggregatedOutput || '', OUTPUT_RENDER_LIMIT);
  }
}

function findTurn(turnId) {
  return state.turns.find((turn) => turn.id === turnId) || null;
}

function findItem(itemId) {
  for (const turn of state.turns) {
    const item = (turn.items || []).find((candidate) => candidate.id === itemId);
    if (item) return { turn, item };
  }
  return { turn: null, item: null };
}

function upsertItem(turnId, item) {
  if (!item || !item.id) return;
  let turn = findTurn(turnId);
  if (!turn) {
    if (!turnId) return;
    turn = { id: turnId, status: 'inProgress', items: [] };
    state.turns.push(turn);
  }
  turn.items = turn.items || [];
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = Object.assign({}, turn.items[index], item);
}

function upsertTurn(turn) {
  if (!turn || !turn.id) return;
  const existing = findTurn(turn.id);
  if (existing) {
    const incoming = Array.isArray(turn.items) ? turn.items : [];
    /* daemon 的 turn/completed 只带回摘要（itemsView: summary），实测那个 items
       里只有最终那条回复，没有用户消息、也没有工具调用。套上去的一瞬间整轮就只剩
       最后一句话了（要等下一次轮询才恢复）——所以摘要不覆盖已有的完整 items。
       回放临时会话的日志时 applyEventLog 已经把 items 清空了，这里再兜一层。 */
    const summaryOnly = turn.itemsView === 'summary';
    existing.status = turn.status || existing.status;
    if (incoming.length > 0 && !summaryOnly) existing.items = incoming;
    if (turn.error) existing.error = turn.error;
  } else {
    state.turns = state.turns.filter((candidate) => !candidate.localEcho);
    state.turns.push(Object.assign({}, turn, { items: Array.isArray(turn.items) ? turn.items : [] }));
  }
}

/* 回放临时会话的事件日志时，一次性折叠完再渲染，别每条事件都刷一遍列表 */
function renderListQuiet() {
  if (state.foldingEvents) return;
  renderList();
}

function applyEventLog(events) {
  state.turns = [];
  state.pendingEchoes = [];
  state.turnDiffs = new Map();
  state.planSteps = new Map();
  state.foldingEvents = true;
  try {
    for (const event of events) {
      if (!event || !event.method) continue;
      let params = event.params;
      /* 只信 item/* 事件来复原内容：daemon 在 turn/completed 里带回的 items 是
         摘要（itemsView: summary），常常只含最终回复，直接套用会把前面折进去的
         用户消息抹掉。 */
      if ((event.method === 'turn/started' || event.method === 'turn/completed') && params && params.turn) {
        params = Object.assign({}, params, { turn: Object.assign({}, params.turn, { items: [] }) });
      }
      handleNotification(event.method, params);
    }
  } finally {
    state.foldingEvents = false;
  }
}

function handleNotification(method, params) {
  const data = params || {};

  if (method === 'thread/status/changed') {
    const thread = state.threads.find((candidate) => candidate.id === data.threadId);
    if (thread && data.status) thread.status = data.status;
    if (data.status && data.status.type === 'idle') {
      delete state.activeTurns[data.threadId];
      flushPending(data.threadId);
    }
    renderListQuiet();
    return;
  }

  if (method === 'thread/name/updated') {
    const thread = state.threads.find((candidate) => candidate.id === data.threadId);
    if (thread && data.name) thread.name = data.name;
    if (data.threadId === state.currentThreadId && data.name) {
      dom.title.textContent = String(data.name).slice(0, 60);
    }
    renderListQuiet();
    return;
  }

  if (method === 'turn/started' && data.threadId && data.turn && data.turn.id) {
    state.activeTurns[data.threadId] = data.turn.id;
    renderListQuiet();
  } else if (method === 'turn/completed' && data.threadId) {
    if (!data.turn || state.activeTurns[data.threadId] === data.turn.id) {
      delete state.activeTurns[data.threadId];
    }
    renderListQuiet();
    /* 这一轮结束了：挂在输入框上面的那条自动发出去 */
    flushPending(data.threadId);
  }

  if (!data.threadId || data.threadId !== state.currentThreadId) return;

  if (method === 'turn/started') {
    upsertTurn(data.turn);
    scheduleRender();
    return;
  }

  if (method === 'turn/completed') {
    upsertTurn(data.turn);
    scheduleRender();
    return;
  }

  if (method === 'turn/diff/updated') {
    if (data.turnId) state.turnDiffs.set(data.turnId, data.diff || '');
    scheduleRender();
    return;
  }

  if (method === 'turn/plan/updated') {
    if (data.turnId) state.planSteps.set(data.turnId, data.plan || []);
    scheduleRender();
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    if (data.item && data.item.id) upsertItem(data.turnId || data.item.turnId, data.item);
    scheduleRender();
    return;
  }

  if (method === 'item/agentMessage/delta') {
    const found = findItem(data.itemId);
    if (found.item && typeof data.delta === 'string') {
      found.item.text = (found.item.text || '') + data.delta;
      scheduleDeltaFlush(found.item);
    }
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    const found = findItem(data.itemId);
    if (found.item && typeof data.delta === 'string') {
      found.item.aggregatedOutput = (found.item.aggregatedOutput || '') + data.delta;
      scheduleDeltaFlush(found.item);
    }
    return;
  }

  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const found = findItem(data.itemId);
    if (found.item && typeof data.delta === 'string') {
      const key = method === 'item/reasoning/textDelta' ? 'content' : 'summary';
      found.item[key] = found.item[key] || [];
      const index = Number(data.summaryIndex ?? data.contentIndex ?? 0);
      found.item[key][index] = (found.item[key][index] || '') + data.delta;
      scheduleDeltaFlush(found.item);
    }
    return;
  }

  if (method === 'item/reasoning/summaryPartAdded') {
    const found = findItem(data.itemId);
    if (found.item) {
      const key = data.kind === 'text' ? 'content' : 'summary';
      found.item[key] = found.item[key] || [];
      found.item[key][Number(data.summaryIndex || 0)] = found.item[key][Number(data.summaryIndex || 0)] || '';
    }
    return;
  }

}

function handleEvent(event) {
  if (event.type === 'hello') {
    state.connected = Boolean(event.connected);
    state.userAgent = event.userAgent || null;
    state.connectionError = event.error || null;
    state.pendingApprovals = new Map(
      (event.pendingApprovals || []).map((record) => [String(record.requestId), record])
    );
    state.activeTurns = event.activeTurns || {};
    updateStatusLine();
    renderApprovals();
    if (state.currentThreadId) renderThread();
    return;
  }

  if (event.type === 'status') {
    state.connected = Boolean(event.connected);
    state.connectionError = event.error || null;
    if (event.userAgent) state.userAgent = event.userAgent;
    updateStatusLine();
    return;
  }

  if (event.type === 'approval') {
    state.pendingApprovals.set(String(event.request.requestId), event.request);
    renderApprovals();
    renderList();
    return;
  }

  if (event.type === 'approval-resolved') {
    state.pendingApprovals.delete(String(event.requestId));
    renderApprovals();
    renderList();
    return;
  }

  if (event.type === 'permission' && event.permission) {
    if (event.permission.mode === 'default') delete state.threadModes[event.threadId];
    else state.threadModes[event.threadId] = event.permission.mode;
    if (event.threadId === state.currentThreadId) {
      state.permission = event.permission;
      renderPermission();
    }
    renderList();
    return;
  }

  if (event.type === 'notification') handleNotification(event.method, event.params);
}

function connectEvents() {
  const source = new EventSource('/events');
  source.onopen = () => {
    state.lastEventAt = Date.now();
    state.connected = true;
    updateStatusLine();
    refreshIfVisible();
  };
  source.onmessage = (message) => {
    state.lastEventAt = Date.now();
    try {
      handleEvent(JSON.parse(message.data));
    } catch (error) {
      console.error('bad event', error);
    }
  };
  source.onerror = () => {
    state.connected = false;
    updateStatusLine();
  };
}

function updateStatusLine() {
  if (state.connected) setStatus('已连接 · ' + state.threads.length + ' 个会话', 'online');
  else if (state.connectionError) setStatus('未连接：' + state.connectionError, 'offline');
  else setStatus('实时连接中断，正在自动重连 · ' + state.threads.length + ' 个会话', 'offline');
}

/* ---------- 连接延时 ---------- */

function latencyGrade(ms) {
  if (!Number.isFinite(ms)) return 'poor';
  if (ms < 80) return 'good';
  if (ms < 250) return 'fair';
  return 'poor';
}

function formatMs(value) {
  if (!Number.isFinite(value)) return '—';
  return value < 10 ? value.toFixed(1) + ' ms' : Math.round(value) + ' ms';
}

const PATH_LABELS = {
  local: '本机直连',
  lan: '局域网直连',
  tailscale: 'Tailscale 中继',
  other: '远端',
};

/* 走 Tailscale 时延基本都在 200ms 起（实测是 DERP 中继，不是直连），
   这时候最有用的一句话是「换成局域网地址」。 */
function renderLatencyHint(info) {
  const client = info.ok ? info.client : null;
  if (!client || client.path !== 'tailscale' || !client.lanUrl) {
    dom.latencyHint.hidden = true;
    dom.latencyHint.textContent = '';
    return;
  }
  const link = document.createElement('a');
  link.href = client.lanUrl;
  link.textContent = '改用局域网地址';
  dom.latencyHint.hidden = false;
  dom.latencyHint.textContent = '';
  dom.latencyHint.append(
    document.createTextNode('手机正走 Tailscale 中继（不是直连），延时就是这么来的。如果手机和电脑在同一个 Wi-Fi 下，'),
    link,
    document.createTextNode(' 能降到几毫秒。')
  );
}

function renderLatencyButton(button, dot, icon, text, info) {
  if (!info) {
    button.className = '';
    text.textContent = '—';
    dot.hidden = false;
    icon.hidden = true;
    button.title = '连接延时';
    return;
  }
  if (!info.ok) {
    button.className = 'poor';
    text.textContent = '离线';
    button.title = '连不上桥接：' + info.error;
  } else {
    button.className = info.daemonOk ? latencyGrade(info.totalMs) : 'poor';
    text.textContent = info.daemonOk ? Math.round(info.totalMs) + 'ms' : '无 Codex';
    button.title =
      '手机 ↔ 电脑 ' + Math.round(info.lanMs) + 'ms · 电脑 ↔ Codex ' + formatMs(info.daemonMs) +
      (info.daemonOk ? ' · 点击看详情' : ' · ' + info.daemonError);
  }
  /* 断线不该只靠颜色区分（色弱、强光下都看不出来），换成明确的图标。 */
  const broken = !info.ok || !info.daemonOk;
  dot.hidden = broken;
  icon.hidden = !broken;
}

function renderLatency() {
  const info = state.latency;
  renderLatencyButton(
    dom.composerLatency,
    dom.composerLatencyDot,
    dom.composerLatencyIcon,
    dom.composerLatencyText,
    info
  );
  if (!info) return;
  dom.latencyLan.textContent = info.ok ? Math.round(info.lanMs) + ' ms' : '⚠ 连不上';
  dom.latencyDaemon.textContent = info.daemonOk ? formatMs(info.daemonMs) : '⚠ 未连接';
  dom.latencyDaemon.title = info.daemonError || '';
  dom.latencyPath.textContent = info.ok ? PATH_LABELS[info.client?.path] || '—' : '—';
  dom.latencyPath.title = info.ok && info.client?.ip ? info.client.ip : '';
  dom.latencyStream.textContent = state.connected ? '已连接' : '⚠ 中断，重连中';
  dom.latencyAt.textContent = info.at ? new Date(info.at).toLocaleTimeString() : '—';
  dom.latencyVersion.textContent = info.version ? 'v' + info.version : '—';
  renderLatencyHint(info);
}

/* /api/ping 在服务端先问一次 Codex（thread/loaded/list，无副作用），
   所以这次 fetch 的往返 = 手机→电脑 + 电脑→Codex，两段都能算出来。 */
/* 手机上这个页面可能开着好几天都不刷新，而电脑上的桥接随时会被重新部署。
   版本号一变就说明页面里跑的还是旧代码，提示一句让用户刷一下，
   否则「电脑上加的新功能手机上怎么没有」这种误会会一直有。 */
function noteBridgeVersion(version) {
  if (!version) return;
  if (!state.bridgeVersion) {
    state.bridgeVersion = version;
    return;
  }
  if (state.bridgeVersion === version || state.versionNotice) return;
  state.versionNotice = true;
  state.bridgeVersion = version;
  toast('电脑端已更新到 v' + version + '，点这里刷新页面', {
    action: () => window.location.reload(),
  });
}

async function measureLatency() {
  const started = performance.now();
  try {
    const result = await api('/api/ping');
    const totalMs = performance.now() - started;
    const daemonMs = Number.isFinite(result?.daemon?.ms) ? result.daemon.ms : null;
    noteBridgeVersion(result?.version || null);
    state.latency = {
      ok: true,
      at: Date.now(),
      totalMs,
      lanMs: Math.max(0, totalMs - (daemonMs || 0)),
      daemonMs: daemonMs || 0,
      daemonOk: Boolean(result?.daemon?.ok),
      daemonError: result?.daemon?.error || null,
      version: result?.version || null,
      client: result?.client || null,
    };
  } catch (error) {
    state.latency = {
      ok: false,
      at: Date.now(),
      error: error.message,
      totalMs: null,
      lanMs: null,
      daemonMs: null,
      daemonOk: false,
      daemonError: '未连接',
      version: null,
      client: null,
    };
  }
  renderLatency();
}

/* 面板只有一个，挂在输入框那颗延时按钮上：贴着输入框往上弹。 */
function anchorLatencyPanel() {
  const panel = dom.latencyPanel;
  const composer = document.getElementById('composer');
  if (!composer) return;
  panel.style.top = 'auto';
  panel.style.bottom = Math.round(composer.getBoundingClientRect().height + 10) + 'px';
}

function toggleLatencyPanel(show) {
  const next = show === undefined ? dom.latencyPanel.hidden : show;
  dom.latencyPanel.hidden = !next;
  if (!next) return;
  anchorLatencyPanel();
  measureLatency();
}

/* ---------- 会话权限档位 ---------- */

/* ---------- 外观：跟随手机系统 / 白天 / 夜间 ---------- */
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_ICONS = { auto: '🌓', light: '☀️', dark: '🌙' };
const THEME_LABELS = { auto: '跟随手机', light: '白天', dark: '夜间' };

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function themeIsDark(mode) {
  return mode === 'dark' || (mode === 'auto' && systemPrefersDark());
}

function applyTheme() {
  const mode = THEME_MODES.includes(state.theme) ? state.theme : 'auto';
  const dark = themeIsDark(mode);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeMode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#111111' : '#ffffff');
  /* 加到主屏当 App 用时，iOS 状态栏字色要靠这个 meta 切 */
  const statusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBar) statusBar.setAttribute('content', dark ? 'black-translucent' : 'default');
  if (!dom.themeButton) return;
  dom.themeButton.textContent = THEME_ICONS[mode];
  dom.themeButton.dataset.mode = mode;
  const title = '外观：' + THEME_LABELS[mode] + (mode === 'auto' ? '（现在' + (dark ? '夜间' : '白天') + '）' : '');
  dom.themeButton.title = title;
  dom.themeButton.setAttribute('aria-label', title);
}

function setTheme(mode) {
  state.theme = mode;
  try {
    localStorage.setItem('codex.theme', mode);
  } catch (err) {
    /* 隐私模式下写不进去也没关系，这次会话里照样生效 */
  }
  applyTheme();
}

function loadTheme() {
  try {
    const raw = localStorage.getItem('codex.theme');
    if (THEME_MODES.includes(raw)) state.theme = raw;
  } catch (err) {}
  applyTheme();
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    /* 只有「跟随手机」时才需要跟着系统变；手动选过就尊重手动选择 */
    if (state.theme === 'auto') applyTheme();
  };
  if (query.addEventListener) query.addEventListener('change', onChange);
  else if (query.addListener) query.addListener(onChange);
}

function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(state.theme) + 1) % THEME_MODES.length];
  setTheme(next);
  toast('外观：' + THEME_LABELS[next] + (next === 'auto' ? '（跟随手机系统）' : ''));
}

function permissionProfile(mode) {
  return state.permissionProfiles.find((profile) => profile.id === mode) || null;
}

function permissionLabel(mode) {
  const profile = permissionProfile(mode);
  if (profile) return profile.label;
  return { ask: '自己决策', auto: '帮我决策', full: '完全访问' }[mode] || '跟随电脑';
}

function renderPermission() {
  const mode = (state.permission && state.permission.mode) || 'default';
  const profile = permissionProfile(mode);
  const label = permissionLabel(mode);
  dom.permissionButton.className = mode === 'default' ? '' : mode;
  dom.permissionText.textContent = label;
  dom.permissionButton.title =
    '本对话权限：' + label + (profile && profile.hint ? '（' + profile.hint + '）' : '');

  const effective = state.permission && state.permission.effective;
  if (effective) {
    dom.permissionEffective.textContent =
      [effective.sandbox, effective.reviewer].filter(Boolean).join(' · ') || '—';
    dom.permissionEffective.title =
      '电脑上当前生效：' +
      [effective.sandbox, effective.reviewer, effective.approvalPolicy].filter(Boolean).join(' · ');
  } else {
    dom.permissionEffective.textContent = '—';
    dom.permissionEffective.title = '还没读到电脑上的设置，发一条消息后就能看到';
  }
}

function renderPermissionOptions() {
  const mode = (state.permission && state.permission.mode) || 'default';
  dom.permissionOptions.innerHTML = state.permissionProfiles
    .map((profile) => {
      const active = profile.id === mode;
      return (
        '<button type="button" class="permission-option' + (active ? ' active' : '') +
        '" data-mode="' + escapeHtml(profile.id) + '">' +
        '<span class="mark ' + escapeHtml(profile.id) + '"></span>' +
        '<span class="label">' + escapeHtml(profile.label) + '</span>' +
        '<span class="hint">' + escapeHtml(profile.hint || '') + '</span>' +
        (active ? '<span class="check">✓</span>' : '') +
        '</button>'
      );
    })
    .join('');
}

function renderNewChatPermissionOptions() {
  const previous = dom.newChatPermission.value;
  dom.newChatPermission.innerHTML = state.permissionProfiles
    .map(
      (profile) =>
        '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.label) + '</option>'
    )
    .join('');
  dom.newChatPermission.value = permissionProfile(previous) ? previous : 'default';
}

function togglePermissionPanel(show) {
  const next = show === undefined ? dom.permissionPanel.hidden : show;
  dom.permissionPanel.hidden = !next;
  dom.permissionButton.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) renderPermissionOptions();
}

async function loadPermissions() {
  try {
    const result = await api('/api/permissions');
    state.permissionProfiles = result.profiles || [];
    state.threadModes = result.modes || {};
    renderNewChatPermissionOptions();
    renderPermission();
    renderList();
  } catch (error) {
    /* 旧版桥接没有这个接口，安静降级 */
  }
}

async function setPermission(mode) {
  const threadId = state.currentThreadId;
  if (!threadId) return;
  const previous = (state.permission && state.permission.mode) || 'default';
  togglePermissionPanel(false);
  if (mode === previous) return;
  try {
    await api('/api/threads/' + encodeURIComponent(threadId) + '/permissions', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    state.permission = { mode, effective: state.permission ? state.permission.effective : null };
    if (mode === 'default') delete state.threadModes[threadId];
    else state.threadModes[threadId] = mode;
    renderPermission();
    renderList();
    toast('已设为「' + permissionLabel(mode) + '」，下一条消息生效');
  } catch (error) {
    toast('设置失败：' + error.message);
  }
}

function threadStatus(threadId) {
  if (state.currentThreadId === threadId && state.thread) return state.thread.status?.type;
  const listed = state.threads.find((thread) => thread.id === threadId);
  return listed?.status?.type;
}

function loadCollapsedGroups() {
  try {
    const raw = localStorage.getItem('codex.collapsedGroups');
    const parsed = raw ? JSON.parse(raw) : [];
    state.collapsedGroups = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    state.collapsedGroups = [];
  }
}

function saveCollapsedGroups() {
  try {
    localStorage.setItem('codex.collapsedGroups', JSON.stringify(state.collapsedGroups));
  } catch (error) {
    /* ignore */
  }
}

function toggleGroup(key) {
  if (state.collapsedGroups.includes(key)) {
    state.collapsedGroups = state.collapsedGroups.filter((entry) => entry !== key);
  } else {
    state.collapsedGroups = state.collapsedGroups.concat([key]);
  }
  saveCollapsedGroups();
  renderList();
}

/* 会话归到哪个项目：daemon 里会话的 projectId 通常是空的，真正的关联是
   「会话的 cwd 落在项目根目录下」。 */
function projectRoot(project) {
  const root = project && project.roots && project.roots[0] ? project.roots[0].path : '';
  return root || '';
}

function projectForThread(thread) {
  if (!thread) return null;
  if (thread.projectId) {
    const byId = state.projects.find((project) => project.id === thread.projectId);
    if (byId) return byId;
  }
  const cwd = thread.cwd || '';
  if (!cwd) return null;
  return (
    state.projects.find((project) =>
      (project.roots || []).some((root) => {
        const rootPath = root && root.path ? root.path : '';
        if (!rootPath) return false;
        const base = rootPath.endsWith('/') ? rootPath : rootPath + '/';
        return cwd === rootPath || cwd.startsWith(base);
      })
    ) || null
  );
}

function threadActivity(thread) {
  return thread.updatedAt || thread.createdAt || 0;
}

/* 排序：置顶的永远在最前，其余按「最近有动静」倒序。
   daemon 给的顺序其实是按创建时间来的，直接照搬的话刚聊过的会话会沉在中间。 */
function sortThreads(threads) {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((a, b) => {
      const pa = isPinned(a.thread.id) ? 0 : 1;
      const pb = isPinned(b.thread.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ta = threadActivity(a.thread);
      const tb = threadActivity(b.thread);
      if (ta !== tb) return tb - ta;
      return a.index - b.index;
    })
    .map((entry) => entry.thread);
}

function threadCard(thread, options) {
  const indented = Boolean(options && options.indented);
  const item = document.createElement('li');
  item.className =
    'thread-card' +
    (thread.id === state.currentThreadId ? ' current' : '') +
    (indented ? ' in-group' : '');

  const running =
    Boolean(state.activeTurns[thread.id]) ||
    thread.status?.type === 'active' ||
    threadStatus(thread.id) === 'active';
  const waiting = [...state.pendingApprovals.values()].some(
    (record) => record.params && record.params.threadId === thread.id
  );
  const title = thread.name || thread.preview || '(未命名会话)';
  let badge = '';
  if (waiting) badge = '<span class="badge waiting">待审批</span>';
  else if (running) badge = '<span class="badge active">运行中</span>';

  item.innerHTML =
    '<div class="row">' +
    (isPinned(thread.id) ? '<span class="pin">★</span>' : '') +
    (thread.ephemeral ? '<span class="badge ephemeral">临时</span>' : '') +
    '<span class="name">' +
    escapeHtml(title.slice(0, 80)) +
    '</span>' +
    badge +
    '<span class="time">' +
    escapeHtml(relativeTime(thread.updatedAt)) +
    '</span></div>' +
    (thread.name && thread.preview
      ? '<div class="preview">' + escapeHtml(thread.preview.slice(0, 140)) + '</div>'
      : '');

  item.addEventListener('click', () => openThread(thread.id));
  return item;
}

function appendGroup(group) {
  /* keepWhenEmpty：项目分组不能因为「还没有对话」就整行消失，
     否则空项目下面根本没法新建对话（＋ 就在这一行上）。 */
  if (!group.threads.length && !group.keepWhenEmpty) return;
  const collapsed = state.collapsedGroups.includes(group.key);
  if (group.label) {
    const head = document.createElement('li');
    head.className = 'group-head' + (collapsed ? ' collapsed' : '');
    head.innerHTML =
      '<span class="chev">' +
      (collapsed ? '▸' : '▾') +
      '</span><span class="group-name">' +
      escapeHtml(group.label) +
      '</span><span class="group-count">' +
      group.threads.length +
      '</span>';
    head.addEventListener('click', () => toggleGroup(group.key));
    /* 项目分组右上角给个 ＋：不然只能在「新建对话」里手打路径，
       打错（比如写成 ~/… 而不是绝对路径）就归不到这个项目底下了。 */
    if (group.root) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'group-add';
      add.textContent = '＋';
      add.title = '在「' + group.label + '」下新建对话';
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', (event) => {
        event.stopPropagation();
        openNewChatPanel({ cwd: group.root, projectName: group.label });
      });
      head.appendChild(add);
    }
    dom.threadList.appendChild(head);
  }
  if (collapsed && group.label) return;
  if (!group.threads.length) {
    const hint = document.createElement('li');
    hint.className = 'group-empty';
    hint.textContent = '还没有对话，点上面 ＋ 新建一个';
    dom.threadList.appendChild(hint);
    return;
  }
  for (const thread of group.threads) {
    dom.threadList.appendChild(threadCard(thread, { indented: Boolean(group.label) }));
  }
}

function renderList() {
  dom.threadList.innerHTML = '';
  dom.listEmpty.hidden = state.threads.length > 0;

  renderCwdOptions();

  const ephemeral = sortThreads(state.threads.filter((thread) => thread.ephemeral));
  const rest = state.threads.filter((thread) => !thread.ephemeral);

  const assigned = new Set();
  const projectGroups = [];
  for (const project of state.projects) {
    const members = rest.filter((thread) => projectForThread(thread) === project);
    for (const thread of members) assigned.add(thread.id);
    projectGroups.push({
      key: 'project:' + project.id,
      label: project.name || '(未命名项目)',
      /* 新建会话要用它当工作文件夹，会话才会落回这个分组里 */
      root: projectRoot(project),
      /* 没有会话的项目也留在列表里，才能从它的 ＋ 建第一个会话 */
      keepWhenEmpty: true,
      threads: sortThreads(members),
    });
  }
  const leftovers = sortThreads(rest.filter((thread) => !assigned.has(thread.id)));

  /* 最近的临时对话排最前，跟着是各项目（项目内最新的那个项目靠前），
     最后是没归到项目的会话 */
  const groupActivity = (group) =>
    group.threads.length ? Math.max(...group.threads.map(threadActivity)) : 0;
  projectGroups.sort((a, b) => groupActivity(b) - groupActivity(a));
  appendGroup({ key: 'ephemeral', label: '临时对话', threads: ephemeral });
  for (const group of projectGroups) appendGroup(group);
  appendGroup({
    key: 'other',
    label: state.projects.length ? '其他对话' : '',
    threads: leftovers,
  });

  updateStatusLine();
}

function renderCwdOptions() {
  if (!dom.cwdOptions) return;
  const seen = new Set();
  const options = [];
  for (const thread of state.threads) {
    if (!thread.cwd || seen.has(thread.cwd)) continue;
    seen.add(thread.cwd);
    options.push(thread.cwd);
  }
  dom.cwdOptions.innerHTML = options
    .slice(0, 40)
    .map((value) => '<option value="' + escapeHtml(value) + '"></option>')
    .join('');
}

function itemStatusClass(item) {
  if (item.status === 'completed') return 'status-ok';
  if (item.status === 'failed' || item.status === 'declined') return 'status-bad';
  return '';
}

function renderQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '';
  return questions
    .map(
      (question) =>
        '<div style="margin-top:6px;font-size:13px;color:var(--text-dim)"><b>' +
        escapeHtml(question.header || '') +
        '</b> ' +
        escapeHtml(question.question || '') +
        '</div>'
    )
    .join('');
}

function reasoningText(item) {
  const summary = (item.summary || []).join('\n').trim();
  const content = (item.content || []).join('\n').trim();
  return { summary, content, text: content || summary };
}

/* 桥接会把超长文本剪掉再发过来；这里再兜一层，专门管「边流边涨」的那种：
   命令输出是 delta 一点点拼起来的，桥接剪的是完成时的那一份，流式过程中
   前端自己攒的这份得自己看着点，否则一次 `npm install` 就能把手机拖死。 */
const OUTPUT_RENDER_LIMIT = 8000;

function clipForDisplay(text, limit) {
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

function currentCwd() {
  return (state.thread && state.thread.cwd) || '';
}

function renderItem(item) {
  const id = escapeHtml(item.id || '');

  if (item.type === 'userMessage') {
    const images = [];
    const lines = [];
    for (const part of item.content || []) {
      if (typeof part === 'string') {
        lines.push(part);
        continue;
      }
      if (part && part.type === 'text' && typeof part.text === 'string') {
        lines.push(part.text);
      } else if (part && /image/i.test(part.type || '')) {
        const source =
          part.path ||
          part.filePath ||
          part.file_path ||
          part.imageUrl ||
          part.image_url ||
          part.url ||
          (part.image && (part.image.url || part.image.path)) ||
          '';
        const tag = renderImageTag(source, part.alt, currentCwd());
        if (tag) images.push(tag);
      }
    }
    const text = lines.join('\n').trim();
    const body =
      (text ? escapeHtml(text) : '') +
      (images.length ? '<div class="msg-images">' + images.join('') + '</div>' : '');
    return '<div class="item item-user" data-item-id="' + id + '">' + body + '</div>';
  }

  if (item.type === 'agentMessage') {
    return (
      '<div class="item item-agent" data-item-id="' + id + '">' +
      '<div class="md">' + renderMarkdown(item.text, currentCwd()) + '</div>' +
      renderQuestions(item.questions) +
      '</div>'
    );
  }

  if (item.type === 'reasoning') {
    const reasoning = reasoningText(item);
    if (!reasoning.text) return '';
    return (
      '<details class="block reasoning" data-item-id="' + id + '">' +
      '<summary>思考过程 · ' + escapeHtml(reasoning.text.replace(/\s+/g, ' ').slice(0, 48)) + '</summary>' +
      '<div class="body reasoning-body">' + escapeHtml(reasoning.text) + '</div></details>'
    );
  }

  if (item.type === 'commandExecution') {
    const exit =
      item.exitCode === undefined || item.exitCode === null ? '' : ' exit ' + item.exitCode;
    const duration = item.durationMs ? ' · ' + (item.durationMs / 1000).toFixed(1) + 's' : '';
    const shortCommand = String(item.command || '').replace(/\s+/g, ' ').slice(0, 160);
    return (
      '<details class="block" data-item-id="' + id + '">' +
      '<summary><span class="' + itemStatusClass(item) + '">' + escapeHtml(item.status || '') + exit +
      '</span><span>' + escapeHtml(shortCommand) + duration + '</span></summary>' +
      '<div class="body">' + escapeHtml(item.command || '') +
      (item.cwd ? '<div style="opacity:.6">cwd: ' + escapeHtml(item.cwd) + '</div>' : '') +
      '<div class="code-block">' +
      '<button type="button" class="copy-btn copy-code" aria-label="复制输出" title="复制输出">' +
      COPY_ICON + '复制</button>' +
      '<pre class="out" style="margin:6px 0 0">' +
      escapeHtml(clipForDisplay(item.aggregatedOutput || '', OUTPUT_RENDER_LIMIT)) +
      '</pre></div>' +
      '</div></details>'
    );
  }

  if (item.type === 'fileChange') {
    const files = (item.changes || []).map((change) => change.path).filter(Boolean);
    const fallback = (item.changes || [])
      .map((change) => (change.kind || '') + ' ' + change.path + '\n' + (change.diff || ''))
      .join('\n');
    return (
      '<details class="block" data-item-id="' + id + '">' +
      '<summary><span class="' + itemStatusClass(item) + '">' + escapeHtml(item.status || '') +
      '</span><span>改动 ' + files.length + ' 个文件</span></summary>' +
      '<div class="body"><div class="file-list">' +
      files.map((file) => '<div>' + escapeHtml(file) + '</div>').join('') +
      '</div><pre style="margin:8px 0 0">' + escapeHtml(fallback) + '</pre></div></details>'
    );
  }

  if (item.type === 'plan') {
    return '<div class="item item-plan" data-item-id="' + id + '">' + renderMarkdown(item.text, currentCwd()) + '</div>';
  }

  if (item.type === 'webSearch' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const label = item.type === 'webSearch' ? '联网搜索' : '工具调用';
    return (
      '<details class="block" data-item-id="' + id + '">' +
      '<summary>' + label + (item.status ? ' · ' + escapeHtml(item.status) : '') + '</summary>' +
      '<div class="body">' + escapeHtml(JSON.stringify(item, null, 1)) + '</div></details>'
    );
  }

  return '';
}

function renderPlan(turnId) {
  const steps = state.planSteps.get(turnId);
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return (
    '<div class="item item-plan">' +
    steps
      .map(
        (step) =>
          '<div class="step ' + (step.status === 'completed' ? 'done' : '') + '">' +
          '<span>' + (step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◐' : '○') + '</span>' +
          '<span>' + escapeHtml(step.step || '') + '</span></div>'
      )
      .join('') +
    '</div>'
  );
}

/* ---------- 这台机器的名字（多台电脑靠它区分） ---------- */

function bridgeLabel() {
  return state.bridgeName || '';
}

function renderHeaderSubtitle() {
  const active = threadRunning();
  const name = bridgeLabel();
  dom.subtitle.textContent = active ? (name ? '运行中… · ' + name : '运行中…') : name;
  dom.subtitle.className = active ? 'online' : '';
}

function applyBridgeMeta() {
  const name = state.bridgeName || 'Codex Remote';
  const meta = state.bridgeMeta || {};
  document.title = name + ' · Codex Remote';
  dom.sidebarBrand.textContent = name;
  dom.sidebarBrand.title =
    '点这里给这台电脑起名字' +
    (meta.hostname ? '（' + meta.hostname + (meta.version ? ' · v' + meta.version : '') + '）' : '');
  if (state.currentThreadId) renderHeaderSubtitle();
  else dom.subtitle.textContent = '';
}

async function loadBridgeMeta() {
  try {
    const meta = await api('/api/meta');
    state.bridgeMeta = meta;
    state.bridgeName = meta.name || '';
    applyBridgeMeta();
  } catch (error) {
    /* 名字只是锦上添花，接口拿不到就算了 */
  }
}

async function renameBridge() {
  const current = state.bridgeName || '';
  const next = window.prompt('这台电脑的名字（多台电脑靠它区分）', current);
  if (next === null) return;
  const name = next.trim().slice(0, 60);
  if (!name || name === current) return;
  try {
    const result = await api('/api/meta', { method: 'POST', body: JSON.stringify({ name }) });
    state.bridgeName = result.name || name;
    applyBridgeMeta();
    toast('已改名为「' + state.bridgeName + '」');
  } catch (error) {
    toast('改名失败：' + error.message);
  }
}

/* ---------- 停在最新一条 ---------- */

function scrollTurnsToBottom() {
  dom.turns.scrollTop = dom.turns.scrollHeight;
}

/* 图片和流式输出会在首次布局之后继续把内容撑高，所以要多钉几次，不能只滚一次。 */
function pinToBottomSoon() {
  state.pinnedToBottom = true;
  scrollTurnsToBottom();
  requestAnimationFrame(scrollTurnsToBottom);
  for (const delay of [80, 250, 600, 1200]) {
    setTimeout(() => {
      if (state.pinnedToBottom) scrollTurnsToBottom();
    }, delay);
  }
}

const turnsResizeObserver =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (state.pinnedToBottom) scrollTurnsToBottom();
      })
    : null;

function observeTurnSizes() {
  if (!turnsResizeObserver) return;
  turnsResizeObserver.disconnect();
  turnsResizeObserver.observe(dom.turns);
  for (const child of dom.turns.children) turnsResizeObserver.observe(child);
}

/* 记住上次看的会话，刷新后直接回到那里并停在最新一条 */
function saveLastThread(threadId) {
  try {
    localStorage.setItem('codex.lastThread', threadId);
  } catch (error) {
    /* ignore */
  }
}

function readLastThread() {
  try {
    return localStorage.getItem('codex.lastThread') || '';
  } catch (error) {
    return '';
  }
}

function restoreLastThread() {
  const threadId = readLastThread();
  if (!threadId || state.currentThreadId) return;
  if (!state.threads.some((thread) => thread.id === threadId)) return;
  openThread(threadId);
}

function renderPlaceholder() {
  updateThreadActions();
  state.runStarted = null;
  dom.title.textContent = bridgeLabel() || 'Codex';
  dom.subtitle.textContent = '';
  dom.subtitle.className = '';
  dom.threadMeta.textContent = '';
  dom.turns.innerHTML =
    '<div id="placeholder">' +
    (isNarrow() ? '点左上角 ☰ 选择或开始一个会话' : '从左侧选择一个会话，或新建任务') +
    '</div>';
}

function threadRunning(threadId) {
  const id = threadId || state.currentThreadId;
  if (!id) return false;
  if (state.activeTurns[id]) return true;
  const type = state.thread && state.thread.id === id ? state.thread.status?.type : null;
  if (type === 'active') return true;
  const listed = state.threads.find((thread) => thread.id === id);
  return listed?.status?.type === 'active';
}

/* 输入框旁边只有「发送」和运行中的「中断」两个按钮。运行中按发送不会打断当前这一轮，
   消息挂到输入框上面等着；要立刻插进去，点那条上的「引导」。 */
function renderComposerButtons(running) {
  const active = typeof running === 'boolean' ? running : threadRunning();
  dom.stopButton.hidden = !active;
}

/* ---------- 运行中计时 ---------- */

/* 桌面版跑的时候会显示已用时，这里对齐它的格式：0:12 / 1:23 / 1:02:03。 */
function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(secs);
  return minutes + ':' + pad(secs);
}

/* 以服务端给的 turn.startedAt（epoch 秒）为准；刚乐观插入、还没回读到 turns 时，
   退回到「第一次看到它开始跑」的时刻，等回读到了再切过去。 */
function syncRunStarted() {
  const id = state.currentThreadId;
  if (!id || !threadRunning(id)) {
    state.runStarted = null;
    return null;
  }
  const activeTurnId = state.activeTurns[id] || null;
  const turn = state.turns.find(
    (candidate) => candidate.id === activeTurnId || candidate.status === 'inProgress'
  );
  const turnId = (turn && turn.id) || activeTurnId;
  if (turn && Number.isFinite(turn.startedAt)) {
    state.runStarted = { threadId: id, turnId, at: turn.startedAt };
    return state.runStarted;
  }
  const stale =
    !state.runStarted || state.runStarted.threadId !== id ||
    (turnId && state.runStarted.turnId !== turnId);
  if (stale) state.runStarted = { threadId: id, turnId, at: Math.floor(Date.now() / 1000) };
  return state.runStarted;
}

/* 对话流底部的运行中指示，跟桌面版一样长在会话里，不是长在输入框旁边。 */
function runIndicatorMarkup(elapsedText) {
  return (
    '<div class="turn-running"><span class="turn-running-dot"></span>' +
    '<span>运行中</span>' +
    '<span class="turn-elapsed">' + escapeHtml(elapsedText) + '</span></div>'
  );
}

/* 一秒一跳，只改计时那一个文本节点；页面在后台或没在跑就什么都不动。 */
function tickRunTimer() {
  if (document.hidden || !state.runStarted) return;
  const elapsed = dom.turns.querySelector('.turn-elapsed');
  if (!elapsed) return;
  elapsed.textContent = formatElapsed(Date.now() / 1000 - state.runStarted.at);
}

function serverUserMessages() {
  const items = [];
  for (const turn of state.turns) {
    for (const item of turn.items || []) {
      if (item.type !== 'userMessage') continue;
      if (item.id && String(item.id).startsWith('local-')) continue;
      items.push({
        turnId: turn.id,
        text: (item.content || [])
          .map((part) => (typeof part === 'string' ? part : part.text || ''))
          .join('\n')
          .trim(),
      });
    }
  }
  return items;
}

/* Every optimistic echo claims at most one server-side user message, matched by
   turn id first and by text second. Anything left over has not come back from
   the server yet and still has to be rendered. */
function uncoveredEchoes() {
  const items = serverUserMessages();
  const claimed = new Set();
  const remaining = [];
  for (const echo of state.pendingEchoes) {
    /* 发完消息切走的那个会话里的回显，不该跑到现在这个会话里来 */
    if (echo.threadId && echo.threadId !== state.currentThreadId) continue;
    const key = String(echo.text).trim();
    /* 认领必须文本一致：同一轮里可以插进好几条输入（引导、排队插进正在跑的那轮），
       光看 turnId 会把别人的那条算成自己的——那条消息就再也不会显示出来了。 */
    let index = items.findIndex(
      (item, position) =>
        !claimed.has(position) && item.text === key && echo.turnId && item.turnId === echo.turnId
    );
    if (index === -1) {
      index = items.findIndex((item, position) => !claimed.has(position) && item.text === key);
    }
    if (index === -1) remaining.push(echo);
    else claimed.add(index);
  }
  return remaining;
}

/* Once the thread is idle the server read is authoritative, so echoes it
   already contains can be dropped for good. */
function finalizeEchoes() {
  if (state.pendingEchoes.length === 0) return;
  if (state.turns.some((turn) => turn.status === 'inProgress')) return;
  state.pendingEchoes = uncoveredEchoes().filter((echo) => {
    /* 归属的那一轮已经跑完、也读回来了，却始终没有对应记录：daemon 不会再补这条了，
       留着就会永远挂着一块幽灵气泡。没有归属的（排队中）还留着。 */
    const turnId = echo.anchor && echo.anchor.turnId;
    if (!turnId) return true;
    const turn = findTurn(turnId);
    if (!turn) return true;
    return turn.status === 'inProgress';
  });
}

/* 一条记录都没裁掉的会话走不到这里；裁过的话顶部会有个按钮可以往回翻。 */
const LOAD_EARLIER_STEP = 500;

async function loadEarlierItems() {
  if (!state.currentThreadId) return;
  /* 内容会插在顶部，用「距底部的距离」当锚点，滚回原来那条记录 */
  const fromBottom = dom.turns.scrollHeight - dom.turns.scrollTop;
  state.itemLimit = (state.itemLimit || 500) + LOAD_EARLIER_STEP;
  state.pinnedToBottom = false;
  await openThread(state.currentThreadId, { silent: true });
  dom.turns.scrollTop = dom.turns.scrollHeight - fromBottom;
}

function renderThread() {
  if (!state.currentThreadId) return;

  const active = threadRunning();
  renderComposerButtons(active);
  renderPending();
  renderHeaderSubtitle();

  const started = syncRunStarted();
  const parts = [];
  /* 还没被服务端确认的回显（乐观显示的那条用户消息）：
     - 知道它会落到哪一轮、落在哪条记录之后的，就插回那一轮的原位。daemon 要到下一个
       模型回合才把「引导 / 插进正在跑的那一轮」的输入记成一条记录（实测十几秒到几十
       秒），这段时间里回显必须停在自己那一轮的位置上；甩到整个会话末尾的话，看起来
       就成了「回答跑在我这条消息上面」。
     - 没有归属的（比如被 daemon 排队、还不知道会落到哪一轮）才贴在会话末尾。 */
  const anchored = new Map();
  const loose = [];
  for (const echo of uncoveredEchoes()) {
    const target = echo.anchor && echo.anchor.turnId ? findTurn(echo.anchor.turnId) : null;
    if (!target) {
      loose.push(echo);
      continue;
    }
    if (!anchored.has(target.id)) anchored.set(target.id, new Map());
    const byItem = anchored.get(target.id);
    const key = echo.anchor.itemId || '';
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(echo);
  }
  if (state.omittedItems > 0) {
    parts.push(
      '<div class="older-row"><button type="button" data-load-earlier="1">⇡ 显示更早的 ' +
        LOAD_EARLIER_STEP +
        ' 条（还有 ' +
        state.omittedItems +
        ' 条没显示）</button></div>'
    );
  }
  for (const turn of state.turns) {
    const running = turn.status === 'inProgress' ? ' running' : '';
    const items = turn.items || [];
    const byItem = anchored.get(turn.id);
    const body = [];
    if (byItem && items.length === 0) {
      for (const echo of byItem.get('') || []) body.push(renderEcho(echo));
    }
    const placed = new Set();
    for (const item of items) {
      body.push(renderItem(item));
      if (byItem && byItem.has(item.id)) {
        for (const echo of byItem.get(item.id)) body.push(renderEcho(echo));
        placed.add(item.id);
      }
    }
    if (byItem) {
      /* 锚点那条记录在这一轮里找不到（读回来的内容被裁过、或者被摘要覆盖了）：兜底放到这一轮末尾 */
      for (const [itemId, list] of byItem) {
        if (itemId && placed.has(itemId)) continue;
        if (!itemId && items.length === 0) continue;
        for (const echo of list) body.push(renderEcho(echo));
      }
    }
    const error = turn.error
      ? '<div class="item" style="color:var(--danger);font-size:13px">' +
        escapeHtml(turn.error.message || JSON.stringify(turn.error)) +
        '</div>'
      : '';
    parts.push(
      '<div class="turn' + running + '" data-turn-id="' + escapeHtml(turn.id) + '">' +
        body.join('') +
        renderPlan(turn.id) +
        error +
        '</div>'
    );
  }
  for (const echo of loose) {
    parts.push(
      '<div class="turn local-echo" data-turn-id="' + escapeHtml(echo.turnId || 'local') + '">' +
        renderEcho(echo) +
        '</div>'
    );
  }

  if (started) parts.push(runIndicatorMarkup(formatElapsed(Date.now() / 1000 - started.at)));

  dom.turns.innerHTML = parts.join('');
  observeTurnSizes();
}

/* 乐观回显的那条消息：先用本地内容画出来，等服务端把同一条记进会话里再撤掉。 */
function renderEcho(echo) {
  const bubble = renderItem({
    id: 'local-' + (echo.turnId || 'pending'),
    type: 'userMessage',
    content: [{ type: 'text', text: echo.text }],
  });
  /* 被 daemon 排队的（电脑端占着这个会话）要说明白：它会在这之后才跑，不是在等回复 */
  const tag = echo.queued
    ? '<div class="echo-tag">排队中 · 电脑端这一轮跑完就执行</div>'
    : '';
  return bubble + tag;
}

function approvalTitle(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return '请求执行命令';
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return '请求修改文件';
    case 'item/permissions/requestApproval':
      return '请求权限';
    case 'item/tool/requestUserInput':
      return '需要你的回答';
    case 'mcpServer/elicitation/request':
      return 'MCP 请求';
    default:
      return '需要你的确认';
  }
}

function approvalDetail(record) {
  const params = record.params || {};
  if (record.method === 'item/commandExecution/requestApproval' || record.method === 'execCommandApproval') {
    const lines = [];
    if (params.reason) lines.push(params.reason);
    if (params.command) lines.push(params.command);
    if (params.cwd) lines.push('cwd: ' + params.cwd);
    if (params.networkApprovalContext) {
      lines.push('网络: ' + (params.networkApprovalContext.host || '') + ' ' + (params.networkApprovalContext.protocol || ''));
    }
    return lines.join('\n');
  }
  if (record.method === 'item/fileChange/requestApproval' || record.method === 'applyPatchApproval') {
    const files = (params.changes || []).map((change) => change.path).filter(Boolean);
    return [params.reason, params.grantRoot ? 'root: ' + params.grantRoot : '', ...files]
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(params, null, 1).slice(0, 2000);
}

function renderApprovals() {
  const relevant = [...state.pendingApprovals.values()].filter(
    (record) => !state.currentThreadId || (record.params && record.params.threadId === state.currentThreadId)
  );

  dom.approvalSlot.innerHTML = '';

  for (const record of relevant) {
    const card = document.createElement('div');
    card.className = 'approval';

    if (record.method === 'item/tool/requestUserInput') {
      card.innerHTML =
        '<div class="head">' + approvalTitle(record.method) + '</div>' +
        ((record.params && record.params.questions) || [])
          .map(
            (question) =>
              '<div style="margin-bottom:6px"><div style="font-size:13px">' +
              escapeHtml(question.question || '') +
              '</div><input data-question-id="' + escapeHtml(question.id) + '" style="width:100%;margin-top:4px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text)" /></div>'
          )
          .join('') +
        '<div class="actions"><button class="primary" data-action="answers">提交</button></div>';
    } else {
      card.innerHTML =
        '<div class="head">' + approvalTitle(record.method) + '</div>' +
        '<div class="detail">' + escapeHtml(approvalDetail(record)) + '</div>' +
        '<div class="actions">' +
        '<button class="primary" data-decision="accept">允许</button>' +
        '<button data-decision="acceptForSession">本会话都允许</button>' +
        '<button class="danger" data-decision="decline">拒绝</button>' +
        '<button class="danger" data-decision="cancel">拒绝并中断</button>' +
        '</div>';
    }

    card.addEventListener('click', async (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      target.disabled = true;

      try {
        let body;
        if (target.dataset.action === 'answers') {
          const answers = {};
          for (const input of card.querySelectorAll('input[data-question-id]')) {
            answers[input.dataset.questionId] = { answers: [input.value] };
          }
          body = { answers };
        } else {
          body = { decision: target.dataset.decision };
        }
        await api('/api/approvals/' + encodeURIComponent(record.requestId) + '/respond', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        state.pendingApprovals.delete(String(record.requestId));
        renderApprovals();
        renderList();
      } catch (error) {
        target.disabled = false;
        toast('提交失败：' + error.message);
      }
    });

    dom.approvalSlot.appendChild(card);
  }
}

function loadShelved() {
  try {
    const raw = localStorage.getItem('codex.shelved');
    state.shelvedThreads = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.shelvedThreads)) state.shelvedThreads = [];
  } catch (error) {
    state.shelvedThreads = [];
  }
}

function saveShelved() {
  try {
    localStorage.setItem('codex.shelved', JSON.stringify(state.shelvedThreads));
  } catch (error) {
    /* ignore */
  }
}

function shelveThread(thread, name) {
  if (!thread || !thread.id) return;
  state.shelvedThreads = state.shelvedThreads.filter((entry) => entry.id !== thread.id);
  state.shelvedThreads.unshift({
    id: thread.id,
    name: name || thread.name || '',
    preview: thread.preview || '',
    cwd: thread.environments && thread.environments[0] ? thread.environments[0].cwd : '',
    model: thread.model || '',
    updatedAt: Math.floor(Date.now() / 1000),
    status: { type: 'idle' },
  });
  saveShelved();
}

function mergeShelved(threads) {
  const seen = new Set(threads.map((thread) => thread.id));
  state.shelvedThreads = state.shelvedThreads.filter((entry) => !seen.has(entry.id));
  saveShelved();
  return state.shelvedThreads.concat(threads);
}

async function loadThreads() {
  try {
    const result = await api('/api/threads?limit=40');
    state.threads = mergeShelved(result.data || []);
    renderList();
    pruneShelved();
  } catch (error) {
    toast('加载会话失败：' + error.message);
  }
}

/* 本地那份「刚建好、daemon 还没收录」的会话列表（codex.shelved）里可能留下幽灵：
   比如这个会话已经在电脑上被删掉了。daemon 会明确回 "thread not loaded"，据此清掉。

   但反过来误判的代价极大：会话一旦被移出侧边栏就再也回不来了（daemon 的
   thread/list 里根本没有这种刚建好、还没跑过话的会话）。而刚建好的那一刻、
   或者桥接刚重启的那一下，读失败一次是常事。所以这里加三重保险：
   至少 10 分钟后才判、必须连续两次读失败、每次最多查几个。 */
const SHELVED_RECHECK_MS = 5 * 60 * 1000;
const SHELVED_MIN_AGE_MS = 10 * 60 * 1000;
const SHELVED_FAILS_TO_DROP = 2;
const SHELVED_PROBES_PER_PASS = 5;
const shelvedCheckedAt = new Map();
const shelvedFails = new Map();

/* 本地列表里这个会话，daemon 那边已经没有了（「幽灵」）。
   一次失败不算数：桥接刚重启、会话刚建好都可能读失败一次，
   连续两次才认，并把它从侧边栏摘掉。 */
function noteMissingShelfThread(threadId) {
  if (!state.shelvedThreads.some((entry) => entry.id === threadId)) return false;
  const fails = (shelvedFails.get(threadId) || 0) + 1;
  if (fails < SHELVED_FAILS_TO_DROP) {
    shelvedFails.set(threadId, fails);
    return false;
  }
  shelvedFails.delete(threadId);
  shelvedCheckedAt.delete(threadId);
  state.shelvedThreads = state.shelvedThreads.filter((entry) => entry.id !== threadId);
  state.threads = state.threads.filter((thread) => thread.id !== threadId);
  saveShelved();
  return true;
}

async function pruneShelved() {
  const shelf = state.shelvedThreads.slice();
  if (!shelf.length) return;
  /* 这个检查是 loadThreads() 每次（10 秒）都会跑的，而一次会话读取再怎么裁也有
     几百 KB，所以：只用 limit=1 问个「还在不在」，而且同一个会话 5 分钟内只问一次。 */
  const now = Date.now();
  const due = shelf.filter((entry) => {
    const stamp = Math.max(entry.updatedAt || 0, entry.createdAt || 0) * 1000;
    if (stamp && now - stamp < SHELVED_MIN_AGE_MS) return false;
    return now - (shelvedCheckedAt.get(entry.id) || 0) > SHELVED_RECHECK_MS;
  });
  if (!due.length) return;
  const gone = [];
  for (const entry of due.slice(0, SHELVED_PROBES_PER_PASS)) {
    shelvedCheckedAt.set(entry.id, now);
    try {
      await api('/api/threads/' + encodeURIComponent(entry.id) + '?limit=1');
      shelvedFails.delete(entry.id);
    } catch (error) {
      const message = error && error.message ? error.message : '';
      if (!/thread not loaded|no rollout found|not found/i.test(message)) continue;
      if (noteMissingShelfThread(entry.id)) gone.push(entry.id);
    }
  }
  if (!gone.length) return;
  const drop = new Set(gone);
  for (const id of drop) {
    shelvedCheckedAt.delete(id);
    shelvedFails.delete(id);
  }
  state.shelvedThreads = state.shelvedThreads.filter((entry) => !drop.has(entry.id));
  state.threads = state.threads.filter((thread) => !drop.has(thread.id));
  saveShelved();
  renderList();
}

function loadPinned() {
  try {
    const raw = localStorage.getItem('codex.pinned');
    state.pinned = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.pinned)) state.pinned = [];
  } catch (error) {
    state.pinned = [];
  }
}

function savePinned() {
  try {
    localStorage.setItem('codex.pinned', JSON.stringify(state.pinned));
  } catch (error) {
    /* ignore */
  }
}

function isPinned(threadId) {
  return state.pinned.includes(threadId);
}

function togglePin() {
  const threadId = state.currentThreadId;
  if (!threadId) {
    toast('先打开一个会话');
    return;
  }
  if (isPinned(threadId)) state.pinned = state.pinned.filter((id) => id !== threadId);
  else state.pinned = [threadId].concat(state.pinned);
  savePinned();
  updateThreadActions();
  renderList();
  toast(isPinned(threadId) ? '已置顶' : '已取消置顶');
}

function updateThreadActions() {
  const has = Boolean(state.currentThreadId);
  dom.renameButton.hidden = !has;
  dom.pinButton.hidden = !has;
  dom.pinButton.textContent = has && isPinned(state.currentThreadId) ? '★' : '☆';
  const ephemeral = Boolean(state.thread && state.thread.ephemeral);
  dom.ephemeralClose.hidden = !ephemeral;
}

/* 「新建对话」里的项目下拉：选中项目 = 把它的根目录当工作文件夹填上，
   省得手打路径（打错或者打偏了，会话就归不到那个项目底下）。 */
function renderProjectOptions(selectedRoot) {
  if (!dom.newChatProject) return;
  const current = selectedRoot === undefined ? dom.newChatProject.value : selectedRoot;
  const options = [{ value: '', label: '不指定（自己填路径）' }];
  for (const project of state.projects) {
    const root = projectRoot(project);
    if (!root) continue;
    options.push({ value: root, label: project.name || root });
  }
  dom.newChatProject.innerHTML = options
    .map(
      (option) =>
        '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>'
    )
    .join('');
  const hit = options.find((option) => option.value === current);
  dom.newChatProject.value = hit ? hit.value : '';
}

/* options.cwd / options.projectName：从项目那一行的 ＋ 进来时预填好工作文件夹 */
function openNewChatPanel(options) {
  const preset = options || {};
  dom.newChatModal.hidden = false;
  dom.newChatName.value = '';
  const presetCwd = preset.cwd || localStorage.getItem('codex.lastCwd') || '';
  dom.newChatCwd.value = presetCwd;
  renderProjectOptions(presetCwd);
  dom.newChatPermission.value = 'default';
  dom.newChatPin.checked = true;
  dom.newChatHeading.textContent = preset.projectName
    ? '在「' + preset.projectName + '」下新建对话'
    : '新建对话';
  requestAnimationFrame(() => dom.newChatName.focus());
}

function closeNewChatPanel() {
  dom.newChatModal.hidden = true;
}

async function submitNewChat() {
  const name = dom.newChatName.value.trim().slice(0, 120);
  const cwd = dom.newChatCwd.value.trim();
  const permission = dom.newChatPermission.value || 'default';
  const shouldPin = dom.newChatPin.checked;
  closeNewChatPanel();
  const thread = await createThread({ name, cwd, permission, pin: shouldPin });
  if (thread) toast(name ? '已创建「' + name + '」' : '新对话已创建，可点 ✎ 重命名');
}

async function createThread(options) {
  const name = (options.name || '').trim().slice(0, 120);
  const cwd = (options.cwd || '').trim();
  const permission = options.permission || 'default';
  const ephemeral = options.ephemeral === true;
  const shouldPin = options.pin !== false && !ephemeral;
  dom.newChatButton.disabled = true;
  try {
    const result = await api('/api/new-thread', {
      method: 'POST',
      body: JSON.stringify({ name, cwd, permission, ephemeral }),
    });
    if (cwd) localStorage.setItem('codex.lastCwd', cwd);
    const thread = result?.thread;
    if (thread && thread.id) {
      if (ephemeral) thread.ephemeral = true;
      else shelveThread(thread, name);
      if (shouldPin) {
        state.pinned = [thread.id].concat(state.pinned.filter((id) => id !== thread.id));
        savePinned();
      }
    }
    await loadThreads();
    if (thread && thread.id) {
      await openThread(thread.id);
    } else {
      renderPlaceholder();
    }
    return thread || null;
  } catch (error) {
    toast('新建失败：' + error.message);
    return null;
  } finally {
    dom.newChatButton.disabled = false;
  }
}

function openNewProjectPanel() {
  dom.newProjectModal.hidden = false;
  dom.newProjectName.value = '';
  dom.newProjectPath.value = suggestedProjectPath();
  requestAnimationFrame(() => dom.newProjectName.focus());
}

function closeNewProjectPanel() {
  dom.newProjectModal.hidden = true;
}

/* 自动生成的聊天目录（~/Documents/Codex/...）不该当项目路径预填 */
function suggestedProjectPath() {
  const cwd = state.thread && state.thread.cwd ? state.thread.cwd : '';
  if (!cwd || cwd.includes('/Documents/Codex/')) return '';
  return cwd;
}

async function loadProjects() {
  try {
    const result = await api('/api/projects');
    state.projects = Array.isArray(result.data) ? result.data : [];
  } catch (error) {
    state.projects = [];
  }
  renderList();
}

async function submitNewProject() {
  const name = dom.newProjectName.value.trim().slice(0, 120);
  const projectPath = dom.newProjectPath.value.trim();
  if (!name) {
    toast('先给项目起个名字');
    return;
  }
  if (!projectPath) {
    toast('填一下项目文件夹的绝对路径');
    return;
  }
  closeNewProjectPanel();
  dom.projectAdd.disabled = true;
  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, path: projectPath }),
    });
    await loadProjects();
    toast('已创建项目「' + name + '」');
  } catch (error) {
    toast('新建项目失败：' + error.message);
  } finally {
    dom.projectAdd.disabled = false;
  }
}

/* 临时对话 = daemon 的 ephemeral 会话：不写盘、不进历史，桥接重启后就没有了 */
async function openEphemeralChat() {
  await createThread({ ephemeral: true, cwd: localStorage.getItem('codex.lastCwd') || '' });
}

async function closeEphemeralThread() {
  const threadId = state.currentThreadId;
  if (!threadId) return;
  try {
    await api('/api/ephemeral/close', {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    });
  } catch (error) {
    /* 关掉本地视图比报错更重要 */
  }
  state.shelvedThreads = state.shelvedThreads.filter((entry) => entry.id !== threadId);
  saveShelved();
  state.currentThreadId = null;
  state.thread = null;
  state.turns = [];
  state.pendingEchoes = [];
  await loadThreads();
  renderPlaceholder();
  updateThreadActions();
  toast('临时对话已结束');
}

async function renameCurrentThread() {
  if (!state.currentThreadId) return;
  const current = state.thread?.name || dom.title.textContent || '';
  const name = (window.prompt('会话名称', current) || '').trim();
  if (!name || name === current) return;
  try {
    await api('/api/threads/' + encodeURIComponent(state.currentThreadId) + '/name', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (state.thread) state.thread.name = name;
    state.shelvedThreads = state.shelvedThreads.map((entry) =>
      entry.id === state.currentThreadId ? Object.assign({}, entry, { name }) : entry
    );
    saveShelved();
    dom.title.textContent = name;
    loadThreads();
    toast('已重命名');
  } catch (error) {
    toast('重命名失败：' + error.message);
  }
}

function saveDraft(threadId) {
  if (!threadId) return;
  state.drafts.set(threadId, {
    text: dom.messageInput.value,
    attachments: state.attachments.slice(),
  });
}

function restoreDraft(threadId) {
  const draft = state.drafts.get(threadId);
  dom.messageInput.value = draft ? draft.text : '';
  dom.messageInput.style.height = 'auto';
  state.attachments = draft ? draft.attachments.slice() : [];
  renderAttachments();
}

async function openThread(threadId, options) {
  const silent = Boolean(options && options.silent);
  if (!silent) {
    const switching = state.currentThreadId !== threadId;
    if (switching && state.currentThreadId) saveDraft(state.currentThreadId);
    if (switching) restoreDraft(threadId);
    state.currentThreadId = threadId;
    if (switching) {
      state.turns = [];
      state.pendingEchoes = [];
      state.turnDiffs = new Map();
      state.planSteps = new Map();
      state.itemLimit = 500;
      state.omittedItems = 0;
    }
    dom.composer.hidden = false;
    dom.threadMeta.textContent = '';
    dom.turns.innerHTML = '<p style="color:var(--text-faint)">载入中…</p>';
    renderList();
    if (isNarrow()) closeSidebar();
  } else if (state.currentThreadId !== threadId) {
    return;
  }

  try {
    const result = await api(
      '/api/threads/' + encodeURIComponent(threadId) + '?limit=' + (state.itemLimit || 500)
    );
    if (silent && state.currentThreadId !== threadId) return;
    state.thread = result.thread;
    state.omittedItems = Number(state.thread && state.thread.omittedItems) || 0;
    state.permission = result.permission || { mode: 'default', effective: null };
    updateThreadActions();
    /* 正在跑的那一轮，服务端读回来的内容可能是不全的（实测工具调用那条会消失十几秒，
       要等命令跑完才落盘）。整块替换会让界面上已经有的记录凭空少掉，连带把本地的乐观
       回显又挤回对话流末尾。所以进行中的轮次跟内存里已有的记录合并一次：以读回来的为
       准，只补回它还没有的那几条。 */
    state.turns = (result.thread.turns || []).map((turn) => {
      const next = Object.assign({}, turn, { items: turn.items || [] });
      const previous = findTurn(next.id);
      const keepExtra = previous && (next.status === 'inProgress' || previous.status === 'inProgress');
      if (!keepExtra) return next;
      const known = new Set(next.items.map((item) => item && item.id));
      const extra = (previous.items || []).filter((item) => item && item.id && !known.has(item.id));
      return extra.length ? Object.assign({}, next, { items: next.items.concat(extra) }) : next;
    });
    /* 临时会话的内容不落盘，daemon 读不回来：用桥接缓存的事件日志重建 */
    if (Array.isArray(result.events) && result.events.length) applyEventLog(result.events);
    /* 服务端读回来的 turn 状态才算准：内存里的 activeTurns 跟它对齐一次。被中断的
       那一轮 daemon 不发 turn/completed，不校准的话界面会一直显示「运行中」，挂在
       输入框上面的待发消息也永远等不到自动发。 */
    if (state.turns.length > 0) {
      const runningTurn = [...state.turns].reverse().find((turn) => turn.status === 'inProgress');
      if (runningTurn) state.activeTurns[threadId] = runningTurn.id;
      else delete state.activeTurns[threadId];
    }
    finalizeEchoes();
    dom.title.textContent = (state.thread.name || state.thread.preview || '会话').slice(0, 60);
    dom.threadMeta.textContent = [state.thread.cwd, state.thread.model].filter(Boolean).join(' · ');
    renderPermission();
    renderThread();
    renderApprovals();
    saveLastThread(threadId);
    /* 这一轮要是已经跑完了，挂在输入框上面的那条该自动发出去（完成通知可能没收到） */
    flushPending(threadId);
    if (silent) {
      if (state.pinnedToBottom) scrollTurnsToBottom();
    } else {
      pinToBottomSoon();
    }
  } catch (error) {
    if (!silent) {
      dom.turns.innerHTML = '<p style="color:var(--danger)">载入失败：' + escapeHtml(error.message) + '</p>';
      /* 用户亲自点开却读不到，这个信号比后台探测可信得多；连点两次就把这条幽灵
         从侧边栏拿掉，否则它会一直挂在列表里，点一次报一次错。 */
      const message = error && error.message ? error.message : '';
      if (
        /thread not loaded|no rollout found|not found/i.test(message) &&
        noteMissingShelfThread(threadId)
      ) {
        renderList();
        toast('这个会话在电脑上已经不存在了，已从列表移除');
        if (state.currentThreadId === threadId) {
          state.currentThreadId = null;
          state.thread = null;
          state.turns = [];
          renderPlaceholder();
        }
      }
    }
  }
}

function refreshIfVisible() {
  if (document.hidden) return;
  loadThreads();
  if (!state.currentThreadId) return;
  if (threadRunning() && Date.now() - state.lastEventAt < 8000) return;
  openThread(state.currentThreadId, { silent: true });
}

function attachStripEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAttachments() {
  const list = state.attachments;
  dom.attachStrip.hidden = list.length === 0;
  dom.attachStrip.innerHTML = list
    .map(
      (att, index) =>
        '<div class="attach-item"><img src="' +
        attachStripEscape(att.dataUrl) +
        '" alt="附图" /><button type="button" class="attach-remove" data-index="' +
        index +
        '" aria-label="移除">✕</button></div>'
    )
    .join('');
  /* 有附图时「运行中 + 有内容」也成立，引导按钮的显隐跟着一起更新 */
  renderComposerButtons();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function downscaleDataUrl(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const longest = Math.max(image.width, image.height);
      if (longest <= maxEdge) {
        resolve(dataUrl);
        return;
      }
      const scale = maxEdge / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (error) {
        resolve(dataUrl);
      }
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

async function handleAttachFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (state.attachments.length >= 6) {
      toast('最多一次 6 张图片');
      break;
    }
    try {
      const raw = await fileToDataUrl(file);
      const dataUrl = await downscaleDataUrl(raw);
      state.attachments.push({ dataUrl, name: file.name || 'image' });
    } catch (error) {
      toast('添加图片失败：' + error.message);
    }
  }
  renderAttachments();
}

/* 真正把一条消息发出去：上传图片 → POST → 乐观回显。运行中排队的那条跑完自动
   发的时候也走这里，只是晚一点调用。 */
async function deliverMessage(threadId, text, attachments, options) {
  const steer = Boolean(options && options.steer);
  /* Show the message immediately instead of waiting for the round trip; the
     echo is dropped as soon as the server reports the same turn. */
  const echo = text ? { threadId, turnId: null, text } : null;
  if (echo) {
    state.pendingEchoes.push(echo);
    scheduleRender();
  }
  try {
    const images = [];
    for (const attachment of attachments || []) {
      const uploaded = await api('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl: attachment.dataUrl }),
      });
      if (uploaded && uploaded.path) images.push(uploaded.path);
    }
    const result = await api('/api/threads/' + encodeURIComponent(threadId) + '/message', {
      method: 'POST',
      body: JSON.stringify(steer ? { text, images, steer: true } : { text, images }),
    });
    const turnId =
      (result && result.turn && result.turn.id) ||
      (result && result.turnId) ||
      'queued-' + Date.now();
    if (result && (result.mode === 'started' || result.mode === 'steered')) {
      state.activeTurns[threadId] = turnId;
    }
    if (echo) {
      echo.turnId = turnId;
      /* 这条回显最终会落到哪一轮、落在哪条记录之后，现在就定下来（此刻那一轮里已有的
         最后一条记录，就是它会插进去的位置）。渲染时按这个锚点插回会话流里。 */
      const target = findTurn(turnId);
      echo.anchor = target
        ? {
            turnId: target.id,
            itemId: (target.items || []).length
              ? target.items[target.items.length - 1].id
              : null,
          }
        : null;
      echo.queued = Boolean(result && result.mode === 'queued');
    }
    scheduleRender();
    /* 引导 / 排队都不再弹悬浮提示：引导过去之后这条消息本身就立刻插在那条会话里，
       排队的情况回显下面会挂一行「排队中 · 电脑端这一轮跑完就执行」，再弹一次是噪音。 */
    return result || {};
  } catch (error) {
    if (echo) state.pendingEchoes = state.pendingEchoes.filter((candidate) => candidate !== echo);
    scheduleRender();
    throw error;
  }
}

/* ---------- 运行中「挂起来」的待发消息 ---------- */

/* 桌面版就是这样：跑的时候按发送，消息不打断当前对话，而是浮在输入框上面等着，
   这一轮跑完自动发出去；想让它插进正在跑的这一轮，点那条上的「引导」。 */

const PENDING_PREVIEW_CHARS = 60;

function pendingList(threadId) {
  return (threadId && state.pending[threadId]) || [];
}

function queuePending(threadId, text, attachments) {
  const list = state.pending[threadId] || (state.pending[threadId] = []);
  list.push({
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    attachments: attachments || [],
  });
  savePending();
  renderPending();
}

function takePending(threadId, id) {
  const list = state.pending[threadId];
  if (!list) return null;
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const item = list[index];
  list.splice(index, 1);
  if (list.length === 0) delete state.pending[threadId];
  savePending();
  renderPending();
  return item;
}

async function steerPending(threadId, id) {
  const item = pendingList(threadId).find((candidate) => candidate.id === id);
  if (!item) return;
  try {
    await deliverMessage(threadId, item.text, item.attachments, { steer: true });
    takePending(threadId, id);
  } catch (error) {
    toast('引导失败：' + error.message);
  } finally {
    renderComposerButtons();
  }
}

/* 这一轮跑完了：把挂在上面那条自动发出去。多条的话一条一条来，下一条等下一轮。 */
async function flushPending(threadId) {
  if (!threadId || state.flushing[threadId]) return;
  const list = pendingList(threadId);
  if (list.length === 0) return;
  if (threadRunning(threadId)) return;
  const item = list[0];
  state.flushing[threadId] = true;
  try {
    await deliverMessage(threadId, item.text, item.attachments, {});
    takePending(threadId, item.id);
  } catch (error) {
    toast('待发消息没发出去：' + error.message + '（还挂在输入框上面，可以重试或删掉）');
  } finally {
    delete state.flushing[threadId];
  }
}

function renderPending() {
  const list = pendingList(state.currentThreadId);
  dom.pendingStrip.hidden = list.length === 0;
  if (list.length === 0) {
    dom.pendingStrip.innerHTML = '';
    return;
  }
  dom.pendingStrip.innerHTML = list
    .map((item) => {
      const flat = String(item.text || '').replace(/\s+/g, ' ').trim();
      const preview = flat.length > PENDING_PREVIEW_CHARS ? flat.slice(0, PENDING_PREVIEW_CHARS) + '…' : flat;
      const images = (item.attachments || []).length;
      const label = (preview || '图片') + (images ? '（含 ' + images + ' 张图）' : '');
      return (
        '<div class="pending-item">' +
        '<span class="pending-tag">待发</span>' +
        '<span class="pending-text" title="' +
        escapeHtml(flat) +
        '">' +
        escapeHtml(label) +
        '</span>' +
        '<button type="button" class="pending-steer" data-steer-pending="' +
        escapeHtml(item.id) +
        '" title="引导：插进正在跑的这一轮，让它立刻按这条走">引导</button>' +
        '<button type="button" class="pending-remove" data-remove-pending="' +
        escapeHtml(item.id) +
        '" aria-label="撤下这条待发消息" title="撤下">✕</button>' +
        '</div>'
      );
    })
    .join('');
}

function loadPending() {
  try {
    const raw = localStorage.getItem('codex.pending');
    const parsed = raw ? JSON.parse(raw) : {};
    state.pending = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    state.pending = {};
  }
}

function savePending() {
  try {
    if (Object.keys(state.pending).length === 0) localStorage.removeItem('codex.pending');
    else localStorage.setItem('codex.pending', JSON.stringify(state.pending));
  } catch (error) {
    /* 图片太多撑爆配额：留着内存里那份就行，别把整个待发列表弄丢 */
  }
}

async function sendMessage(options) {
  const steer = Boolean(options && options.steer);
  const text = dom.messageInput.value.trim();
  /* 这一条消息属于哪个会话，在函数开头就定死：上传图片要花几秒，中间用户完全
     可能切到别的会话去，之后再读 state.currentThreadId 就发错人 / 记错人了。 */
  const threadId = state.currentThreadId;
  if (!threadId) return;
  if (!text && state.attachments.length === 0) return;

  const attachments = state.attachments;

  /* 运行中还没点「引导」：挂到输入框上面，不打断当前这一轮 */
  if (!steer && threadRunning(threadId)) {
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
    state.drafts.delete(threadId);
    state.attachments = [];
    renderAttachments();
    queuePending(threadId, text, attachments);
    renderComposerButtons();
    /* 挂起来的那条显示在输入框正上方（带「引导 / 删除」），不用再弹提示框 */
    return;
  }

  dom.sendButton.disabled = true;
  dom.messageInput.value = '';
  dom.messageInput.style.height = 'auto';
  state.drafts.delete(threadId);
  state.attachments = [];
  renderAttachments();
  renderComposerButtons();

  try {
    await deliverMessage(threadId, text, attachments, { steer });
  } catch (error) {
    dom.messageInput.value = text;
    state.attachments = attachments.concat(state.attachments);
    renderAttachments();
    toast('发送失败：' + error.message);
  } finally {
    dom.sendButton.disabled = false;
    renderComposerButtons();
  }
}

async function interrupt() {
  const threadId = state.currentThreadId;
  if (!threadId) return;
  dom.stopButton.disabled = true;
  try {
    await api('/api/threads/' + encodeURIComponent(threadId) + '/interrupt', {
      method: 'POST',
    });
    /* 中断成功这一轮马上就结束了；本地先撤掉「运行中」，挂着的待发消息不用干等通知 */
    delete state.activeTurns[threadId];
    renderThread();
    setTimeout(() => {
      flushPending(threadId);
    }, 1500);
  } catch (error) {
    toast('中断失败：' + error.message);
  } finally {
    dom.stopButton.disabled = false;
  }
}

function refreshCurrent() {
  loadThreads();
  if (state.currentThreadId) openThread(state.currentThreadId);
}

function bindEvents() {
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.sidebarClose.addEventListener('click', closeSidebar);
  dom.sidebarRefresh.addEventListener('click', refreshCurrent);
  dom.scrim.addEventListener('click', closeSidebar);
  dom.refreshButton.addEventListener('click', refreshCurrent);
  dom.themeButton.addEventListener('click', cycleTheme);
  dom.newChatButton.addEventListener('click', () => openNewChatPanel());
  dom.newChatCancel.addEventListener('click', closeNewChatPanel);
  if (dom.newChatProject) {
    dom.newChatProject.addEventListener('change', () => {
      if (dom.newChatProject.value) dom.newChatCwd.value = dom.newChatProject.value;
    });
  }
  /* 手改了路径就不再声称「选了某个项目」，免得创建时用的还是旧的项目根目录 */
  dom.newChatCwd.addEventListener('input', () => {
    if (!dom.newChatProject || !dom.newChatProject.value) return;
    if (dom.newChatCwd.value.trim() !== dom.newChatProject.value) dom.newChatProject.value = '';
  });
  dom.newChatCreate.addEventListener('click', submitNewChat);
  dom.newChatModal.addEventListener('click', (event) => {
    if (event.target === dom.newChatModal) closeNewChatPanel();
  });
  dom.sidebarNewChat.addEventListener('click', () => openNewChatPanel());
  dom.sidebarNewEphemeral.addEventListener('click', openEphemeralChat);
  dom.projectAdd.addEventListener('click', openNewProjectPanel);
  dom.newProjectCancel.addEventListener('click', closeNewProjectPanel);
  dom.newProjectCreate.addEventListener('click', submitNewProject);
  dom.newProjectModal.addEventListener('click', (event) => {
    if (event.target === dom.newProjectModal) closeNewProjectPanel();
  });
  for (const input of [dom.newProjectName, dom.newProjectPath]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitNewProject();
      } else if (event.key === 'Escape') {
        closeNewProjectPanel();
      }
    });
  }
  dom.ephemeralClose.addEventListener('click', closeEphemeralThread);
  /* 一键复制：代码块 / 命令输出整段，链接后面的图标复制真实地址 */
  dom.turns.addEventListener('click', (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('.copy-btn') : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const value = copyValueFor(button);
    if (!value) {
      toast('没找到要复制的内容');
      return;
    }
    const original = button.innerHTML;
    copyText(value).then((ok) => {
      if (!ok) {
        toast('复制失败，请长按选中文字复制');
        return;
      }
      button.innerHTML = CHECK_ICON;
      button.classList.add('copied');
      setTimeout(() => {
        button.innerHTML = original;
        button.classList.remove('copied');
      }, 1200);
      toast('已复制：' + (value.length > 42 ? value.slice(0, 42) + '…' : value));
    });
  });

  /* 回复里的 url 要能直接点开。锚点本来就是 target="_blank"，但手机上的内置浏览器
     （以及某些会拦截 target=_blank 的壳）常常把它吃掉，点了没反应，所以这里自己接管：
     只认 http/https，明确在新标签里打开；复制图标是锚点的兄弟节点，不受影响。 */
  dom.turns.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const anchor = target.closest('a[href]');
    if (!anchor || !dom.turns.contains(anchor)) return;
    const href = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    /* 不带 noopener 才能拿到返回值：开成功了才拦掉默认行为（否则会开两个标签页）；
       开不出来（被拦截）就什么都不做，让浏览器照它自己的 target=_blank 处理。 */
    const opened = window.open(href, '_blank');
    if (!opened) return;
    try {
      opened.opener = null;
    } catch (error) {
      /* 跨域时可能不让写，忽略即可 */
    }
    event.preventDefault();
  });

  dom.toast.addEventListener('click', () => {
    const action = toast.action;
    dismissToast();
    if (action) action();
  });
  dom.newChatName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitNewChat();
    } else if (event.key === 'Escape') {
      closeNewChatPanel();
    }
  });
  dom.renameButton.addEventListener('click', renameCurrentThread);
  dom.newChatCwd.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitNewChat();
    } else if (event.key === 'Escape') {
      closeNewChatPanel();
    }
  });
  dom.pinButton.addEventListener('click', togglePin);
  dom.attachButton.addEventListener('click', () => dom.attachInput.click());
  dom.attachInput.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    handleAttachFiles(files);
  });
  dom.attachStrip.addEventListener('click', (event) => {
    const target = event.target.closest('.attach-remove');
    if (!target) return;
    state.attachments.splice(Number(target.dataset.index), 1);
    renderAttachments();
  });
  dom.sendButton.addEventListener('click', () => sendMessage());
  dom.stopButton.addEventListener('click', interrupt);

  /* 挂起来的待发消息：点「引导」插进正在跑的这一轮，点 ✕ 撤下来 */
  dom.pendingStrip.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const threadId = state.currentThreadId;
    if (!threadId) return;
    const steer = target.closest('[data-steer-pending]');
    if (steer) {
      steerPending(threadId, steer.dataset.steerPending);
      return;
    }
    const remove = target.closest('[data-remove-pending]');
    if (remove) {
      takePending(threadId, remove.dataset.removePending);
      renderComposerButtons();
    }
  });

  dom.messageInput.addEventListener('input', () => {
    dom.messageInput.style.height = 'auto';
    dom.messageInput.style.height =
      Math.min(dom.messageInput.scrollHeight, window.innerHeight * 0.34) + 'px';
    renderComposerButtons();
  });

  dom.messageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey) return;
    event.preventDefault();
    sendMessage();
  });

  dom.turns.addEventListener('scroll', () => {
    state.pinnedToBottom = isNearBottom();
  });

  dom.turns.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('[data-load-earlier]')) return;
    loadEarlierItems();
  });

  /* 图片是异步加载的，加载完会改变高度，钉住的视图要跟着往下走 */
  dom.turns.addEventListener('load', () => {
    if (state.pinnedToBottom) scrollTurnsToBottom();
  }, true);

  dom.sidebarBrand.addEventListener('click', renameBridge);

  dom.composerLatency.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleLatencyPanel();
  });

  dom.permissionButton.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePermissionPanel();
  });

  dom.permissionOptions.addEventListener('click', (event) => {
    const option = event.target.closest('.permission-option');
    if (option) setPermission(option.dataset.mode);
  });

  document.addEventListener('click', (event) => {
    if (!dom.latencyPanel.hidden && !dom.latencyPanel.contains(event.target)) toggleLatencyPanel(false);
    if (!dom.permissionPanel.hidden && !dom.permissionPanel.contains(event.target)) {
      togglePermissionPanel(false);
    }
  });

  dom.turns.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target.tagName === 'IMG' && target.classList.contains('chat-image')) {
      imageError(target);
    }
  }, true);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    toggleLatencyPanel(false);
    togglePermissionPanel(false);
    return;
  }
  refreshIfVisible();
  measureLatency();
});

/* Safari 会自己记住并恢复滚动位置，刷新时就可能停在半截。
   这里交给我们自己的「钉在最新一条」逻辑。 */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* 手机从后台切回来常走 bfcache，JS 不会重跑，所以在这里补一次定位。 */
window.addEventListener('pageshow', () => {
  if (state.currentThreadId) pinToBottomSoon();
  measureLatency();
});

window.addEventListener('load', () => {
  if (state.pinnedToBottom) scrollTurnsToBottom();
});

function updateComposerHint() {
  dom.messageInput.placeholder = isNarrow()
    ? '接着让它做什么…'
    : '接着让它做什么…（Enter 发送，Shift+Enter 换行）';
}

loadTheme();
loadPinned();
loadShelved();
loadPending();
loadCollapsedGroups();
bindEvents();
updateComposerHint();
window.addEventListener('resize', updateComposerHint);
connectEvents();
renderPlaceholder();
loadBridgeMeta();
loadPermissions();
loadProjects();
loadThreads().then(restoreLastThread);
measureLatency();

setInterval(() => {
  if (document.hidden) return;
  loadThreads();
}, 10000);

setInterval(() => {
  if (document.hidden) return;
  measureLatency();
}, 15000);

setInterval(tickRunTimer, 1000);

setInterval(() => {
  if (document.hidden || !state.currentThreadId) return;
  if (threadRunning()) return;
  openThread(state.currentThreadId, { silent: true });
}, 6000);

/* The live stream is authoritative while it is delivering events. If a running
   turn stops producing events for a while (flaky Wi-Fi, suspended tab, dropped
   SSE), fall back to polling so the phone never gets stuck on a stale view. */
setInterval(() => {
  if (document.hidden || !state.currentThreadId) return;
  if (!threadRunning()) return;
  if (Date.now() - state.lastEventAt < 8000) return;
  openThread(state.currentThreadId, { silent: true });
}, 3000);

window.addEventListener('focus', refreshIfVisible);
window.addEventListener('online', refreshIfVisible);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeSidebar();
  togglePermissionPanel(false);
});
