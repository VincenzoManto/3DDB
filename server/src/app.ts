import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachWebSocketHub, closeAllSessions, type Preset } from './ws/hub';
import { warmUpMicroDb } from './db/microdb';

export interface StartOptions {
  port: number;
  /** Interface to listen on. Defaults to loopback: the UI has no login, so it must not be reachable from the network. */
  bind?: string;
  /** Built UI to serve (the published package ships it). Omit in development, where Vite serves the UI. */
  staticDir?: string;
  /** Connect every browser to this database automatically. */
  preset?: Preset | null;
  /** Try the next ports when `port` is busy. */
  autoPort?: boolean;
  /** Pre-compile the demo database (slow the first time) so "Try the demo data" is instant. */
  warmDemo?: boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isLoopback = (address: string) => address === 'localhost' || address === '::1' || address.startsWith('127.');

/** Host header without the port; keeps the brackets of an IPv6 literal. */
function hostnameOf(hostHeader: string | undefined): string {
  const h = (hostHeader ?? '').trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

function listen(server: ReturnType<typeof createServer>, port: number, bind: string, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 1) {
        listen(server, port + 1, bind, attempts - 1).then(resolve, reject);
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bind);
  });
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const bind = options.bind ?? '127.0.0.1';
  const guardHost = isLoopback(bind);
  const production = Boolean(options.staticDir);

  const app = express();
  const server = createServer(app);

  // DNS-rebinding guard: a page on evil.example resolving to 127.0.0.1 would otherwise reach this server.
  const hostAllowed = (req: IncomingMessage) => !guardHost || LOCAL_HOSTS.has(hostnameOf(req.headers.host));

  app.use((req, res, next) => {
    if (hostAllowed(req)) next();
    else res.status(403).type('text/plain').send('Forbidden host');
  });
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  if (options.staticDir) app.use(express.static(options.staticDir));

  attachWebSocketHub(server, {
    preset: options.preset,
    // Cross-site WebSocket hijacking guard: browsers always send Origin, so a hostile web page is refused.
    // Non-browser clients send no Origin and are local processes.
    verifyClient: ({ origin, req }) => {
      if (!hostAllowed(req)) return false;
      if (!origin) return true;
      let page: URL;
      try {
        page = new URL(origin);
      } catch {
        return false;
      }
      // Packaged UI: same origin only. Development: the Vite dev server runs on another local port.
      return production ? page.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() : LOCAL_HOSTS.has(page.hostname);
    },
  });

  const port = await listen(server, options.port, bind, options.autoPort ? 20 : 1);

  if (options.warmDemo) {
    warmUpMicroDb()
      .then(() => console.log('[3d-db] demo dataset ready'))
      .catch((err) => console.error('[3d-db] demo dataset failed to warm up', err));
  }

  const shown = bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind.includes(':') ? `[${bind}]` : bind;
  return {
    port,
    url: `http://${shown}:${port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** On Ctrl+C / SIGTERM, disconnect cleanly so connectors can restore anything they changed on the server. */
export function exitCleanlyOn(running: RunningServer): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      const force = setTimeout(() => process.exit(0), 3000);
      void running.close().finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
    });
  }
}
