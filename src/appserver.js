'use strict';

const { EventEmitter } = require('node:events');
const { WebSocketOverUnix } = require('./ws-unix');

/* daemon 要是收下请求就不再回话（卡住、半死），没有超时的话这个 Promise 永远不落定，
   HTTP 请求会一直挂着、pendingRequests 也会一直涨。给个宽松但存在的上限。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

const DEFAULT_CLIENT_INFO = {
  name: 'codex_remote',
  title: 'Codex Remote (mobile)',
  version: '0.1.0',
};

class AppServerConnection extends EventEmitter {
  constructor(socketPath, options = {}) {
    super();
    this.socketPath = socketPath;
    this.clientInfo = options.clientInfo || DEFAULT_CLIENT_INFO;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.socket = null;
    this.userAgent = null;
    this.ready = false;
  }

  async connect() {
    const socket = new WebSocketOverUnix(this.socketPath);
    this.socket = socket;

    socket.on('message', (text) => this._handleMessage(text));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', (error) => this._handleSocketClose(error));

    await socket.connect();

    const result = await this.request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });

    this.userAgent = result?.userAgent ?? null;
    this.socket.sendJson({ method: 'initialized', params: {} });
    this.ready = true;
    this.emit('ready', result);
    return result;
  }

  request(method, params, options = {}) {
    if (!this.socket) return Promise.reject(new Error('not connected'));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.delete(id)) return;
        const error = new Error(`${method} timed out after ${timeoutMs}ms`);
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
      if (timer.unref) timer.unref();

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
      this.socket.sendJson({ method, id, params: params ?? {} });
    });
  }

  respond(id, result) {
    if (!this.socket) return;
    this.socket.sendJson({ id, result });
  }

  respondError(id, code, message) {
    if (!this.socket) return;
    this.socket.sendJson({ id, error: { code, message } });
  }

  close() {
    if (this.socket) this.socket.close();
  }

  _handleSocketClose(error) {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const entry of pending) {
      entry.reject(new Error(`connection closed before ${entry.method} completed`));
    }
    this.ready = false;
    this.emit('close', error);
  }

  _handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this.emit('error', new Error(`received unparsable payload: ${error.message}`));
      return;
    }

    if (message.method !== undefined) {
      if (message.id !== undefined) this.emit('serverRequest', message);
      else this.emit('notification', message);
      return;
    }

    if (message.id === undefined) return;

    const entry = this.pendingRequests.get(message.id);
    if (!entry) return;
    this.pendingRequests.delete(message.id);

    if (message.error) {
      const error = new Error(message.error.message || 'request failed');
      error.rpcError = message.error;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }
}

module.exports = { AppServerConnection };
