import type { ClientMessage, ServerMessage } from '../../../shared/types';

export class WsClient {
  private socket: WebSocket | null = null;
  private listeners: Array<(msg: ServerMessage) => void> = [];

  connect(): void {
    // Packaged: the server that served this page also speaks WebSocket. Dev: Vite serves the page, the server is on :4000.
    const secure = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = import.meta.env.DEV ? `ws://${location.hostname}:4000` : `${secure}://${location.host}`;
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      this.listeners.forEach((fn) => fn(msg));
    });
    this.socket.addEventListener('error', (e) => console.error('[ws] error', e));
    this.socket.addEventListener('close', (e) => console.warn('[ws] close', e.code, e.reason));
  }

  onMessage(fn: (msg: ServerMessage) => void): void {
    this.listeners.push(fn);
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      this.socket?.addEventListener('open', () => this.socket?.send(JSON.stringify(msg)), { once: true });
    }
  }
}
