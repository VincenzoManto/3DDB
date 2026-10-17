import type { ConnectionTarget, DbKind } from '../../../shared/types';

type RealKind = Exclude<DbKind, 'demo'>;

export const DEFAULT_PORT: Record<RealKind, number> = { postgres: 5432, mysql: 3306, mssql: 1433, mongo: 27017 };

/** Same defaults as the connection form in the UI. */
const DEFAULT_USER: Partial<Record<RealKind, string>> = { postgres: 'postgres', mysql: 'root', mssql: 'sa' };
const DEFAULT_DATABASE: Partial<Record<RealKind, string>> = { postgres: 'postgres', mssql: 'master' };

const TYPE_ALIASES: Record<string, DbKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mssql: 'mssql',
  sqlserver: 'mssql',
  'sql-server': 'mssql',
  mongo: 'mongo',
  mongodb: 'mongo',
  demo: 'demo',
};

export const TYPE_NAMES = 'postgres, mysql (or mariadb), mssql (or sqlserver), mongo (or mongodb), demo';

const SCHEMES: Record<string, RealKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mssql: 'mssql',
  sqlserver: 'mssql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
};

export class UsageError extends Error {}

export function parseType(value: string): DbKind {
  const kind = TYPE_ALIASES[value.trim().toLowerCase()];
  if (!kind) throw new UsageError(`Unknown --type "${value}". Use one of: ${TYPE_NAMES}.`);
  return kind;
}

function parsePort(value: string | number, label = '--port'): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`Invalid ${label} "${value}": expected a number between 1 and 65535.`);
  return n;
}

const truthy = (v: string | null | undefined): boolean => v !== null && v !== undefined && /^(1|true|yes|require|required|verify-ca|verify-full)$/i.test(v);

function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** `key=value;key=value` (ADO.NET / JDBC style), case-insensitive keys. */
function parsePairs(text: string, separator: RegExp): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of text.split(separator)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    map.set(part.slice(0, i).trim().toLowerCase(), unquote(part.slice(i + 1)));
  }
  return map;
}

function hostAndPort(spec: string, defaultPort?: number): { host: string; port?: number } {
  let s = spec.trim().replace(/^tcp:/i, '');
  if (s.includes('\\') && !/,\d+$/.test(s)) {
    throw new UsageError('SQL Server named instances are not supported here; give the port instead, e.g. host,1433.');
  }
  s = s.split('\\')[0];
  const comma = s.lastIndexOf(',');
  if (comma > 0) return { host: s.slice(0, comma), port: parsePort(s.slice(comma + 1), 'port in the connection string') };
  return { host: s, port: defaultPort };
}

function fromUrl(kind: RealKind, text: string): ConnectionTarget {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    const port = text.match(/@?[^/@:?#]*:(\d+)(?=[/?#]|$)/)?.[1];
    if (port && Number(port) > 65535) throw new UsageError(`Invalid port ${port} in the connection string: expected a number between 1 and 65535.`);
    throw new UsageError(
      'Could not parse the connection string. If the password contains special characters (@ / : ? # %), URL-encode them, e.g. @ becomes %40.',
    );
  }
  const q = u.searchParams;
  const ssl = truthy(q.get('sslmode')) || truthy(q.get('ssl')) || truthy(q.get('tls')) || truthy(q.get('usessl')) || truthy(q.get('encrypt'));
  const database = decode(u.pathname.replace(/^\//, ''));
  return {
    kind,
    host: decode(u.hostname).replace(/^\[|\]$/g, '') || undefined,
    port: u.port ? parsePort(u.port, 'port in the connection string') : undefined,
    user: u.username ? decode(u.username) : undefined,
    password: u.password ? decode(u.password) : undefined,
    database: database || undefined,
    ssl: ssl || undefined,
  };
}

/** `sqlserver://host:1433;databaseName=db;user=u;password=p` (JDBC) */
function fromJdbcSqlServer(text: string): ConnectionTarget {
  const rest = text.replace(/^[a-z]+:\/\//i, '');
  const semi = rest.indexOf(';');
  const authority = semi < 0 ? rest : rest.slice(0, semi);
  // JDBC puts the port after a colon (host:1433), unlike ADO.NET's comma.
  const m = authority.match(/^(\[[^\]]+\]|[^:]*)(?::(\d+))?$/);
  const host = (m?.[1] ?? authority).replace(/^\[|\]$/g, '');
  const port = m?.[2] ? parsePort(m[2], 'port in the connection string') : undefined;
  const kv = parsePairs(semi < 0 ? '' : rest.slice(semi + 1), /;/);
  return {
    kind: 'mssql',
    host: host || undefined,
    port,
    user: kv.get('user') ?? kv.get('username') ?? kv.get('uid'),
    password: kv.get('password') ?? kv.get('pwd'),
    database: kv.get('databasename') ?? kv.get('database'),
    ssl: truthy(kv.get('encrypt')) || undefined,
  };
}

/** `Server=tcp:host,1433;Initial Catalog=db;User ID=u;Password=p;Encrypt=True` (ADO.NET) */
function fromAdo(text: string): ConnectionTarget {
  const kv = parsePairs(text, /;/);
  const server = kv.get('server') ?? kv.get('data source') ?? kv.get('address') ?? kv.get('addr') ?? kv.get('network address');
  if (!server) throw new UsageError('The SQL Server connection string has no Server= / Data Source= entry.');
  const { host, port } = hostAndPort(server);
  return {
    kind: 'mssql',
    host,
    port,
    user: kv.get('user id') ?? kv.get('uid') ?? kv.get('user'),
    password: kv.get('password') ?? kv.get('pwd'),
    database: kv.get('initial catalog') ?? kv.get('database'),
    ssl: truthy(kv.get('encrypt')) || undefined,
  };
}

/** `host=localhost port=5432 dbname=app user=me password=secret sslmode=require` (libpq) */
function fromLibpq(text: string): ConnectionTarget {
  const kv = new Map<string, string>();
  for (const m of text.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)) kv.set(m[1].toLowerCase(), unquote(m[2]).replace(/\\(.)/g, '$1'));
  return {
    kind: 'postgres',
    host: kv.get('host'),
    port: kv.has('port') ? parsePort(kv.get('port')!, 'port in the connection string') : undefined,
    user: kv.get('user'),
    password: kv.get('password'),
    database: kv.get('dbname') ?? kv.get('database'),
    ssl: truthy(kv.get('sslmode')) || undefined,
  };
}

function fromMongoUri(text: string): ConnectionTarget {
  const m = text.match(/^mongodb(?:\+srv)?:\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?/i);
  if (!m) throw new UsageError('Could not parse the MongoDB connection string.');
  const [, creds, hosts, db] = m;
  const first = hosts.split(',')[0];
  const portMatch = first.match(/^(.*):(\d+)$/);
  const colon = creds?.indexOf(':') ?? -1;
  return {
    kind: 'mongo',
    uri: text,
    host: (portMatch ? portMatch[1] : first).replace(/^\[|\]$/g, ''),
    port: portMatch ? Number(portMatch[2]) : undefined,
    user: creds ? decode(colon < 0 ? creds : creds.slice(0, colon)) : undefined,
    database: db ? decode(db) : undefined,
  };
}

/** Understands URLs (postgres://, mysql://, mariadb://, mssql://, sqlserver://, mongodb://), ADO.NET, JDBC and libpq strings. */
export function parseConnectionString(input: string): ConnectionTarget {
  const text = unquote(input.replace(/^jdbc:/i, ''));
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();

  if (scheme) {
    const kind = SCHEMES[scheme];
    if (!kind) {
      throw new UsageError(`Unsupported scheme "${scheme}://". Supported: postgres://, mysql://, mariadb://, mssql://, sqlserver://, mongodb://, mongodb+srv://.`);
    }
    if (kind === 'mongo') return fromMongoUri(text);
    if (kind === 'mssql' && text.includes(';')) return fromJdbcSqlServer(text);
    return fromUrl(kind, text);
  }
  if (/;/.test(text) && /=/.test(text)) return fromAdo(text);
  if (/\b(host|dbname|user)\s*=/.test(text)) return fromLibpq(text);
  throw new UsageError('Unrecognised connection string. Expected something like postgres://user:password@host:5432/database.');
}

export interface ConnectionFlags {
  type?: string;
  server?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  string?: string;
  ssl?: boolean;
}

/**
 * Builds the connection target from CLI flags (and THREEDDB_* environment variables).
 * Returns null when nothing was asked for, so the UI can start with its connection panel.
 */
export function resolveTarget(flags: ConnectionFlags, env: Record<string, string | undefined> = {}): ConnectionTarget | null {
  const asked = flags.type ?? flags.server ?? flags.port ?? flags.user ?? flags.password ?? flags.database ?? flags.string ?? env.THREEDDB_URL;
  if (asked === undefined && !flags.ssl) return null;

  const wantedKind = flags.type ? parseType(flags.type) : undefined;
  if (wantedKind === 'demo') return { kind: 'demo' };

  const connectionString = flags.string ?? env.THREEDDB_URL;
  let target: ConnectionTarget;
  if (connectionString) {
    target = parseConnectionString(connectionString);
    if (wantedKind && wantedKind !== target.kind) {
      throw new UsageError(`--type ${flags.type} does not match the connection string, which is for ${target.kind}.`);
    }
  } else {
    if (!wantedKind) throw new UsageError(`--type is required (${TYPE_NAMES}), or pass --string.`);
    target = { kind: wantedKind };
  }

  const kind = target.kind as RealKind;
  // Explicit flags win over the connection string, so a password can be kept out of the URL.
  if (flags.server) target.host = flags.server;
  if (flags.port) target.port = parsePort(flags.port);
  if (flags.user !== undefined) target.user = flags.user;
  if (flags.database !== undefined) target.database = flags.database;
  const password = flags.password ?? env.THREEDDB_PASSWORD;
  if (password !== undefined) target.password = password;
  if (flags.ssl) target.ssl = true;

  target.host ??= 'localhost';
  target.port ??= DEFAULT_PORT[kind];
  target.user ??= DEFAULT_USER[kind];
  target.database ??= DEFAULT_DATABASE[kind];
  return target;
}

/** Safe to print: never includes the password or the raw connection string. */
export function describeTarget(t: ConnectionTarget): string {
  if (t.kind === 'demo') return 'built-in demo';
  const label = t.kind === 'mysql' ? 'mysql/mariadb' : t.kind;
  const who = t.user ? `${t.user}@` : '';
  const where = `${t.host ?? 'localhost'}${t.port ? `:${t.port}` : ''}`;
  return `${label} ${who}${where}${t.database ? `/${t.database}` : ''}${t.ssl ? ' (tls)' : ''}`;
}
