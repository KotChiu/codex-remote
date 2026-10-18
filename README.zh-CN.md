# Codex Remote

[English](README.md) | **简体中文**

在手机上接着电脑上的 Codex 会话继续干活：看历史、发指令、审批命令、看 diff 和输出。

> 两个语言版本都是手工维护的，改功能时请一起更新。

## 核心思路

不另起一个 agent，而是接上**桌面 App 已经在用的那个 app-server daemon**
（`~/.codex/app-server-control/app-server-control.sock`）。所以手机看到的会话、
线程、状态就是电脑上那一份，在手机上发一条消息，桌面上同一个会话会继续往下跑。

```
手机浏览器  ──HTTP/SSE──▶  bridge (本仓库)  ──WebSocket over Unix socket──▶  codex app-server daemon
```

- 复用 Codex 桌面 App 的 daemon 和 `~/.codex`，不需要额外装东西。
- 协议就是官方的 app-server JSON-RPC 2.0，没有私改。
- 桥接层零依赖（只用 Node 内置模块），WebSocket-over-Unix-socket 是手写的。

## 安装

前置条件：

- macOS，且已经装好并登录过 **Codex 桌面 App**（桥接的是它已经在跑的那个 daemon）。
- Node.js：优先用 PATH 里的 `node`；没有就回退到 Codex 自带运行时，也可以用
  `CODEX_REMOTE_NODE=/path/to/node` 指定。**零依赖，不需要 `npm install`。**

### 1. 拿代码

```bash
git clone https://github.com/KotChiu/codex-remote.git ~/codex-remote
cd ~/codex-remote
```

git 不可用（例如 Xcode 命令行工具损坏、`/usr/bin/git` 报 `xcrun` 错）就下 zip 包，效果一样：

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/KotChiu/codex-remote/archive/refs/heads/main.zip
unzip -q main.zip && mv codex-remote-main/* .
```

### 2. 前台试跑（可选，先确认能连上）

```bash
./bin/codex-remote --port 8787
```

它会打印手机可以直接打开的地址（带一次性 token）：

```
http://192.168.x.x:8787/?token=<TOKEN>
```

### 3. 装成常驻服务（推荐）

```bash
bash scripts/install-launchd.sh
```

它做的事：把 `bin src public` 部署到 `~/.codex-remote/app` → 写
`~/Library/LaunchAgents/com.codex.remote.plist` → 重启 LaunchAgent（**服务中断约 10 秒**）。
之后开机自启、进程崩了自动拉起。卸载用 `bash scripts/uninstall-launchd.sh`。

注意这是用户级 LaunchAgent（`gui/<uid>`），所以要**保持该用户登录状态**，注销后服务会停。

### 4. 手机上打开

1. 手机和 Mac 在同一个局域网。
2. 打开 `http://<Mac 的局域网 IP>:8787/?token=<TOKEN>`，带 token 只需一次，用来写 cookie。
   地址印在 `~/.codex-remote/bridge.log` 开头，token 也存在 `~/.codex-remote/token`（600）。
3. 再打开一次不带 token 的 `http://<Mac 的 IP>:8787/`，iOS 可以「添加到主屏幕」当固定入口。

macOS 防火墙第一次会弹窗询问是否允许 `codex-remote` 接入，选「允许」。

## 启动

```bash
./bin/codex-remote --port 8787
```

启动后会打印手机可以直接打开的地址（带一次性 token）：

```
http://192.168.x.x:8787/?token=<TOKEN>
```

第一次打开会写入 cookie 并跳转，之后直接访问 `http://192.168.x.x:8787/` 即可。
token 保存在 `~/.codex-remote/token`（权限 600）。

## 手机侧

1. 手机和 Mac 在同一个局域网。
2. 浏览器打开上面那个带 token 的地址。
3. iOS 可以「添加到主屏幕」，会以全屏 App 的形式打开。

界面沿用 Codex 桌面版的配色（背景 `#111111`、侧边栏 `#131313`、强调色 `#0169cc`），
宽屏时左侧常驻会话侧边栏，手机（≤767px）上侧边栏收成抽屉，点左上角 ☰ 滑出、选完自动收起。

界面上能做的事：

- 侧边栏会话列表：名称、预览、运行状态（运行中 / 待审批）、相对时间；当前会话高亮。
- 会话详情：用户消息、Agent 回复（Markdown）、思考过程、命令执行（命令 + 退出码 + 输出）、文件改动、计划。
- 底部输入框继续发指令；任务运行时可以「中断」。
- **运行中计时**：对齐桌面版，计时长在会话里、不在输入框旁边 —— 正在跑的那一轮下面是
  `● 运行中 1:23`（脉冲圆点 + 走动的计时）。基准取服务端的 `turn.startedAt`（拿不到就用
  第一次看到它开始跑的时刻兜底），格式 `0:12` / `1:23` / `1:02:03`；一秒一跳、只改那一个
  文本节点，页面在后台就不动。
- **运行中发消息 = 先挂起来，不打断**（对齐桌面版）：会话正在跑的时候按「发送」，消息不会打断
  当前这一轮，而是浮在输入框上方等着（`待发` + 消息 + 「引导」/「✕」），这一轮跑完自动作为新
  一轮发出去；中途切到别的会话、甚至关掉页面再打开（待发列表存在 `localStorage`）都还等着。
  想让它立刻插进正在跑的那一轮，点那条上的「引导」—— 走 daemon 原生的 `turn/steer`，不新开一轮。
  挂起来和引导都**不弹悬浮提示**（输入框上方那条、以及引导后立刻插回会话里的那条消息就是回执）；
  只有真被 daemon 排队（`codex queue`）时，消息下面会多一行「排队中 · 电脑端这一轮跑完就执行」。
  输入框旁边始终只有「发送」和运行中的「中断」两个按钮。被中断的那一轮 daemon 不一定发
  `turn/completed`，所以桥接和页面每次读会话都拿服务端的 turn 状态校准一次，免得假「运行中」
  把待发消息卡住。
- **会话被电脑端占用时自动排队**：如果消息发出去时发现那个会话被电脑端占着
  （`already has an active writer`），会退回 `codex queue` 排队，等当前这轮跑完自动执行。
- **审批卡片**：Codex 请求执行命令/改文件时，手机上出现「允许 / 本会话都允许 / 拒绝 / 拒绝并中断」。
- **新建对话 / 重命名 / 置顶**：标题栏点 ＋ 新建（默认建在 `~/Documents/Codex/chat`；默认不置顶，需要时勾选「置顶显示」），
  ✎ 重命名，☆/★ 置顶。置顶的会话排在最前面并带 ★，方便做成「固定窗口」（例如「健身饮食」）。
  置顶和新对话记录存在浏览器 `localStorage`（`codex.pinned` / `codex.shelved`），只对当前浏览器生效。
  那份 `codex.shelved`（刚建好、daemon 还没收录的会话）会定期核对：会话建立 10 分钟以后，
  用 `?limit=1` 轻量读一次，**连续两次**读回「thread not loaded」才认定电脑上已经没有它了、
  把它从列表摘掉（你亲手点开它失败也算一次）。之所以这么保守：daemon 的 `thread/list`
  里根本没有这种「刚建好、还没跑过话」的会话，误删一次就再也找不回来了。
- **项目分组 / 临时对话**（对齐桌面版侧边栏）：
  - `项目` 这组读的是 Codex 自己的项目记录（app-server 的 `project/list`）。会话归到哪个项目，
    看的是**会话的工作目录是否落在项目根目录下**（daemon 里会话的 `projectId` 通常是空的，
    真正的关联就是 `cwd`）。所以「只有一个会话在项目里」通常只是因为这个项目目前只有一个会话 ——
    其余会话的工作目录都是自动生成的 `~/Documents/Codex/chat`、`~/Documents/Codex/<日期>/…`，
    自然落到 `其他对话`。想让会话进项目，新建时把「工作文件夹」填成项目目录即可。
  - 分组标题可以点，折叠状态存在 `localStorage`（`codex.collapsedGroups`）。
  - **在项目下新建对话**：项目名右边那个 `＋` 就是 —— 点它弹出的对话框已经把这个项目的
    根目录填进「工作文件夹」，创建出来的会话直接落在这个项目底下（不会再掉进 `其他对话`）。
    即使这个项目一个会话都没有，这一行也照样在（下面写「还没有对话，点上面 ＋ 新建一个」），
    不然新建的第一个会话就没有入口。
  - 「新建对话」对话框里还有一个**项目下拉**：选项目 = 把它的根目录填进工作文件夹；
    手动改了路径，下拉会自动退回「不指定（自己填路径）」，不会出现「选了 A 项目却建到 B 目录」。
  - `项目` 右边的 ＋ = 新建项目（名称 + 绝对路径，支持 `~` 开头），走 `project/create`。
  - 侧边栏的 `✦ 临时对话` = daemon 的 **ephemeral 会话**：不写盘、不进历史，标题栏多一个
    `结束` 按钮，关掉就从列表消失，桥接重启后自然也没了。
  - 临时会话不落盘，daemon 的 `thread/read` 读不回它的内容（`thread/turns/list` 也不支持），
    所以桥接层自己按序缓存它的事件（上限 4000 条），前端重开时回放 —— 刷新页面照样能看到
    完整对话，包括你自己的消息（daemon 在 `turn/completed` 里只回摘要，回放时以 `item/*`
    事件为准）。
  - 临时会话不能排队（没有 rollout 供 `codex queue` 使用），它正在跑的时候再发会提示等一等。
- **每个会话的权限档位**：输入框左上角那个小圆点，点开有四个选择，新建对话时也能直接选。
  档位跟着会话走（存在桥接这边 `~/.codex-remote/permissions.json`），电脑上打开同一个会话
  也会是同样的权限，所以手机上放开了、回到电脑不会偷偷降级。

  | 档位 | 含义 | 对应 Codex 的 |
  | --- | --- | --- |
  | 跟随电脑 | 不下发任何覆盖，用电脑上这个会话现在的设置 | 默认 |
  | 自己决策 | 工作区内自由跑，要越界 / 联网时弹卡片问你 | `-s workspace-write` + `on-request` |
  | 帮我决策 | 越界请求交给 Codex 的审查子代理判断，不打扰你 | `--approve-for-me` |
  | 完全访问 | 不询问、不沙箱，任何命令直接跑 | `--dangerously-bypass-approvals-and-sandbox` |

  实现在下一条消息上：发消息时桥接会把档位同时带在 `thread/resume` 和 `turn/start` 上；
  会话正被电脑占用、只能排队时，则翻译成 `codex queue` 的参数。
  弹层右上角会显示**电脑上实际生效**的设置（来自 daemon 的 `thread/settings/updated`），
  刚改完还没发消息时显示 `—` 是正常的。
- **白天 / 夜间配色**：默认跟随手机系统，侧边栏顶部那个 `🌓` 按钮点一下循环
  `跟随手机 → ☀️ 白天 → 🌙 夜间`，记在 `localStorage` 的 `codex.theme` 里。
  （放在侧边栏而不是标题栏，是因为标题栏要留给会话标题和状态。）
  两套配色都写在 `public/style.css`（`--bg` / `--text` / `--accent-soft` 一类的变量），
  由 `<html data-theme="light|dark">` 决定用哪套；`index.html` 里有一段内联脚本
  在样式表之前就把属性定好，所以不会先闪一下再变色。切主题时会同步
  `meta[name=theme-color]`（浏览器地址栏 / 状态栏底色）和 iOS 的
  `apple-mobile-web-app-status-bar-style`（加主屏当 App 时状态栏字色）。
- **一键复制**：Agent 回复里的代码块、命令输出右上角有个复制按钮；链接（含裸 URL —— 之前裸 URL
  只是纯文本，现在会自动变成链接）、以及**够长的行内代码**（≥20 字符：token、路径、命令这一类的，
  短的标识符不给按钮，免得满屏小图标）后面也跟一个复制按钮。点一下直接进剪贴板，按钮变成对勾，
  下方弹出「已复制：…」。按钮用的是 12×12 的内联 SVG（跟文字同色），不是 emoji —— emoji 走系统
  字体，在手机上会被放大成一大坨。
  链接**点一下就开**：锚点本身是 `target="_blank"`，但手机上的内置浏览器（以及某些拦截
  `target=_blank` 的壳）经常把它吃掉，点了没反应，所以页面自己接管了一次点击 —— 只认 `http/https`，
  明确在新标签页里打开；万一被拦截，就不拦默认行为，交回给浏览器。
  复制走的是 `copyValueFor()`：代码取整段 `<pre>`/`<code>` 的文本，链接取真实 `href`
  （不是屏幕上被截断的显示文字）。手机访问的是 `http://192.168.x.x`，不是安全上下文，
  `navigator.clipboard` 在那里不存在，所以兜底用屏幕外的 `readonly` textarea + `execCommand('copy')`
  （`readonly` 是为了 iOS 不弹键盘，定位在屏幕外是不让页面滚走）。
- **长会话不会把手机拖死**：一次 `thread/read` 实测能给到 11MB —— 光是 MCP 工具结果
  就有 4.7MB（单条最大 65KB），31 分钟的会话有 2963 条记录。手机上解析这种体积要几百毫秒，
  而 6 秒一次的后台轮询还会反复付这笔钱，表现就是「Codex 正在回复时，我在输入框里打字特别卡」。
  现在桥接侧做了两件事：
  - **只给最近 500 条记录**（`GET /api/threads/:id?limit=`，上限 20000），
    整段会话仍然都在电脑上；手机端往下翻到头，聊天流顶部会出现「⇡ 显示更早的 500 条」，
    点一下按需再拉，滚动位置会用「距底部的距离」锚住，不会跳。
  - **超长文本剪掉中段**（工具结果 6KB、命令输出 8KB、思考内容 8KB、diff 20KB，
    其余字符串兜底 40KB），只留开头和结尾并在中间标注省略了多少字符。
  实测那段会话：payload 11.5MB → 1.24MB（gzip 341KB），前端 DOM 10.3MB → 1.1MB，
  记录数 2963 → 499。
- **流式输出不整块重画**：agent 正文每来一段过去都要重排一遍 markdown，思考过程每来一段
  都要把整个聊天流重建一次（`public/app.js` 里的 `renderThread`）。现在改成
  「先把脏掉的 item 记下来，最多每 120ms 刷一次对应的那个元素」
  （`scheduleDeltaFlush` / `flushItemDelta`），整块重画只在 `item/started`、
  `item/completed` 这类真结构变化时才发生。
- **电脑端更新会提示刷新**：手机这个页面可能开着好几天都不刷新，而电脑上的桥接随时会被
  重新部署。页面每 15 秒的延时探测会带上桥接版本号（`/api/ping` 的 `version`），一旦发现
  和自己载入时的不一样，就弹一条「电脑端已更新到 vX，点这里刷新页面」（这种提示不自动消失，
  点一下才刷新），不用再自己猜「新加的功能手机上怎么没有」。
- **页面名字**：侧边栏顶部显示的就是这台机器（默认主机名），点一下就能改名，多台电脑一眼区分。
- **连接延时按钮**：输入框左上角、贴着「跟随电脑」右边那个小圆点就是当前手机 ↔ 电脑的往返延时，
  绿 <80ms / 黄 <250ms / 红（或显示「无 Codex」）表示链路或 Codex 有问题。
  点一下展开明细：`手机 ↔ 电脑`、`电脑 ↔ Codex`（走 `/api/ping`，服务端用无副作用的
  `thread/loaded/list` 连问三次取最小值）、**接入路径**、实时推送状态、检查时间、桥接版本。
  进页面、每 15 秒、以及从后台切回来时各测一次，页面不可见时不发请求。
  「接入路径」是服务端按客户端源地址算出来的（本机直连 / 局域网 / Tailscale / 远端）。
  如果显示 **Tailscale 中继**，说明手机没走局域网，而是从 Tailscale 的 100.64/10 段进来、
  且没打通直连（本机实测过 `relay "tok"`，单程 200ms 起）—— 面板里会直接给出带 token 的
  局域网地址链接，手机和电脑在同一个 Wi-Fi 时点一下就能切过去，延时会掉到个位数毫秒。
  连不上时不再只靠颜色区分（色弱、强光下看不出来）：那个圆点会换成红色的 **⚠**，
  面板里对应几行也带 ⚠（`⚠ 连不上` / `⚠ 未连接` / `⚠ 中断，重连中`）。

- **链路层做的三件事**：服务端 `keepAliveTimeout` 调到 65 秒（Node 默认 5 秒就断，
  而延时探测每 15 秒一次，等于每次都在新建 TCP 连接，白搭一个 RTT）；超过 1KB 的 JSON
  响应走 gzip（一次完整会话读取 1.6MB → 424KB）；启动时打印的地址里局域网排最前面。
- **打开 / 刷新后自动停在最新一条**：图片是异步加载的，会持续把内容往下钉住，不用手动下拉；
  自己往上翻看历史时不会被拽回去。已关闭浏览器自身的滚动位置恢复（`history.scrollRestoration = 'manual'`），
  手机从后台切回来（bfcache 还原）也会重新定位到最后一条，所以刷新后不会再停在半截。
- 页面高度用 `100dvh`，iOS Safari 收起/展开工具栏时输入框和最新消息不会被挡住。
- 输入框字号固定 16px，iOS 上点输入框不会再把页面放大。
- 全程 SSE 实时推送，输出边跑边出。

## 常驻运行

```bash
./scripts/install-launchd.sh     # 安装 LaunchAgent，开机自启 + 崩溃自动重启
./scripts/uninstall-launchd.sh   # 卸载
```

日志：`~/.codex-remote/bridge.log`

## 前置条件

- 桌面 App（或 `codex app-server daemon start`）在运行，控制 socket 存在。
  `bin/codex-remote` 启动前会自动尝试 `codex app-server daemon start`。
- Node.js：优先用 PATH 里的 `node`，否则回退到 Codex 自带的运行时。
  也可以用 `CODEX_REMOTE_NODE=/path/to/node` 指定。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` | `8787` | 监听端口 |
| `--host` | `0.0.0.0` | 监听地址；只想本机用就设 `127.0.0.1` |
| `--socket` | `~/.codex/app-server-control/app-server-control.sock` | app-server 控制 socket |
| `--token-file` | `~/.codex-remote/token` | token 文件；删掉会重新生成 |
| `--name` | 主机名 | 页面/标签页显示的名字，用来区分多台电脑 |
| `--name-file` | `~/.codex-remote/name` | 名字的持久化文件，也可以直接用环境变量 `CODEX_REMOTE_NAME` |

## 安全

- 所有接口都要 token（cookie / `Authorization: Bearer` / 一次性 `?token=`）。
- 但这是**明文 HTTP**，同局域网的人可以嗅探流量。只在你信任的局域网里用。
- **不要**把端口映射到公网。要在外网用，请套一层 TLS 反代（Caddy/nginx）或走 VPN/Tailscale，
  然后把 `--host` 设成 `127.0.0.1` 只让反代访问。
- app-server 本身能力很强：能执行命令、改文件。token 等同于这些权限，别外传。

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面提示「未连接」 | daemon 没跑：`codex app-server daemon start` |
| 手机打不开 | 不在同一网段、Mac 的防火墙、或 `--host` 设成了 `127.0.0.1` |
| 401 unauthorized | 用带 `?token=` 的完整地址重新打开一次 |
| 想换 token | 删除 `~/.codex-remote/token` 后重启服务 |
| 发消息提示「已排队」 | 正常：该会话正在电脑上运行，消息排在后面自动执行 |
| 发的消息落到回答下面 / 回答跑到消息上面 | 以前会把「还没被 daemon 记进会话」的那条回显贴到整个对话流末尾，看起来就像回答在前面。现在回显按归属插回自己那一轮的原位：运行中点「引导」、或消息插进正在跑的那一轮（daemon 要到下一个模型回合才把它记成一条记录，实测十几秒到几十秒）时，消息会停在发送时刻的位置，后续输出接在它下面 |
| 点了回复里的链接没反应 | 页面自己接管了链接点击（新标签打开）；若是内嵌浏览器把新标签也拦了，长按链接复制地址到浏览器里开 |
| 提示「no rollout found」 | 会话 id 不存在（多为列表过期），回列表刷新即可 |
| 延时一直 200ms 以上 | 多半是手机走了 Tailscale 中继而不是局域网：点延时按钮看「接入路径」，用面板里的局域网链接重开一次 |
| 手机上设了权限档位但还在弹审批 | 档位只对「下一条消息」生效；若那个会话正被电脑占用，`thread/resume` 会被 `active writer` 挡掉，档位下发不进去，等这轮跑完再发 |

## 文件

```
bin/codex-remote            启动脚本
src/ws-unix.js              WebSocket over Unix socket 客户端（零依赖实现）
src/appserver.js            app-server JSON-RPC 2.0 客户端
src/codex-cli.js            codex CLI 定位 + 排队投递（占用时兜底）
src/permissions.js          会话权限档位定义与落盘
src/server.js               HTTP + SSE 桥接，鉴权，审批转发
public/                     手机端界面
launchd/                    常驻服务模板
scripts/probe.js            连通性探针，直接列会话
scripts/install-launchd.sh  安装常驻服务
```

## 验证

```bash
# 直连 daemon，列出会话
./bin/codex-remote --port 8787 &     # 或已由 launchd 启动
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/threads?limit=5

# 量一下两段链路（手机侧按钮用的就是它；daemon.ms 是电脑 ↔ Codex）
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/ping

# 看/改某个会话的权限档位（default / ask / auto / full）
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/permissions
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" -H 'content-type: application/json' \
  -d '{"mode":"ask"}' http://127.0.0.1:8787/api/threads/<thread-id>/permissions
```

## 多台电脑

每台机器各跑一份桥接，靠页面名字区分（默认取主机名）：

- 手机上直接点侧边栏顶部的名字就能改，写进 `~/.codex-remote/name`
- 也可以 `bin/codex-remote --name "我的 Mac"`，或用环境变量 `CODEX_REMOTE_NAME`
- `GET /api/meta` 返回 `{name, hostname, version, startedAt}`，一眼看出连的是哪台

### 更新代码并重新部署

不管用哪种方式拿代码，最后一步都是 `install-launchd.sh`：它把 `bin src public` 覆盖到
`~/.codex-remote/app`，重写 plist 并重启 LaunchAgent（服务会中断约 10 秒）。

```bash
git clone https://github.com/KotChiu/codex-remote.git ~/codex-remote   # 首次
cd ~/codex-remote && git pull && bash scripts/install-launchd.sh      # 之后
```

没有可用 git 的机器（`/usr/bin/git` 依赖的 CommandLineTools 损坏）可以下载 zip 包再部署：

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/KotChiu/codex-remote/archive/refs/heads/main.zip
unzip -q -o main.zip && bash codex-remote-main/scripts/install-launchd.sh
```

想彻底修好本机的 git（之后 `git pull` 就能用）：`xcode-select --install`，装完
`git --version` 有输出即可。

自己改代码时，直接在源码目录跑 `bash scripts/install-launchd.sh` 即可。

### 部署后自检

```bash
launchctl print gui/$(id -u)/com.codex.remote | grep -E 'state|pid'   # 应为 running
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/      # 401 = 正常（需要 token）
grep -c newChatCwd ~/.codex-remote/app/public/app.js                # 部署内容是否为新版
tail -20 ~/.codex-remote/bridge.log                                  # 出错时才看 bridge.err.log
```

手机上刷新一次页面就能拿到新版（`public/` 用 `Cache-Control: no-store`）。

改了前端以后，如果希望**已经开着页面的手机**被主动提醒刷新，把 `src/server.js` 里的
`BRIDGE_VERSION` 递增一下（前端拿它跟 `/api/ping` 回报的版本比对）。不递增也能用，
只是手机上要自己下拉刷新。

### 调试时别留测试会话

改这套东西免不了要真发几条消息试，试出来的会话别留在列表里：

- **首选临时对话**（不写盘、不进历史，桥接重启就没了）：

  ```bash
  TOKEN=$(cat ~/.codex-remote/token)
  # 建：拿返回里的 thread.id
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"ephemeral":true,"cwd":"'"$PWD"'"}' http://127.0.0.1:8787/api/new-thread
  # 用完关掉
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"threadId":"<id>"}' http://127.0.0.1:8787/api/ephemeral/close
  ```
- 有些路径只能拿真会话验（临时会话读不回内容），那就**试完立刻删**：
  `node scripts/delete-thread.js <threadId>` —— 走 daemon 的 `thread/delete`，rollout 文件一起没。
- 「新建了但一句话没发」的会话在列表里根本看不见，但会在 `~/.codex/sessions` 留下一个只有
  `session_meta` 一行的 rollout 存根，用 `node scripts/delete-thread.js --stubs` 清掉。

## 仓库

代码托管在 GitHub：<https://github.com/KotChiu/codex-remote>

```bash
git clone https://github.com/KotChiu/codex-remote.git
git remote add origin https://github.com/KotChiu/codex-remote.git   # 已有目录时
```

发布流程：改完代码 → `bash scripts/install-launchd.sh` 部署 → `git add -A && git commit`
→ `git push origin main`。手机上刷新一次页面就能拿到新版。

macOS 上先确认 git 可用：`git --version` 报 `xcrun: ... missing xcrun` 说明 Xcode 命令行工具
缺失（`/usr/bin/git` 只是它的壳），执行一次 `xcode-select --install` 即可修好；不想装 Xcode
也可以直接用 Codex 运行时自带的 git：

```bash
~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git --version
```
