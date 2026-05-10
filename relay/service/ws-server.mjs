import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function handleWebSocketUpgrade(request, socket, head, onConnection) {
  const key = request.headers['sec-websocket-key'];

  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(`${key}${WS_GUID}`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  const connection = new WebSocketTextConnection(socket);
  onConnection(connection, request);

  if (head.length > 0) {
    connection.acceptData(head);
  }
}

export class WebSocketTextConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    socket.on('data', (chunk) => this.acceptData(chunk));
    socket.on('close', () => this.close());
    socket.on('error', (error) => this.emit('error', error));
  }

  acceptData(chunk) {
    if (this.closed) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.readFrames();
  }

  sendText(text) {
    if (this.closed) {
      return;
    }

    const payload = Buffer.from(text, 'utf8');
    const header = encodeHeader(0x1, payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.emit('close');
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        payloadLength = high * 2 ** 32 + low;
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      const frameLength = offset + maskLength + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }

      let maskingKey;
      if (masked) {
        maskingKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(frameLength);

      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= maskingKey[index % 4];
        }
      }

      if (opcode === 0x8) {
        this.socket.end();
        this.close();
        return;
      }

      if (opcode === 0x9) {
        this.sendControlFrame(0xA, payload);
        continue;
      }

      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }

  sendControlFrame(opcode, payload) {
    if (payload.length > 125 || this.closed) {
      return;
    }

    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
  }
}

function encodeHeader(opcode, payloadLength) {
  const firstByte = 0x80 | opcode;

  if (payloadLength < 126) {
    return Buffer.from([firstByte, payloadLength]);
  }

  if (payloadLength < 65536) {
    const header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return header;
  }

  const header = Buffer.alloc(10);
  header[0] = firstByte;
  header[1] = 127;
  header.writeUInt32BE(Math.floor(payloadLength / 2 ** 32), 2);
  header.writeUInt32BE(payloadLength >>> 0, 6);
  return header;
}

