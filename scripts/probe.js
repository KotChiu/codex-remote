'use strict';

const os = require('node:os');
const path = require('node:path');
const { WebSocketOverUnix } = require('../src/ws-unix');

const socketPath =
  process.argv[2] || path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');

async function main() {
  const socket = new WebSocketOverUnix(socketPath);
  socket.on('message', (text) => {
    const message = JSON.parse(text);
    if (message.id === 0) {
      console.log('initialize ->', JSON.stringify(message.result ?? message.error).slice(0, 200));
      socket.sendJson({
        method: 'thread/list',
        id: 1,
        params: { limit: 20, archived: false },
      });
    } else if (message.id === 1) {
      const threads = message.result?.data ?? [];
      console.log(`thread/list -> ${threads.length} threads`);
      for (const thread of threads.slice(0, 10)) {
        const status = thread.status?.type ?? '?';
        const updated = new Date((thread.updatedAt ?? 0) * 1000).toISOString().slice(0, 16);
        console.log(
          `  [${status}] ${updated}  ${thread.id.slice(0, 8)}  ${(thread.name || thread.preview || '').slice(0, 60)}`
        );
      }
      socket.close();
      process.exit(0);
    }
  });

  socket.on('error', (error) => {
    console.error('socket error:', error.message);
    process.exit(1);
  });

  await socket.connect();
  console.log('connected over unix socket:', socketPath);
  socket.sendJson({
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: { name: 'codex_remote_probe', title: 'Codex Remote Probe', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    },
  });
  socket.sendJson({ method: 'initialized', params: {} });
}

main().catch((error) => {
  console.error('fatal:', error.message);
  process.exit(1);
});
