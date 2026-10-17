import type { ActivityEvent, Metrics, SchemaChange, ServerMessage, SessionInfo, Topology } from '../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, TableStat } from './db/types';
import { classify } from './db/util';

const INTERVAL_MS = Number(process.env.POLL_MS ?? 1000);
const TOPOLOGY_EVERY = 12;
const MAX_CHANGES = 40;

function ids<T>(items: T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((i) => [key(i), i]));
}

/** What appeared or disappeared between two catalogs: the "DDL" the scene reacts to. */
export function diffTopology(prev: Topology, next: Topology): SchemaChange[] {
  const out: SchemaChange[] = [];
  const compare = <T>(kind: SchemaChange['kind'], a: T[], b: T[], key: (t: T) => string, label: (t: T) => string) => {
    const before = ids(a, key);
    const after = ids(b, key);
    for (const [id, item] of after) if (!before.has(id)) out.push({ kind, action: 'created', id, label: label(item) });
    for (const [id, item] of before) if (!after.has(id)) out.push({ kind, action: 'dropped', id, label: label(item) });
  };
  const tableLabel = new Map([...prev.tables, ...next.tables].map((t) => [t.id, `${t.database}.${t.schema ? `${t.schema}.` : ''}${t.name}`]));

  compare('database', prev.databases, next.databases, (d) => d.name, (d) => d.name);
  compare('table', prev.tables, next.tables, (t) => t.id, (t) => tableLabel.get(t.id)!);
  compare('index', prev.indexes, next.indexes, (i) => i.id, (i) => `${i.name} su ${tableLabel.get(i.tableId) ?? i.tableId}`);
  compare('routine', prev.routines, next.routines, (r) => r.id, (r) => `${r.kind === 'procedure' ? 'SP' : 'FN'} ${r.database}.${r.name}`);
  compare('user', prev.users, next.users, (u) => u.name, (u) => u.name);
  compare('role', prev.roles, next.roles, (r) => r.name, (r) => r.name);
  return out.slice(0, MAX_CHANGES);
}

/**
 * Samples the connector's cumulative profiler counters and turns deltas into per-second metrics
 * and activity events, attributing them to users through live sessions when possible.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private ticks = 0;
  private lastTopologyJson = '';
  private topology: Topology | null = null;
  private fingerprint: string | undefined;
  private prevTables = new Map<string, TableStat>();
  private prevRoutines = new Map<string, RoutineStat>();
  private prevIndexes = new Map<string, IndexStat>();
  private prevAt = 0;
  private seenSessions = new Set<string>();

  constructor(
    private connector: DbConnector,
    private send: (msg: ServerMessage) => void,
  ) {}

  async start(): Promise<void> {
    await this.refreshTopology();
    await this.sample(true);
    this.publishNotice();
    this.timer = setInterval(() => void this.loop(), INTERVAL_MS);
  }

  private lastNotice = '';

  private publishNotice(): void {
    const notice = this.connector.currentNotice?.() ?? null;
    const json = JSON.stringify(notice);
    if (json === this.lastNotice) return;
    this.lastNotice = json;
    this.send({ type: 'notice', notice });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sample right now (e.g. after the UI console ran a statement) instead of waiting for the next tick. */
  nudge(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.ticks++;
      if (this.ticks % TOPOLOGY_EVERY === 0) await this.refreshTopology();
      await this.sample(false);
      this.publishNotice();
    } catch (err) {
      this.send({ type: 'error', message: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private async refreshTopology(): Promise<void> {
    const next = await this.connector.topology();
    const json = JSON.stringify(next);
    if (json === this.lastTopologyJson) return;
    this.lastTopologyJson = json;
    const previous = this.topology;
    this.topology = next;
    this.send({ type: 'topology', topology: next });
    if (previous) {
      const changes = diffTopology(previous, next);
      if (changes.length) this.send({ type: 'changes', changes });
    }
  }

  private async sample(baseline: boolean): Promise<void> {
    const s = await this.connector.sample();
    if (!baseline && s.fingerprint !== undefined && this.fingerprint !== undefined && s.fingerprint !== this.fingerprint) {
      await this.refreshTopology();
    }
    this.fingerprint = s.fingerprint;

    const now = Date.now();
    const dt = this.prevAt ? Math.max(0.2, (now - this.prevAt) / 1000) : 1;
    this.prevAt = now;

    const metrics: Metrics = { tables: {}, routines: {}, indexes: {} };
    const events: ActivityEvent[] = [];
    const userOnTable = new Map<string, SessionInfo>();
    const userOnRoutine = new Map<string, SessionInfo>();
    for (const session of s.sessions) {
      if (session.state === 'idle') continue;
      if (session.tableId && !userOnTable.has(session.tableId)) userOnTable.set(session.tableId, session);
      if (session.routineId && !userOnRoutine.has(session.routineId)) userOnRoutine.set(session.routineId, session);
    }

    for (const t of s.tables) {
      const prev = this.prevTables.get(t.id);
      this.prevTables.set(t.id, t);
      const reads = prev ? Math.max(0, t.reads - prev.reads) : 0;
      const writes = prev ? Math.max(0, t.writes - prev.writes) : 0;
      metrics.tables[t.id] = { readsPerSec: reads / dt, writesPerSec: writes / dt, locks: t.locks, waiting: t.waiting };
      if (baseline) continue;
      const user = userOnTable.get(t.id)?.user;
      const lockWait = t.waiting > 0;
      if (reads > 0) events.push({ kind: 'table', id: t.id, op: 'read', count: reads, user, lockWait });
      if (writes > 0) events.push({ kind: 'table', id: t.id, op: 'write', count: writes, user, lockWait });
    }

    for (const r of s.routines) {
      const prev = this.prevRoutines.get(r.id);
      this.prevRoutines.set(r.id, r);
      const calls = prev ? Math.max(0, r.calls - prev.calls) : 0;
      metrics.routines[r.id] = {
        calls: r.calls,
        callsPerSec: calls / dt,
        avgMs: r.calls > 0 ? r.totalMs / r.calls : 0,
      };
      if (!baseline && calls > 0) {
        events.push({ kind: 'routine', id: r.id, op: 'call', count: calls, user: userOnRoutine.get(r.id)?.user, lockWait: false });
      }
    }

    for (const i of s.indexes) {
      const prev = this.prevIndexes.get(i.id);
      this.prevIndexes.set(i.id, i);
      const scans = prev ? Math.max(0, i.scans - prev.scans) : 0;
      metrics.indexes[i.id] = { scans: i.scans, scansPerSec: scans / dt };
      if (!baseline && scans > 0) events.push({ kind: 'index', id: i.id, op: 'scan', count: scans, lockWait: false });
    }

    // Sessions catch work the counters miss (e.g. track_functions off, or no performance_schema).
    const seen = new Set<string>();
    for (const session of s.sessions) {
      if (session.state === 'idle') continue;
      const key = `${session.id}|${session.query ?? ''}`;
      seen.add(key);
      if (baseline || this.seenSessions.has(key)) continue;
      const lockWait = session.state === 'waiting';
      if (session.routineId) {
        if (!events.some((e) => e.kind === 'routine' && e.id === session.routineId)) {
          events.push({ kind: 'routine', id: session.routineId, op: 'call', count: 1, user: session.user, lockWait });
        }
      } else if (session.tableId && !events.some((e) => e.kind === 'table' && e.id === session.tableId)) {
        events.push({ kind: 'table', id: session.tableId, op: classify(session.query), count: 1, user: session.user, lockWait });
      }
    }
    this.seenSessions = seen;

    this.send({ type: 'tick', metrics, sessions: s.sessions, events });
  }
}
