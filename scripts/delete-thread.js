'use strict';

/* 删除会话（测试用完的会话别留在列表里）：
     node scripts/delete-thread.js <threadId> [threadId...]   走 daemon 的 thread/delete，rollout 一起没
     node scripts/delete-thread.js --stubs                    清掉「建了没发消息」留下的空 rollout 存根
   临时对话（ephemeral）不写盘，关掉就没了，永远轮不到这里。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketOverUnix } = require('../src/ws-unix');

const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
const socketPath = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');

/* 只有 session_meta 一行、没有任何对话内容的 rollout，就是「新建了但一句话都没发」的存根 */
function listStubs(root = sessionsRoot, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listStubs(full, found);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const lines = fs.readFileSync(full, 'utf8').split('\n').filter((line) => line.trim()).length;
      if (lines === 1) found.push(full);
    }
  }
  return found;
}

function cleanStubs() {
  const stubs = listStubs();
  if (stubs.length === 0) {
    console.log('没有空存根，干净');
    return;
  }
  for (const stub of stubs) {
    fs.unlinkSync(stub);
    console.log('已删除空存根', path.relative(sessionsRoot, stub));
  }
}

async function deleteThreads(threadIds) {
  const socket = new WebSocketOverUnix(socketPath);
  const done = new Map();

  socket.on('message', (text) => {
    const message = JSON.parse(text);
    if (message.id === 0) {
      threadIds.forEach((threadId, index) => {
        socket.sendJson({ method: 'thread/delete', id: index + 1, params: { threadId } });
      });
      return;
    }
    const index = Number(message.id) - 1;
    if (index >= 0 && index < threadIds.length) done.set(index, message.error ? message.error.message : null);
  });

  await socket.connect();
  socket.sendJson({
    method: 'initialize',
    id: 0,
    params: { clientInfo: { name: 'codex_remote', title: 'Codex Remote', version: '0.1.0' }, capabilities: { experimentalApi: true } },
  });
  socket.sendJson({ method: 'initialized', params: {} });

  const deadline = Date.now() + 8000;
  while (done.size < threadIds.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  socket.close();

  let failed = 0;
  threadIds.forEach((threadId, index) => {
    const error = done.get(index);
    if (error) {
      failed += 1;
      console.error('删除失败', threadId, error);
    } else {
      console.log('已删除', threadId);
    }
  });
  if (failed) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--stubs')) {
    cleanStubs();
    return;
  }
  const threadIds = args.filter((arg) => !arg.startsWith('-'));
  if (threadIds.length === 0) {
    console.error('用法: node scripts/delete-thread.js <threadId> [threadId...]');
    console.error('      node scripts/delete-thread.js --stubs');
    process.exitCode = 2;
    return;
  }
  await deleteThreads(threadIds);
}

main().catch((error) => {
  console.error('出错：', error.message);
  process.exitCode = 1;
});
