import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';
import type { Server } from 'node:http';
import { createConnector } from '../db/factory';
import { scanLocalPorts } from '../db/scanner';
import { Poller } from '../poller';
import type { ClientMessage, ConnectionTarget, DbKind, ServerMessage } from '../../../shared/types';
import type { DbConnector } from '../db/types';

interface ClientSession {
  socket: WebSocket;
  connector: DbConnector | null;
  poller: Poller | null;
}

/** A connection given on the command line: every browser that opens the UI is connected to it automatically. */
export interface Preset {
  target: ConnectionTarget;
  /** Safe to show: never contains the password. */
  label: string;
  /** Enable statement capture right away when the server's profiler is off (MySQL / MariaDB). */
  capture: boolean;
}

export interface HubOptions {
  preset?: Preset | null;
  verifyClient: VerifyClientCallbackSync;
}

const KINDS = new Set<DbKind>(['postgres', 'mysql', 'mssql', 'mongo', 'demo']);

const live = new Set<ClientSession>();

/** Disconnects every session so connectors can undo what they changed on the server (e.g. the general log). */
export async function closeAllSessions(): Promise<void> {
  await Promise.allSettled([...live].map((s) => teardown(s)));
}

/** Connection errors can echo parts of the connection string; never show the password. */
function redact(message: string, target: ConnectionTarget): string {
  let out = message;
  for (const secret of [target.password, target.uri]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('***');
  }
  return out;
}

async function connectSession(session: ClientSession, target: ConnectionTarget, send: (m: ServerMessage) => void, capture = false): Promise<void> {
  await teardown(session);
  try {
    const connector = createConnector(target.kind);
    await connector.connect(target);
    if (!live.has(session)) {
      // The browser went away while we were connecting.
      await connector.disconnect().catch(() => {});
      return;
    }
    session.connector = connector;
    session.poller = new Poller(connector, send);
    await session.poller.start();
    if (capture && connector.setCapture && connector.currentNotice?.()?.action === 'enableCapture') {
      await connector.setCapture(true);
      session.poller.nudge();
    }
  } catch (err) {
    const message = redact((err as Error).message, target);
    console.error(`[3ddb] connection failed: ${message}`);
    send({ type: 'error', message });
  }
}

export function attachWebSocketHub(server: Server, options: HubOptions): void {
  const wss = new WebSocketServer({ server, verifyClient: options.verifyClient });
  // `ws` re-emits the HTTP server's errors (e.g. EADDRINUSE) here; they are handled where listen() is called.
  wss.on('error', () => {});

  wss.on('connection', (socket) => {
    const session: ClientSession = { socket, connector: null, poller: null };
    live.add(session);

    const send = (msg: ServerMessage) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    if (options.preset) {
      send({ type: 'preset', label: options.preset.label });
      void connectSession(session, options.preset.target, send, options.preset.capture);
    }

    socket.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', message: 'Invalid message' });
        return;
      }

      if (msg.type === 'scan') {
        const results = await scanLocalPorts();
        send({ type: 'scanResult', results });
        return;
      }

      if (msg.type === 'disconnect') {
        await teardown(session);
        return;
      }

      if (msg.type === 'capture') {
        const connector = session.connector;
        if (!connector?.setCapture) {
          send({ type: 'error', message: 'This connection does not support statement capture' });
          return;
        }
        // The outcome (or the failure reason) is reported through the connector's notice.
        await connector.setCapture(Boolean(msg.on));
        session.poller?.nudge();
        return;
      }

      if (msg.type === 'exec') {
        // Only the sandboxed in-memory demo exposes `exec`; real databases are never written to from the UI.
        const connector = session.connector;
        if (!connector?.exec) {
          send({ type: 'execResult', result: { ok: false, message: 'The SQL console is only available on the demo database', ms: 0 } });
          return;
        }
        const result = await connector.exec(String(msg.sql ?? '')).catch((err: Error) => ({ ok: false, message: err.message, ms: 0 }));
        send({ type: 'execResult', result });
        session.poller?.nudge();
        return;
      }

      if (msg.type === 'connect') {
        if (!msg.target || !KINDS.has(msg.target.kind)) {
          send({ type: 'error', message: 'Unknown database type' });
          return;
        }
        await connectSession(session, msg.target, send);
      }
    });

    socket.on('close', () => {
      live.delete(session);
      void teardown(session);
    });
  });
}

async function teardown(session: ClientSession): Promise<void> {
  session.poller?.stop();
  session.poller = null;
  await session.connector?.disconnect().catch(() => {});
  session.connector = null;
}
