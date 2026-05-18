import { EventEmitter } from 'node:events';

export class StdioJsonTransport extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.buffer = '';
    this.closed = false;

    child.stdout.on('data', (chunk) => this.consume(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      this.emit('error', { error, message: error.message });
    });
    child.on('exit', (code, signal) => {
      this.close(code ?? (signal ? 1006 : 1000), false, signal ? String(signal) : '');
    });
  }

  addEventListener(event, handler) {
    this.on(event, handler);
  }

  removeEventListener(event, handler) {
    this.off(event, handler);
  }

  send(text) {
    if (this.closed) {
      return;
    }

    this.child.stdin.write(`${text}\n`);
  }

  close(code = 1000, wasClean = true, reason = '') {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.child.stdin.writable) {
      this.child.stdin.end();
    }
    this.emit('close', { code, wasClean, reason });
  }

  consume(chunk) {
    if (this.closed) {
      return;
    }

    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.emit('message', { data: line });
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }
}
