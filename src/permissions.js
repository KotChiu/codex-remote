'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* 会话权限档位，直接用 Codex 自己的概念：
   - ask  自己决策：工作区内自由执行，需要越界（沙箱逃逸 / 联网 / MCP 询问）时弹卡片问你。
   - auto 帮我决策：同样在工作区里跑，但越界请求交给 Codex 的审查子代理判断，
          不再打扰你（等价于 `codex queue --approve-for-me`）。
   - full 完全访问：不沙箱、不询问（等价于 `--dangerously-bypass-approvals-and-sandbox`）。
   没设置过（default）就不下发任何覆盖，完全跟随电脑上那份设置。 */
const PROFILES = {
  ask: {
    id: 'ask',
    label: '自己决策',
    hint: '工作区内自由跑，要越界 / 联网时问我',
    tone: 'accent',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalsReviewer: 'user',
  },
  auto: {
    id: 'auto',
    label: '帮我决策',
    hint: '越界请求由 Codex 审查后代我决定',
    tone: 'warn',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalsReviewer: 'auto_review',
  },
  full: {
    id: 'full',
    label: '完全访问',
    hint: '不询问、不沙箱，任何命令直接跑',
    tone: 'danger',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
    approvalsReviewer: 'user',
  },
};

const PROFILE_IDS = Object.keys(PROFILES);
/* 未设置 = 跟随电脑，不下发覆盖。 */
const DEFAULT_MODE = 'default';

const INHERIT_PROFILE = {
  id: DEFAULT_MODE,
  label: '跟随电脑',
  hint: '用电脑上这个会话当前的设置，不改动',
  tone: 'plain',
};

function isProfileId(value) {
  return PROFILE_IDS.includes(value);
}

function normalizeMode(value) {
  return isProfileId(value) ? value : DEFAULT_MODE;
}

function profileList() {
  return [INHERIT_PROFILE, ...PROFILE_IDS.map((id) => PROFILES[id])].map((profile) => ({
    id: profile.id,
    label: profile.label,
    hint: profile.hint,
    tone: profile.tone,
  }));
}

/* thread/start、thread/resume、thread/fork 收的是 SandboxMode 字符串 */
function threadParams(mode) {
  const profile = PROFILES[mode];
  if (!profile) return {};
  return {
    approvalPolicy: profile.approvalPolicy,
    sandbox: profile.sandbox,
    approvalsReviewer: profile.approvalsReviewer,
  };
}

/* turn/start 除了策略还能直接覆盖沙箱，形状是带 tag 的对象 */
function turnParams(mode) {
  const profile = PROFILES[mode];
  if (!profile) return {};
  return {
    approvalPolicy: profile.approvalPolicy,
    sandboxPolicy: profile.sandboxPolicy,
    approvalsReviewer: profile.approvalsReviewer,
  };
}

/* 会话正在电脑上跑、只能排队时走 `codex queue`，把档位翻译成 CLI 参数；
   没设置过就沿用原来的行为（由 CODEX_REMOTE_SANDBOX 决定）。 */
function queueArgs(mode) {
  switch (mode) {
    case 'ask':
      return ['--sandbox', PROFILES.ask.sandbox];
    case 'auto':
      return ['--approve-for-me'];
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    default:
      return null;
  }
}

const SANDBOX_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '无沙箱',
  readOnly: '只读',
  workspaceWrite: '工作区可写',
  dangerFullAccess: '无沙箱',
  externalSandbox: '外部沙箱',
};

function sandboxLabel(value) {
  if (!value) return null;
  const key = typeof value === 'string' ? value : value.type;
  return SANDBOX_LABELS[key] || String(key);
}

const REVIEWER_LABELS = {
  user: '由你确认',
  auto_review: 'Codex 审查',
  guardian_subagent: 'Codex 审查',
};

function reviewerLabel(value) {
  if (!value) return null;
  return REVIEWER_LABELS[value] || String(value);
}

/* 按「实际生效的设置」反推属于哪个档位，用来在电脑上改过之后仍然显示真实状态。 */
function modeFromSettings(settings) {
  if (!settings) return null;
  const sandbox = sandboxLabel(settings.sandbox || settings.sandboxPolicy);
  const reviewer = settings.approvalsReviewer;
  const approval = settings.approvalPolicy;
  if (sandbox === '无沙箱' || approval === 'never') return 'full';
  if (reviewer === 'auto_review' || reviewer === 'guardian_subagent') return 'auto';
  return 'ask';
}

function loadPermissionMap(file) {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [threadId, mode] of Object.entries(raw || {})) {
      if (isProfileId(mode)) out[threadId] = mode;
    }
    return out;
  } catch (error) {
    return {};
  }
}

function savePermissionMap(file, map) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

module.exports = {
  PROFILES,
  PROFILE_IDS,
  DEFAULT_MODE,
  isProfileId,
  normalizeMode,
  profileList,
  threadParams,
  turnParams,
  queueArgs,
  sandboxLabel,
  reviewerLabel,
  modeFromSettings,
  loadPermissionMap,
  savePermissionMap,
};
