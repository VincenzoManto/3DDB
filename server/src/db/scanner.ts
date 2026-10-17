import net from 'node:net';
import type { DbKind, ScanResult } from '../../../shared/types';

const PORTS: Array<{ port: number; kind: DbKind }> = [
  { port: 5432, kind: 'postgres' },
  { port: 3306, kind: 'mysql' },
  { port: 1433, kind: 'mssql' },
  { port: 27017, kind: 'mongo' },
];

function checkPort(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

export async function scanLocalPorts(): Promise<ScanResult[]> {
  const results = await Promise.all(
    PORTS.map(async ({ port, kind }) => ({
      port,
      kind,
      reachable: await checkPort(port),
    })),
  );
  return results;
}
