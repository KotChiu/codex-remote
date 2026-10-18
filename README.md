# Codex Remote

Pick up the Codex session running on your desktop from your phone: read the history, send instructions, approve commands, inspect diffs and output.

**English** | [简体中文](README.zh-CN.md)

> Both language versions are maintained by hand — please update both when you change a feature.

## How it works

Rather than spawning another agent, the bridge attaches to **the same app-server daemon the desktop app is already using**
(`~/.codex/app-server-control/app-server-control.sock`). The sessions, threads and statuses you see on the phone are the
same ones on the computer; send a message from the phone and that very session keeps running on the desktop.

```
phone browser  ──HTTP/SSE──▶  bridge (this repo)  ──WebSocket over Unix socket──▶  codex app-server daemon
```

- Reuses the Codex desktop app's daemon and `~/.codex`; nothing extra to install.
- Speaks the official app-server JSON-RPC 2.0 protocol, unmodified.
- The bridge has zero dependencies (Node built-in modules only); the WebSocket-over-Unix-socket client is hand-written.

## Installation

Prerequisites:

- macOS with the **Codex desktop app** installed and signed in (the bridge attaches to the daemon it already runs).
- Node.js: `node` from `PATH` is preferred; otherwise the runtime bundled with Codex is used, or point
  `CODEX_REMOTE_NODE=/path/to/node` at one. **Zero dependencies, no `npm install`.**

### 1. Get the code

```bash
git clone https://github.com/KotChiu/codex-remote.git ~/codex-remote
cd ~/codex-remote
```

If git is unusable (for example broken Xcode command line tools, `/usr/bin/git` failing with `xcrun`), download the zip instead:

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/KotChiu/codex-remote/archive/refs/heads/main.zip
unzip -q main.zip && mv codex-remote-main/* .
```

### 2. Run in the foreground (optional sanity check)

```bash
./bin/codex-remote --port 8787
```

It prints an address your phone can open directly (with a one-time token):

```
http://192.168.x.x:8787/?token=<TOKEN>
```

### 3. Install as a background service (recommended)

```bash
bash scripts/install-launchd.sh
```

What it does: deploys `bin src public` to `~/.codex-remote/app` → writes
`~/Library/LaunchAgents/com.codex.remote.plist` → restarts the LaunchAgent (**about 10 seconds of downtime**).
After that it starts at login and is restarted if it crashes. Uninstall with `bash scripts/uninstall-launchd.sh`.

This is a per-user LaunchAgent (`gui/<uid>`), so **the user has to stay logged in**; logging out stops the service.

### 4. Open it on your phone

1. Phone and Mac on the same LAN.
2. Open `http://<Mac LAN IP>:8787/?token=<TOKEN>`. The token is only needed once — it sets a cookie.
   The address is printed at the top of `~/.codex-remote/bridge.log`; the token also lives in
   `~/.codex-remote/token` (mode 600).
3. Open `http://<Mac IP>:8787/` again without the token; on iOS you can "Add to Home Screen" as a permanent entry point.

The macOS firewall asks once whether `codex-remote` may accept incoming connections — choose Allow.

## Running

```bash
./bin/codex-remote --port 8787
```

It prints an address your phone can open directly (with a one-time token):

```
http://192.168.x.x:8787/?token=<TOKEN>
```

The first visit sets a cookie and redirects; afterwards `http://192.168.x.x:8787/` works as-is.
The token is stored in `~/.codex-remote/token` (mode 600).

## The phone UI

1. Phone and Mac on the same LAN.
2. Open the tokenized address in a browser.
3. On iOS you can "Add to Home Screen"; it opens full screen like an app.

The UI follows the desktop Codex palette (background `#111111`, sidebar `#131313`, accent `#0169cc`).
On wide screens the session sidebar is always visible; on phones (≤767px) it collapses into a drawer —
tap ☰ at the top left to slide it out, and it closes once you pick a session.

What you can do:

- **Session list** in the sidebar: name, preview, running state (running / waiting for approval), relative time;
  the current session is highlighted.
- **Session view**: your messages, agent replies (Markdown), reasoning, command executions (command + exit code + output),
  file changes, plans.
- Keep going with the composer at the bottom; press **Interrupt** while a turn is running.
- **Unread dot**: when a session finishes a turn while you are not looking at it (or the page is in the background),
  a small blue dot appears in front of its name in the list; opening that session clears it. The state lives in the
  browser's `localStorage` (`codex.unread`), so it survives a refresh.
- **Running timer**: like the desktop app, the timer lives in the conversation, not next to the composer — beneath the
  running turn you see `● Running 1:23` (pulsing dot + ticking clock). The baseline is the server's `turn.startedAt`
  (falling back to the moment the bridge first saw the turn start); formats are `0:12` / `1:23` / `1:02:03`.
  It ticks once a second, updates only that text node, and stops while the page is in the background.
- **Sending during a running turn attaches the message instead of interrupting** (matches the desktop app): pressing
  Send while a turn is running does not interrupt it — the message floats above the composer (`Pending` + text +
  `Steer` / `✕`) and is sent as a new turn when the current one finishes. Switching sessions, or even closing and
  reopening the page (the pending list is kept in `localStorage`), keeps it waiting. To inject it into the running turn
  immediately, press **Steer** on that row — this uses the daemon's native `turn/steer` and does not start a new turn.
  Attaching and steering **show no floating toasts** (the row above the composer, and the message inserted back into the
  conversation, are the acknowledgement); only when the daemon really queues a run (`codex queue`) does the message get
  a line underneath: "Queued · runs when the desktop turn finishes". There are only ever two buttons next to the
  composer: Send, and Interrupt while running. The daemon does not always emit `turn/completed` for an interrupted
  turn, so the bridge and the page reconcile against the server's turn state on every read — a phantom "running"
  state cannot block pending messages.
- **Automatic queueing when the desktop owns the session**: if a message arrives while the desktop is using that
  session (`already has an active writer`), the bridge falls back to `codex queue` and runs it once the current turn ends.
- **Approval cards**: when Codex asks to run a command or edit files, the phone shows Allow / Allow for this session /
  Deny / Deny and interrupt.
- **New chat / rename / pin**: ＋ in the title bar creates a chat (default location `~/Documents/Codex/chat`; new chats are
  not pinned unless you tick "pin"); ✎ renames; ☆/★ pins. Pinned sessions sit at the top with a ★, handy for a "fixed window"
  (a daily-notes chat, say). Pins and new chats are stored in the browser's `localStorage` (`codex.pinned` /
  `codex.shelved`) and only apply to that browser. The `codex.shelved` list (sessions created but not yet indexed by
  the daemon) is verified periodically: 10 minutes after creation it does a lightweight `?limit=1` read, and only
  **twice in a row** returning "thread not loaded" removes it from the list (a failed manual open counts once). The
  reason for being this conservative: `thread/list` does not include sessions that were just created and never used,
  so a wrong removal loses them for good.
- **Project groups / ephemeral chats** (mirrors the desktop sidebar):
  - The `Projects` group comes from Codex's own project records (`project/list`). A session belongs to a project when
    **its working directory is inside the project root** (a thread's `projectId` in the daemon is usually empty;
    `cwd` is the real link). So "only one session in the project" usually just means that project has one session so
    far — the rest live in the auto-generated `~/Documents/Codex/chat`, `~/Documents/Codex/<date>/…` and land in
    `Other chats`. Put a session in a project by setting its working folder to the project directory when creating it.
  - Group headers are clickable; collapsed state is stored in `localStorage` (`codex.collapsedGroups`).
  - **New chat inside a project**: the `＋` next to the project name — the dialog already has the project root filled
    into "working folder", so the new session lands under that project (instead of `Other chats`). The row is shown
    even when the project has no sessions (with "no chats yet, tap ＋ above"), otherwise the first session would have
    no entry point.
  - The **New chat** dialog also has a project dropdown: picking a project fills its root into the working folder;
    editing the path by hand resets the dropdown to "not selected (enter a path)", so you can never end up with
    "picked project A but created in directory B".
  - The ＋ next to `Projects` creates a project (name + absolute path, `~` allowed) via `project/create`.
  - `✦ Ephemeral chat` in the sidebar uses the daemon's **ephemeral sessions**: nothing is written to disk or
    history, the title bar gains an `End` button, closing it removes it from the list, and it is gone after a bridge
    restart.
  - Because ephemeral sessions are not persisted, the daemon's `thread/read` cannot read them back
    (`thread/turns/list` does not support them either), so the bridge caches their events in order (up to 4000) and
    replays them when the page reopens — a refresh still shows the whole conversation, including your own messages
    (the daemon's `turn/completed` only carries a summary, so the replay trusts `item/*` events).
  - Ephemeral sessions cannot be queued (no rollout for `codex queue` to use); sending while one is running tells you
    to wait.
- **Per-session permission profile**: the small dot at the top left of the composer opens four choices; you can also
  pick one when creating a chat. The profile follows the session (stored in `~/.codex-remote/permissions.json` on the
  bridge), so opening the same session on the desktop shows the same permissions — loosening it on the phone will not
  silently downgrade it back on the desktop.

  | Profile | Meaning | Codex equivalent |
  | --- | --- | --- |
  | Follow desktop | Sends no override; uses whatever the session is set to on the desktop | default |
  | Decide for itself | Runs freely inside the workspace, asks with a card when crossing the boundary / needing network | `-s workspace-write` + `on-request` |
  | Decide for me | Out-of-bounds requests go to Codex's review sub-agent, no interruption | `--approve-for-me` |
  | Full access | No prompts, no sandbox, every command runs | `--dangerously-bypass-approvals-and-sandbox` |

  It applies to the next message: when sending, the bridge passes the profile on both `thread/resume` and
  `turn/start`; if the session is owned by the desktop and can only be queued, it is translated into `codex queue`
  arguments. The top right of the panel shows the setting **actually in effect on the computer** (from the daemon's
  `thread/settings/updated`); `—` right after a change, before sending anything, is normal.
- **Light / dark theme**: follows the phone's system by default; the `🌓` button at the top of the sidebar cycles
  `Follow system → ☀️ Light → 🌙 Dark`, stored in `localStorage` under `codex.theme`. (It lives in the sidebar because
  the title bar is reserved for the session title and status.) Both palettes are in `public/style.css`
  (`--bg` / `--text` / `--accent-soft` and friends), selected by `<html data-theme="light|dark">`; an inline script in
  `index.html` sets the attribute before the stylesheet loads, so there is no flash. Switching the theme also updates
  `meta[name=theme-color]` (address bar / status bar) and iOS's `apple-mobile-web-app-status-bar-style` (status bar
  text colour when added to the home screen).
- **One-tap copy**: code blocks and command output have a copy button in the top right; links (including bare URLs —
  previously plain text, now linkified automatically) and **long inline code** (≥20 chars: tokens, paths, commands;
  short identifiers get no button, to avoid a wall of icons) get one too. Tap it and the value lands on the clipboard,
  the button turns into a check mark, and a "Copied: …" toast appears. The icon is a 12×12 inline SVG (inherits the
  text colour), not an emoji — emoji use the system font and turn into a giant blob on phones.
  Links **open on a single tap**: the anchor is already `target="_blank"`, but in-app browsers on phones (and some
  shells that block `target=_blank`) often swallow it, so the page takes the click over — only `http/https`, opened
  explicitly in a new tab; if that is blocked too, it leaves the default behaviour alone and hands it back to the
  browser. Copying goes through `copyValueFor()`: code uses the whole `<pre>`/`<code>` text, links use the real `href`
  (not the truncated text on screen). The phone talks to `http://192.168.x.x`, which is not a secure context, so
  `navigator.clipboard` does not exist there; the fallback is an off-screen `readonly` textarea plus
  `execCommand('copy')` (`readonly` stops iOS from popping the keyboard, off-screen stops the page from scrolling).
- **Long sessions don't choke the phone**: a single `thread/read` has been measured at 11MB — 4.7MB of that MCP tool
  results (65KB in one item), 2963 items in a 31-minute session. Parsing that takes hundreds of milliseconds on a
  phone, and the 6-second background poll pays it over and over — which feels like "typing in the composer is laggy
  while Codex is replying". The bridge now does two things:
  - **Only the latest 500 items** (`GET /api/threads/:id?limit=`, max 20000). The whole session is still on the
    computer; scrolling to the top of the chat stream shows "⇡ show 500 earlier items", which fetches on demand; the
    scroll position is anchored by distance-from-bottom, so the view does not jump.
  - **Middle-truncation of very long text** (tool results 6KB, command output 8KB, reasoning 8KB, diffs 20KB, other
    strings 40KB), keeping the head and tail and noting how many characters were omitted.
  Measured on that session: payload 11.5MB → 1.24MB (gzip 341KB), front-end DOM 10.3MB → 1.1MB, items 2963 → 499.
- **Streaming does not re-render everything**: previously every chunk of agent text re-rendered its Markdown and every
  chunk of reasoning rebuilt the whole chat stream (`renderThread` in `public/app.js`). Now dirty items are recorded
  and only the matching element is refreshed, at most every 120ms (`scheduleDeltaFlush` / `flushItemDelta`); a full
  re-render only happens on real structural changes such as `item/started` and `item/completed`.
- **The desktop nudges you to refresh**: this page can stay open on a phone for days while the bridge on the computer
  gets redeployed. The 15-second latency probe carries the bridge version (`/api/ping`'s `version`); when it differs
  from the version the page loaded with, you get "The computer is now running vX — tap to refresh" (that toast does
  not auto-dismiss; tap it to reload), so you do not have to guess why a new feature is missing.
- **Page name**: the top of the sidebar shows this machine (hostname by default); tap it to rename — handy with
  several computers.
- **Latency button**: the dot at the top left of the composer, right next to "Follow desktop", is the current
  phone ↔ computer round trip. Green <80ms / yellow <250ms / red (or "no Codex") means the link or Codex has a
  problem. Tap it for details: `phone ↔ computer`, `computer ↔ Codex` (via `/api/ping`, using the side-effect-free
  `thread/loaded/list` three times and taking the minimum), **ingress path**, live-push state, check time, bridge
  version. It measures on page load, every 15 seconds, and when returning from the background; nothing is sent while
  the page is hidden. The ingress path is derived server-side from the client's source address (local / LAN /
  Tailscale / remote). On a Tailscale path the bridge reads the peer's `CurAddr` from `tailscale status --json`
  (the GUI CLI is auto-detected, or set `TAILSCALE_CLI`) and shows **Tailscale direct**,
  **Tailscale Peer Relay**, or **⚠ Tailscale relay · XXX**. A DERP path means hole punching failed (measured
  `relay "tok"`: 105ms round trip),
  so the panel suggests checking UDP 41641 / UPnP and, for hard NATs, configuring a Peer Relay on a low-latency VPS
  with Tailscale 1.86+. It also offers a tokenized LAN URL; tap it while the phone and computer share a Wi-Fi network
  and latency drops to single-digit milliseconds.
  When disconnected, colour is not the only signal (colour-blind users, bright sunlight): the dot becomes a red **⚠**
  and the affected rows read `⚠ unreachable` / `⚠ disconnected` / `⚠ interrupted, reconnecting`.

- **Three things at the transport layer**: `keepAliveTimeout` is raised to 65 seconds (Node closes idle connections
  after 5s by default while the probe runs every 15s, i.e. a fresh TCP connection — and a wasted RTT — every time);
  JSON responses over 1KB are gzipped (a full session read: 1.6MB → 424KB); the addresses printed at startup list the
  LAN one first.
- **Lands on the newest message after opening / refreshing**: images load asynchronously and keep the view pinned to
  the bottom, so there is no manual scrolling; scrolling up to read history is not yanked back. The browser's own
  scroll restoration is disabled (`history.scrollRestoration = 'manual'`), and returning from the background (bfcache
  restore) re-anchors to the last message, so a refresh never leaves you halfway up.
- Page height uses `100dvh`, so the composer and the newest message are not hidden while iOS Safari collapses or
  expands its toolbars.
- The composer font size is fixed at 16px, so focusing it on iOS no longer zooms the page.
- Everything is pushed live over SSE; output appears as it is produced.

## Background service

```bash
./scripts/install-launchd.sh     # install the LaunchAgent: start at login, restart on crash
./scripts/uninstall-launchd.sh   # uninstall
```

Logs: `~/.codex-remote/bridge.log`

## Requirements

- The desktop app (or `codex app-server daemon start`) is running and the control socket exists.
  `bin/codex-remote` tries `codex app-server daemon start` on startup.
- Node.js: `node` from `PATH` first, otherwise the runtime bundled with Codex.
  You can also set `CODEX_REMOTE_NODE=/path/to/node`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--port` | `8787` | Port to listen on |
| `--host` | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only |
| `--socket` | `~/.codex/app-server-control/app-server-control.sock` | app-server control socket |
| `--token-file` | `~/.codex-remote/token` | Token file; delete it to regenerate |
| `--name` | hostname | Name shown in the page/tab, to tell computers apart |
| `--name-file` | `~/.codex-remote/name` | Persisted name; `CODEX_REMOTE_NAME` also works |

## Security

- Every endpoint requires the token (cookie / `Authorization: Bearer` / one-time `?token=`).
- It is **plain HTTP**: anyone on the same LAN can sniff the traffic. Use it only on a network you trust.
- Do **not** expose the port to the internet. For remote access, put it behind a TLS reverse proxy (Caddy/nginx) or a
  VPN/Tailscale, and set `--host` to `127.0.0.1` so only the proxy can reach it.
- app-server is powerful: it can run commands and edit files. The token is equivalent to those permissions — do not
  share it.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| The page says "disconnected" | The daemon is not running: `codex app-server daemon start` |
| The phone cannot connect | Different subnet, macOS firewall, or `--host` set to `127.0.0.1` |
| 401 unauthorized | Reopen the full address that includes `?token=` |
| Rotate the token | Delete `~/.codex-remote/token` and restart the service |
| Sending says "queued" | Normal: the session is running on the computer; the message runs afterwards |
| A message lands below the answer / the answer appears above the message | The bridge used to append the echo of a message the daemon had not recorded yet to the end of the stream, so it looked like the answer came first. Echoes are now inserted back into their own turn: when you steer into a running turn (the daemon only records it on the next model turn, measured at tens of seconds), the message stays where you sent it and later output follows below. |
| Tapping a link in a reply does nothing | The page handles link clicks itself (opens a new tab); if an embedded browser blocks new tabs too, long-press the link and copy the address into a browser |
| "no rollout found" | The session id does not exist (usually a stale list); refresh the list |
| Tailscale says relay | Run `tailscale netcheck` and check `UDP`, `MappingVariesByDestIP`, and `PortMapping`; run `tailscale ping <peer-ip>` and look for `via <ip>:port` (direct) vs `via DERP(...)`. Allow UDP 41641 on both ends and enable UPnP/NAT-PMP; when a hard NAT prevents hole punching, use Tailscale 1.86+ and configure a low-latency VPS as a Peer Relay |

### Tailscale speed-up

- Check the result first: `tailscale ping <peer Tailscale IP>`. `via <ip>:port` is direct; `via DERP(tok)` is relayed.
- In `tailscale netcheck`, look for `UDP: true`, `MappingVariesByDestIP: false`, and a non-empty `PortMapping`. Allow UDP 41641 on both ends; enable UPnP/NAT-PMP on the router or give one end a static port mapping.
- If both sides are behind hard NATs, upgrade both to Tailscale 1.86+, run `tailscale set --relay-server-port=40000` on a low-latency VPS, and grant it `tailscale.com/cap/relay` in the tailnet policy. DERP still handles negotiation, but relayed traffic prefers the Peer Relay.
- When the phone and computer share a Wi-Fi network, always use the LAN address; even a direct Tailscale path cannot beat it.
| Latency stays above 200ms | The phone is probably on a Tailscale relay, not the LAN: open the latency panel, check "ingress path", and use the LAN link it offers |
| A permission profile is set on the phone but approvals still appear | The profile applies to the **next message**; if the desktop owns that session, `thread/resume` is rejected with `active writer` and the profile cannot be applied — send again after that turn ends |

## Files

```
bin/codex-remote            launcher script
src/ws-unix.js              WebSocket-over-Unix-socket client (zero dependencies)
src/appserver.js            app-server JSON-RPC 2.0 client
src/codex-cli.js            locate the codex CLI + queue delivery (fallback when busy)
src/permissions.js          per-session permission profiles, persisted to disk
src/server.js               HTTP + SSE bridge, auth, approval forwarding
public/                     phone UI
launchd/                    background service template
scripts/probe.js            connectivity probe, lists sessions directly
scripts/install-launchd.sh  install the background service
```

## Verifying

```bash
# talk to the daemon directly and list sessions
./bin/codex-remote --port 8787 &     # or already started by launchd
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/threads?limit=5

# measure both hops (this is what the phone button uses; daemon.ms is computer ↔ Codex)
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/ping

# read / change a session's permission profile (default / ask / auto / full)
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/permissions
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" -H 'content-type: application/json' \
  -d '{"mode":"ask"}' http://127.0.0.1:8787/api/threads/<thread-id>/permissions
```

## Multiple computers

Run one bridge per machine and tell them apart by page name (hostname by default):

- Tap the name at the top of the sidebar to rename it; stored in `~/.codex-remote/name`
- Or `bin/codex-remote --name "My Mac"`, or the `CODEX_REMOTE_NAME` environment variable
- `GET /api/meta` returns `{name, hostname, version, startedAt}` — one glance tells you which machine you are on

### Updating and redeploying

Whichever way you got the code, the last step is always `install-launchd.sh`: it copies `bin src public` over
`~/.codex-remote/app`, rewrites the plist and restarts the LaunchAgent (about 10 seconds of downtime).

```bash
git clone https://github.com/KotChiu/codex-remote.git ~/codex-remote   # first time
cd ~/codex-remote && git pull && bash scripts/install-launchd.sh      # afterwards
```

On a machine where git is unusable (`/usr/bin/git`'s CommandLineTools are broken), download the zip and deploy that:

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/KotChiu/codex-remote/archive/refs/heads/main.zip
unzip -q -o main.zip && bash codex-remote-main/scripts/install-launchd.sh
```

To fix git properly (`git pull` works again): run `xcode-select --install`; once it finishes `git --version` should
print a version.

When you edit the code yourself, just run `bash scripts/install-launchd.sh` in the source directory.

### Post-deploy checks

```bash
launchctl print gui/$(id -u)/com.codex.remote | grep -E 'state|pid'   # should be running
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/      # 401 = good (token required)
grep -c newChatCwd ~/.codex-remote/app/public/app.js                # is the deployed copy current?
tail -20 ~/.codex-remote/bridge.log                                  # check bridge.err.log on errors
```

Refresh the page once on the phone to get the new version (`public/` is served with `Cache-Control: no-store`).

After changing the front end, bump `BRIDGE_VERSION` in `src/server.js` if you want phones that already have the page
open to be told to refresh (the page compares it with the `version` returned by `/api/ping`). Not bumping also works —
you just have to pull-to-refresh manually.

### Do not leave test sessions behind

You will inevitably send a few real messages while working on this; do not leave those sessions in the list:

- **Prefer ephemeral chats** (nothing written to disk, not in history, gone when the bridge restarts):

  ```bash
  TOKEN=$(cat ~/.codex-remote/token)
  # create: take thread.id from the response
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"ephemeral":true,"cwd":"'"$PWD"'"}' http://127.0.0.1:8787/api/new-thread
  # close when done
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"threadId":"<id>"}' http://127.0.0.1:8787/api/ephemeral/close
  ```
- Some paths can only be tested with a real session (ephemeral ones cannot be read back) — then **delete it right
  away**: `node scripts/delete-thread.js <threadId>` (goes through the daemon's `thread/delete`; the rollout file goes
  with it).
- A session created but never used is invisible in the list, yet leaves a rollout stub in `~/.codex/sessions`
  containing a single `session_meta` line; clean those up with `node scripts/delete-thread.js --stubs`.

## Repository

Code lives on GitHub: <https://github.com/KotChiu/codex-remote>

```bash
git clone https://github.com/KotChiu/codex-remote.git
git remote add origin https://github.com/KotChiu/codex-remote.git   # in an existing checkout
```

Release flow: change code → `bash scripts/install-launchd.sh` to deploy → `git add -A && git commit` →
`git push origin main`. Refresh the page once on the phone to pick it up.

Before you publish changes, make sure git works on macOS: `git --version` failing with `xcrun: ... missing xcrun`
means the Xcode command line tools are missing (`/usr/bin/git` is just a shim) — run `xcode-select --install` once.
If you would rather not install Xcode, the git bundled with the Codex runtime works too:

```bash
~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git --version
```
