export type DbKind = 'postgres' | 'mysql' | 'mssql' | 'mongo' | 'demo';

export interface ConnectionTarget {
  kind: DbKind;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Use TLS (certificates are not verified, so self-signed cloud/dev servers work). */
  ssl?: boolean;
  /** Full connection URI, used as is (MongoDB: replica sets, SRV, options). */
  uri?: string;
}

export interface ScanResult {
  port: number;
  kind: DbKind;
  reachable: boolean;
}

export interface DatabaseInfo {
  name: string;
  sizeBytes: number;
}

export interface TableInfo {
  id: string;
  database: string;
  schema: string;
  name: string;
  kind: 'table' | 'collection';
  rowCount: number;
  sizeBytes: number;
}

export interface RoutineInfo {
  id: string;
  database: string;
  schema: string;
  name: string;
  kind: 'procedure' | 'function';
  language: string;
  /** Table ids referenced by the routine body. */
  touches: string[];
}

export interface IndexInfo {
  /** `${tableId}#${name}`. */
  id: string;
  tableId: string;
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string;
  sizeBytes: number;
}

export interface RoleInfo {
  name: string;
  members: string[];
}

export interface UserInfo {
  name: string;
  roles: string[];
  superuser: boolean;
}

export interface Topology {
  engine: DbKind;
  server: string;
  databases: DatabaseInfo[];
  tables: TableInfo[];
  indexes: IndexInfo[];
  routines: RoutineInfo[];
  roles: RoleInfo[];
  users: UserInfo[];
}

export interface SchemaChange {
  kind: 'database' | 'table' | 'index' | 'routine' | 'user' | 'role';
  action: 'created' | 'dropped';
  id: string;
  label: string;
}

export interface ExecResult {
  ok: boolean;
  message: string;
  columns?: string[];
  rows?: string[][];
  ms: number;
}

export type SessionState = 'active' | 'idle' | 'waiting';

export interface SessionInfo {
  id: string;
  user: string;
  database: string;
  state: SessionState;
  tableId?: string;
  routineId?: string;
  query?: string;
  durationMs: number;
}

export interface TableMetrics {
  readsPerSec: number;
  writesPerSec: number;
  locks: number;
  waiting: number;
}

export interface RoutineMetrics {
  calls: number;
  callsPerSec: number;
  avgMs: number;
}

export interface IndexMetrics {
  scans: number;
  scansPerSec: number;
}

export interface Metrics {
  tables: Record<string, TableMetrics>;
  routines: Record<string, RoutineMetrics>;
  indexes: Record<string, IndexMetrics>;
}

export interface ActivityEvent {
  kind: 'table' | 'routine' | 'index';
  id: string;
  op: 'read' | 'write' | 'call' | 'scan';
  count: number;
  user?: string;
  lockWait: boolean;
}

/** A condition the user may want to act on (e.g. a profiler that is switched off on the server). */
export interface Notice {
  level: 'info' | 'warn';
  message: string;
  action?: 'enableCapture' | 'disableCapture';
}

export type ServerMessage =
  | { type: 'preset'; label: string }
  | { type: 'notice'; notice: Notice | null }
  | { type: 'topology'; topology: Topology }
  | { type: 'changes'; changes: SchemaChange[] }
  | { type: 'tick'; metrics: Metrics; sessions: SessionInfo[]; events: ActivityEvent[] }
  | { type: 'scanResult'; results: ScanResult[] }
  | { type: 'execResult'; result: ExecResult }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'connect'; target: ConnectionTarget }
  | { type: 'disconnect' }
  | { type: 'scan' }
  | { type: 'exec'; sql: string }
  | { type: 'capture'; on: boolean };
