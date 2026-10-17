'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

class WebSocketOverUnix extends EventEmitter {
  constructor(socketPath, options = {}) {
    super();
    this.socketPath = socketPath;
    this.requestPath = options.requestPath || '/';
    this.hostHeader = options.host || 'localhost';
    this.headers = {};
    this.socket = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.closed = false;
    this.closeEmitted = false;
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
    this.handshakeResolve = null;
    this.handshakeReject = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;

      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect({ path: this.socketPath });
      this.socket = socket;

      socket.once('connect', () => {
        socket.write(
          `GET ${this.requestPath} HTTP/1.1\r\n` +
            `Host: ${this.hostHeader}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n'
        );
      });

      socket.on('data', (chunk) => this._handleData(chunk));
      socket.on('error', (error) => {
        if (!this.handshakeComplete) {
          this.handshakeComplete = true;
          this.handshakeReject(error);
        } else {
          this.emit('error', error);
        }
        this._emitClose(error);
      });
      socket.on('close', () => this._emitClose(null));
    });
  }

  sendText(text) {
    if (this.closed) return false;
    this.socket.write(this._encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')));
    return true;
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(this._encodeFrame(OPCODE.CLOSE, payload));
    this.closed = true;
    this.socket.end();
  }

  destroy() {
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }

  _emitClose(error) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closed = true;
    this.emit('close', error);
  }

  _handleData(chunk) {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    if (!this.handshakeComplete) {
      const separator = this.receiveBuffer.indexOf('\r\n\r\n');
      if (separator === -1) return;

      const rawHeaders = this.receiveBuffer.subarray(0, separator).toString('latin1');
      this.receiveBuffer = this.receiveBuffer.subarray(separator + 4);

      const lines = rawHeaders.split('\r\n');
      const statusLine = lines[0] || '';
      const statusMatch = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);

      if (!statusMatch || Number(statusMatch[1]) !== 101) {
        const error = new Error(`WebSocket handshake rejected: ${statusLine}`);
        error.statusCode = statusMatch ? Number(statusMatch[1]) : 0;
        this.handshakeComplete = true;
        this.handshakeReject(error);
        this.socket.destroy();
        return;
      }

      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          this.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }

      this.handshakeComplete = true;
      this.handshakeResolve();
    }

    this._drainFrames();
  }

  _drainFrames() {
    for (;;) {
      const buffer = this.receiveBuffer;
      if (buffer.length < 2) return;

      const isFinal = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const isMasked = (buffer[1] & 0x80) !== 0;

      let payloadLength = buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        const bigLength = buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_FRAME_BYTES)) {
          this.emit('error', new Error('frame exceeds maximum supported size'));
          this.destroy();
          return;
        }
        payloadLength = Number(bigLength);
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLength) return;

      let payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      this.receiveBuffer = buffer.subarray(offset + payloadLength);

      if (maskKey) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= maskKey[index % 4];
        }
      }

      this._handleFrame(isFinal, opcode, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(isFinal, opcode, payload) {
    if (opcode === OPCODE.CLOSE) {
      this.closed = true;
      this.socket.end(this._encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
      return;
    }

    if (opcode === OPCODE.PING) {
      this.socket.write(this._encodeFrame(OPCODE.PONG, payload));
      return;
    }

    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.CONTINUATION) {
      this.fragmentChunks.push(payload);
    } else if (isFinal) {
      this._deliver(opcode, payload);
      return;
    } else {
      this.fragmentOpcode = opcode;
      this.fragmentChunks = [payload];
    }

    if (isFinal) {
      const combined = Buffer.concat(this.fragmentChunks);
      const finalOpcode = this.fragmentOpcode ?? OPCODE.TEXT;
      this.fragmentOpcode = null;
      this.fragmentChunks = [];
      this._deliver(finalOpcode, combined);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else if (opcode === OPCODE.BINARY) {
      this.emit('binary', payload);
    }
  }

  _encodeFrame(opcode, payload) {
    const maskKey = crypto.randomBytes(4);
    let header;

    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    header[0] = 0x80 | opcode;

    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] ^= maskKey[index % 4];
    }

    return Buffer.concat([header, maskKey, masked]);
  }
}

module.exports = { WebSocketOverUnix };
