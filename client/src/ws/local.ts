import type { ClientMessage, ServerMessage } from '../../../shared/types';
import { getSharedMicroDb } from '../../../server/src/db/microdb';
import { Poller } from '../../../server/src/poller';

/**
 * Drop-in replacement for the WebSocket client used by the static (GitHub Pages) build: the demo
 * connector and the poller run in the page itself, on PGlite compiled to WASM. Same messages, no server.
 */
export class WsClient {
  private listeners: Array<(msg: ServerMessage) => void> = [];
  private poller: Poller | null = null;
  private db = getSharedMicroDb();

  connect(): void {
    setTimeout(() => void this.boot(), 0);
  }

  private emit = (msg: ServerMessage): void => {
    // Round-trip through JSON so the client sees exactly what it would get over the wire.
    const copy: ServerMessage = JSON.parse(JSON.stringify(msg));
    setTimeout(() => this.listeners.forEach((fn) => fn(copy)), 0);
  };

  private async boot(): Promise<void> {
    this.emit({ type: 'preset', label: 'built-in demo (PGlite, in your browser)' });
    try {
      await this.db.connect();
      this.poller = new Poller(this.db, this.emit);
      await this.poller.start();
      window.dispatchEvent(new CustomEvent('3d-db:ready'));
    } catch (err) {
      this.emit({ type: 'error', message: (err as Error).message });
    }
  }

  onMessage(fn: (msg: ServerMessage) => void): void {
    this.listeners.push(fn);
  }

  send(msg: ClientMessage): void {
    void this.handle(msg);
  }

  private async handle(msg: ClientMessage): Promise<void> {
    if (msg.type === 'exec') {
      const result = await this.db.exec(String(msg.sql ?? '')).catch((err: Error) => ({ ok: false, message: err.message, ms: 0 }));
      this.emit({ type: 'execResult', result });
      this.poller?.nudge();
    } else if (msg.type === 'scan') {
      this.emit({ type: 'scanResult', results: [] });
    } else if (msg.type === 'connect' && msg.target.kind !== 'demo') {
      this.emit({ type: 'error', message: 'This page can only run the demo. Run "npx 3d-db" locally to connect a real database.' });
    } else if (msg.type === 'capture') {
      this.emit({ type: 'error', message: 'Statement capture needs a real MySQL / MariaDB server' });
    }
  }
}
