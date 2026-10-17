import type { ConnectionTarget, ExecResult, Notice, SessionInfo, Topology } from '../../../shared/types';

/** Cumulative profiler counters for one table; the poller turns deltas into activity. */
export interface TableStat {
  id: string;
  reads: number;
  writes: number;
  locks: number;
  waiting: number;
}

export interface RoutineStat {
  id: string;
  calls: number;
  totalMs: number;
}

/** Cumulative scan counter for one index. */
export interface IndexStat {
  id: string;
  scans: number;
}

export interface Sample {
  tables: TableStat[];
  routines: RoutineStat[];
  indexes: IndexStat[];
  sessions: SessionInfo[];
  /** Cheap catalog digest; when it changes the poller refreshes the topology right away. */
  fingerprint?: string;
}

export interface DbConnector {
  connect(target: ConnectionTarget): Promise<void>;
  disconnect(): Promise<void>;
  /** Catalog: databases, tables, indexes, routines, users, roles. Polled slowly. */
  topology(): Promise<Topology>;
  /** Profiler counters + live sessions. Polled every tick. */
  sample(): Promise<Sample>;
  /** Only the sandboxed demo database accepts SQL from the UI. */
  exec?(sql: string): Promise<ExecResult>;
  /** Something the user should know about (or can fix), polled every tick. */
  currentNotice?(): Notice | null;
  /** Opt-in: capture every statement when the server's profiler is unavailable. Reverted on disconnect. */
  setCapture?(on: boolean): Promise<{ ok: boolean; message: string }>;
}
