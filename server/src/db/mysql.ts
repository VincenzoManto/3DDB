import mysql from 'mysql2/promise';
import type {
  ConnectionTarget,
  IndexInfo,
  Notice,
  RoutineInfo,
  SessionInfo,
  TableInfo,
  Topology,
  UserInfo,
} from '../../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, Sample, TableStat } from './types';
import { MAX_DATABASES, RoutineIndex, TableIndex, classify, indexId, num, rolesFromMembership, tableId } from './util';

const SYSTEM = `('mysql', 'information_schema', 'performance_schema', 'sys')`;

const DATABASES_SQL = `
  SELECT s.schema_name AS name, COALESCE(SUM(t.data_length + t.index_length), 0) AS bytes
  FROM information_schema.schemata s
  LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
  WHERE s.schema_name NOT IN ${SYSTEM}
  GROUP BY s.schema_name ORDER BY s.schema_name`;

const TABLES_SQL = `
  SELECT table_schema AS db, table_name AS name, COALESCE(table_rows, 0) AS row_count,
         COALESCE(data_length + index_length, 0) AS bytes
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ${SYSTEM}`;

const ROUTINES_SQL = [
  `SELECT routine_schema AS db, routine_name AS name, routine_type AS type,
          COALESCE(routine_definition, '') AS def, COALESCE(external_language, 'SQL') AS lang
   FROM information_schema.routines WHERE routine_schema NOT IN ${SYSTEM}`,
  `SELECT routine_schema AS db, routine_name AS name, routine_type AS type,
          COALESCE(routine_definition, '') AS def, 'SQL' AS lang
   FROM information_schema.routines WHERE routine_schema NOT IN ${SYSTEM}`,
];

// MySQL 8 has account_locked; MariaDB has is_role instead (roles are rows of mysql.user there).
const USERS_SQL = [
  `SELECT user AS u, host AS h, super_priv AS su, account_locked AS locked, 'N' AS is_role FROM mysql.user`,
  `SELECT user AS u, host AS h, super_priv AS su, 'N' AS locked, is_role FROM mysql.user`,
  `SELECT user AS u, host AS h, super_priv AS su, 'N' AS locked, 'N' AS is_role FROM mysql.user`,
];

// MySQL: role_edges. MariaDB: roles_mapping.
const ROLE_EDGES_SQL = [
  `SELECT from_user AS f, to_user AS t FROM mysql.role_edges`,
  `SELECT role AS f, user AS t FROM mysql.roles_mapping`,
];

const GRANTEES_SQL = `SELECT grantee AS g, MAX(privilege_type = 'SUPER') AS su FROM information_schema.user_privileges GROUP BY grantee`;

const TABLE_IO_SQL = `
  SELECT object_schema AS db, object_name AS name, count_read AS r, count_write AS w
  FROM performance_schema.table_io_waits_summary_by_table
  WHERE object_schema NOT IN ${SYSTEM}`;

const PROGRAM_STATS_SQL = `
  SELECT object_schema AS db, object_name AS name, object_type AS type, count_star AS calls,
         sum_timer_wait / 1000000000 AS ms
  FROM performance_schema.events_statements_summary_by_program
  WHERE object_type IN ('PROCEDURE', 'FUNCTION')`;

// MySQL 8: performance_schema.data_locks. MariaDB 10.x / MySQL 5.7: information_schema.INNODB_LOCKS.
const LOCKS_SQL = [
  `SELECT object_schema AS db, object_name AS name,
          SUM(lock_status = 'GRANTED') AS held, SUM(lock_status = 'WAITING') AS waiting
   FROM performance_schema.data_locks
   WHERE object_name IS NOT NULL GROUP BY object_schema, object_name`,
  `SELECT SUBSTRING_INDEX(REPLACE(l.lock_table, CHAR(96), ''), '.', 1) AS db,
          SUBSTRING_INDEX(REPLACE(l.lock_table, CHAR(96), ''), '.', -1) AS name,
          COUNT(*) AS held,
          SUM(l.lock_id IN (SELECT requested_lock_id FROM information_schema.INNODB_LOCK_WAITS)) AS waiting
   FROM information_schema.INNODB_LOCKS l GROUP BY l.lock_table`,
];

const INDEXES_SQL = `
  SELECT table_schema AS db, table_name AS tbl, index_name AS name, MIN(non_unique) AS non_unique,
         GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols, MAX(index_type) AS method
  FROM information_schema.statistics
  WHERE table_schema NOT IN ${SYSTEM}
  GROUP BY table_schema, table_name, index_name`;

const INDEX_SIZES_SQL = `
  SELECT database_name AS db, table_name AS tbl, index_name AS name, stat_value * @@innodb_page_size AS bytes
  FROM mysql.innodb_index_stats WHERE stat_name = 'size'`;

const INDEX_USAGE_SQL = `
  SELECT object_schema AS db, object_name AS tbl, index_name AS name, count_read AS scans
  FROM performance_schema.table_io_waits_summary_by_index_usage
  WHERE index_name IS NOT NULL AND object_schema NOT IN ${SYSTEM}`;

const FINGERPRINT_SQL = `
  SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ${SYSTEM}) AS t,
         (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema NOT IN ${SYSTEM}) AS i,
         (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema NOT IN ${SYSTEM}) AS r,
         (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name NOT IN ${SYSTEM}) AS d,
         (SELECT MAX(create_time) FROM information_schema.tables WHERE table_schema NOT IN ${SYSTEM}) AS c`;

const ACCOUNTS_FINGERPRINT_SQL = [
  `SELECT (SELECT COUNT(*) FROM mysql.user) AS u, (SELECT COUNT(*) FROM mysql.role_edges) AS e`,
  `SELECT (SELECT COUNT(*) FROM mysql.user) AS u, (SELECT COUNT(*) FROM mysql.roles_mapping) AS e`,
  `SELECT (SELECT COUNT(*) FROM mysql.user) AS u`,
];

const SESSIONS_SQL = `
  SELECT id, user AS usr, db, command, time, state, LEFT(info, 400) AS query
  FROM information_schema.processlist
  WHERE id <> CONNECTION_ID() AND user NOT IN ('system user', 'event_scheduler')`;

// Statement capture through the general log (only used when performance_schema is off and the user opted in).
const GENERAL_LOG_SQL = `
  SELECT CAST(event_time AS CHAR) AS ts, user_host AS uh, command_type AS cmd, argument AS arg
  FROM mysql.general_log
  WHERE event_time > CAST(? AS DATETIME(6)) AND thread_id <> CONNECTION_ID() AND command_type IN ('Query', 'Execute')
  ORDER BY event_time LIMIT 2000`;

const RECENT_MS = 3000;
const MAX_OWNED_LOG_ROWS = 20_000;
const SKIPPED_STATEMENT = /^\s*(set|show|use|begin|commit|rollback|start\s+transaction|explain|describe|desc|flush|kill)\b/i;
const LOG_OUTPUT_TOKEN = /^(FILE|TABLE|NONE)$/;

type Row = Record<string, unknown>;

interface Recent {
  at: number;
  tableId?: string;
  routineId?: string;
  query: string;
}

function routineId(db: string, type: string, name: string): string {
  return `${db}.${type.toLowerCase()}.${name}`;
}

const asText = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));

export class MySqlConnector implements DbConnector {
  // A single connection: every profiler query runs on it, so CONNECTION_ID() hides exactly us.
  private pool: mysql.Pool | null = null;
  private target: ConnectionTarget = { kind: 'mysql' };
  private tables = new TableIndex([]);
  private routines = new RoutineIndex([]);
  private routineInfo = new Map<string, RoutineInfo>();
  private visible = new Set<string>();
  private choice = new Map<string, number>();

  private isMaria = false;
  private hasPerfSchema = false;

  private capture = {
    on: false,
    /** True when this app switched the log on (so it must switch it off again). */
    owned: false,
    prior: null as { general: boolean; output: string } | null,
    lastTs: '',
    rowsSeen: 0,
    error: '',
  };
  /** Whether *we* switched the general log on (and so must restore it), regardless of truncation rights. */
  private logOwned = false;
  private logTables = new Map<string, TableStat>();
  private logRoutines = new Map<string, RoutineStat>();
  private recent = new Map<string, Recent>();

  private async run(key: string, sql: string | string[], params?: unknown[]): Promise<Row[]> {
    const variants = Array.isArray(sql) ? sql : [sql];
    let lastError: unknown;
    for (let i = this.choice.get(key) ?? 0; i < variants.length; i++) {
      try {
        const [rows] = await this.pool!.query(variants[i], params);
        this.choice.set(key, i);
        return rows as Row[];
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async tryRun(key: string, sql: string | string[], params?: unknown[]): Promise<Row[]> {
    try {
      return await this.run(key, sql, params);
    } catch {
      return [];
    }
  }

  async connect(target: ConnectionTarget): Promise<void> {
    this.target = target;
    this.pool = mysql.createPool({
      host: target.host ?? 'localhost',
      port: target.port ?? 3306,
      user: target.user,
      password: target.password,
      database: target.database || undefined,
      ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 1,
    });
    // MySQL 8 caches information_schema row counts and sizes for a day unless told otherwise.
    this.pool.pool.on('connection', (conn: { query: (sql: string, cb: () => void) => void }) => {
      conn.query('SET SESSION information_schema_stats_expiry = 0', () => {});
    });

    const [rows] = await this.pool.query('SELECT VERSION() AS v, @@performance_schema AS ps');
    const info = (rows as Row[])[0] ?? {};
    this.isMaria = /mariadb/i.test(String(info.v));
    this.hasPerfSchema = num(info.ps) === 1;

    // A general log left on (e.g. by a previous run that was killed) is simply reused.
    if (!this.hasPerfSchema) {
      const state = await this.tryRun('logstate', 'SELECT @@global.general_log AS g, @@global.log_output AS o');
      const output = String(state[0]?.o ?? '');
      if (num(state[0]?.g) === 1 && /TABLE/i.test(output)) await this.startReading(false, null);
    }
  }

  async disconnect(): Promise<void> {
    // Automatic cleanup only undoes what this app changed; it never touches a log the user had switched on.
    await this.stopCapture(false).catch(() => {});
    await this.pool?.end().catch(() => {});
    this.pool = null;
  }

  currentNotice(): Notice | null {
    if (this.hasPerfSchema) return null;
    const flavor = this.isMaria ? 'MariaDB' : 'MySQL';
    const off = `performance_schema is off on this ${flavor} server${this.isMaria ? ' (the MariaDB default)' : ''}`;
    if (this.capture.on) {
      return {
        level: 'info',
        message: `${off}. Capturing every statement through the general log${
          this.logOwned
            ? ' (switched on by this app, restored when you disconnect)'
            : ' (it was already on, maybe left over from a run that was stopped abruptly; "Stop capturing" switches it off)'
        }. Index usage is not available in this mode.`,
        action: 'disableCapture',
      };
    }
    return {
      level: 'warn',
      message: `${off}, so table activity cannot be read and only long-running queries show up. Enable query capture to see every statement (temporarily turns on the general log, needs the SUPER privilege), or set performance_schema=ON in the server config and restart it.${
        this.capture.error ? ` Last attempt failed: ${this.capture.error}` : ''
      }`,
      action: 'enableCapture',
    };
  }

  /** Starts reading the log from "now". `switchedOn`: this app turned the log on, so it must turn it off again. */
  private async startReading(switchedOn: boolean, prior: { general: boolean; output: string } | null): Promise<void> {
    const [row] = await this.run('now', 'SELECT CAST(NOW(6) AS CHAR) AS ts, (SELECT COUNT(*) FROM mysql.general_log) AS n');
    this.logOwned = switchedOn;
    // Only truncate (to keep the CSV table small) when we own the log and nothing else was in the table.
    this.capture = { on: true, owned: switchedOn && num(row?.n) === 0, prior, lastTs: String(row?.ts), rowsSeen: 0, error: '' };
  }

  async setCapture(on: boolean): Promise<{ ok: boolean; message: string }> {
    if (!this.pool || this.hasPerfSchema) return { ok: false, message: 'Capture is only needed when performance_schema is off' };

    if (on) {
      if (this.capture.on) return { ok: true, message: 'Already capturing' };
      try {
        const state = await this.run('logstate', 'SELECT @@global.general_log AS g, @@global.log_output AS o');
        const priorOutput = String(state[0]?.o ?? 'FILE');
        const tokens = priorOutput.split(',').map((t) => t.trim().toUpperCase()).filter((t) => LOG_OUTPUT_TOKEN.test(t));
        const prior = { general: num(state[0]?.g) === 1, output: tokens.length ? tokens.join(',') : 'FILE' };
        const wanted = new Set(tokens.filter((t) => t !== 'NONE'));
        wanted.add('TABLE');
        await this.pool.query(`SET GLOBAL log_output = '${[...wanted].join(',')}'`);
        await this.pool.query(`SET GLOBAL general_log = 'ON'`);
        // If it was already on, leave it on afterwards; otherwise restore the previous state.
        await this.startReading(true, prior);
        return { ok: true, message: 'Capturing every statement' };
      } catch (err) {
        this.capture.error = (err as Error).message;
        return { ok: false, message: this.capture.error };
      }
    }

    return this.stopCapture(true);
  }

  /**
   * `explicit`: the user clicked "Stop capturing", so a log we did not switch on is switched off too.
   * Otherwise (disconnecting) only our own changes are undone.
   */
  private async stopCapture(explicit: boolean): Promise<{ ok: boolean; message: string }> {
    if (!this.pool || !this.capture.on) return { ok: true, message: 'Not capturing' };
    const { prior } = this.capture;
    this.capture.on = false;
    try {
      if (this.logOwned && prior) {
        if (!prior.general) await this.pool.query(`SET GLOBAL general_log = 'OFF'`);
        await this.pool.query(`SET GLOBAL log_output = '${prior.output}'`);
      } else if (explicit) {
        await this.pool.query(`SET GLOBAL general_log = 'OFF'`);
      }
    } catch (err) {
      this.capture.error = (err as Error).message;
      return { ok: false, message: this.capture.error };
    }
    this.logOwned = false;
    this.logTables.clear();
    this.logRoutines.clear();
    this.recent.clear();
    return { ok: true, message: 'Capture off' };
  }

  async topology(): Promise<Topology> {
    const dbRows = (await this.run('databases', DATABASES_SQL)).slice(0, MAX_DATABASES);
    this.visible = new Set(dbRows.map((r) => String(r.name)));

    const tables: TableInfo[] = (await this.tryRun('tables', TABLES_SQL))
      .filter((r) => this.visible.has(String(r.db)))
      .map((r) => ({
        id: tableId(String(r.db), '', String(r.name)),
        database: String(r.db),
        schema: '',
        name: String(r.name),
        kind: 'table',
        rowCount: num(r.row_count),
        sizeBytes: num(r.bytes),
      }));
    this.tables = new TableIndex(tables);
    const known = new Set(tables.map((t) => t.id));

    const sizes = new Map(
      (await this.tryRun('indexSizes', INDEX_SIZES_SQL)).map((r) => [
        indexId(tableId(String(r.db), '', String(r.tbl)), String(r.name)),
        num(r.bytes),
      ]),
    );
    const indexes: IndexInfo[] = (await this.tryRun('indexes', INDEXES_SQL))
      .map((r): IndexInfo => {
        const tid = tableId(String(r.db), '', String(r.tbl));
        const name = String(r.name);
        const id = indexId(tid, name);
        return {
          id,
          tableId: tid,
          name,
          columns: String(r.cols ?? '').split(',').filter(Boolean),
          unique: num(r.non_unique) === 0,
          primary: name === 'PRIMARY',
          method: String(r.method ?? 'BTREE'),
          sizeBytes: sizes.get(id) ?? 0,
        };
      })
      .filter((i) => known.has(i.tableId));

    const routines: RoutineInfo[] = (await this.tryRun('routines', ROUTINES_SQL))
      .filter((r) => this.visible.has(String(r.db)))
      .map((r) => ({
        id: routineId(String(r.db), String(r.type), String(r.name)),
        database: String(r.db),
        schema: '',
        name: String(r.name),
        kind: String(r.type).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
        language: String(r.lang),
        touches: this.tables.findAll(String(r.def), String(r.db)),
      }));
    this.routines = new RoutineIndex(routines);
    this.routineInfo = new Map(routines.map((r) => [r.id, r]));

    const { users, roleNames } = await this.principals();

    return {
      engine: 'mysql',
      server: `${this.target.host ?? 'localhost'}:${this.target.port ?? 3306}${this.isMaria ? ' (MariaDB)' : ''}`,
      databases: dbRows.map((r) => ({ name: String(r.name), sizeBytes: num(r.bytes) })),
      tables,
      indexes,
      routines,
      roles: rolesFromMembership(users, roleNames),
      users,
    };
  }

  private async principals(): Promise<{ users: UserInfo[]; roleNames: string[] }> {
    const accounts = await this.tryRun('users', USERS_SQL);
    if (accounts.length === 0) {
      // No access to mysql.user: fall back to grantees visible in information_schema.
      const grantees = await this.tryRun('grantees', GRANTEES_SQL);
      const users = grantees.map((g) => ({
        name: String(g.g).replace(/^'([^']*)'.*$/, '$1'),
        roles: [],
        superuser: num(g.su) > 0,
      }));
      return { users: dedupeUsers(users), roleNames: [] };
    }

    const edges = await this.tryRun('roleEdges', ROLE_EDGES_SQL);
    const roleNames = [
      ...new Set([...edges.map((e) => String(e.f)), ...accounts.filter((a) => a.is_role === 'Y').map((a) => String(a.u))]),
    ];
    const users = accounts
      .map((a) => String(a.u))
      .filter((u) => u && !u.startsWith('mysql.') && !u.startsWith('mariadb.') && !roleNames.includes(u))
      .map((u) => {
        const acc = accounts.filter((a) => a.u === u);
        return {
          name: u,
          roles: [...new Set(edges.filter((e) => e.t === u).map((e) => String(e.f)))],
          superuser: acc.some((a) => a.su === 'Y'),
        };
      });
    return { users: dedupeUsers(users), roleNames };
  }

  /** Books the statements the general log has seen since the last poll against cumulative counters. */
  private async readLog(): Promise<void> {
    const rows = await this.run('generalLog', GENERAL_LOG_SQL, [this.capture.lastTs]);
    const now = Date.now();
    for (const r of rows) {
      this.capture.lastTs = String(r.ts);
      this.capture.rowsSeen++;
      const sql = asText(r.arg);
      if (!sql || SKIPPED_STATEMENT.test(sql)) continue;

      const user = (asText(r.uh).match(/^\s*([^[\s@]*)/)?.[1] ?? '') || 'anonymous';
      const calledId = this.routines.find(sql);
      const called = calledId ? this.routineInfo.get(calledId) : undefined;
      const direct = this.tables.findAll(sql);

      if (called) {
        const s = this.logRoutines.get(called.id) ?? { id: called.id, calls: 0, totalMs: 0 };
        s.calls += 1;
        this.logRoutines.set(called.id, s);
        for (const t of called.touches) this.bumpTable(t, called.kind === 'procedure' ? 'write' : 'read');
      }
      const op = classify(sql);
      if (!called) for (const t of direct) this.bumpTable(t, op);

      const first = called?.touches[0] ?? direct[0];
      if (first || called) {
        this.recent.set(user, { at: now, tableId: first, routineId: called?.id, query: sql.replace(/\s+/g, ' ').slice(0, 300) });
      }
    }

    if (this.capture.owned && this.capture.rowsSeen > MAX_OWNED_LOG_ROWS) {
      await this.pool!.query('TRUNCATE TABLE mysql.general_log').catch(() => {});
      this.capture.rowsSeen = 0;
    }
    for (const [user, r] of this.recent) if (now - r.at > 60_000) this.recent.delete(user);
  }

  private bumpTable(id: string, op: 'read' | 'write'): void {
    const s = this.logTables.get(id) ?? { id, reads: 0, writes: 0, locks: 0, waiting: 0 };
    if (op === 'read') s.reads += 1;
    else s.writes += 1;
    this.logTables.set(id, s);
  }

  async sample(): Promise<Sample> {
    const processes = await this.tryRun('sessions', SESSIONS_SQL);
    const locks = await this.tryRun('locks', LOCKS_SQL);
    const schema = await this.tryRun('fingerprint', FINGERPRINT_SQL);
    const accounts = await this.tryRun('accountsFingerprint', ACCOUNTS_FINGERPRINT_SQL);

    const lockMap = new Map(locks.map((l) => [tableId(String(l.db), '', String(l.name)), l]));
    let tables: TableStat[] = [];
    let routines: RoutineStat[] = [];
    let indexes: IndexStat[] = [];

    if (this.hasPerfSchema) {
      const io = await this.tryRun('tableIo', TABLE_IO_SQL);
      const programs = await this.tryRun('programs', PROGRAM_STATS_SQL);
      const usage = await this.tryRun('indexUsage', INDEX_USAGE_SQL);
      tables = io
        .filter((r) => this.visible.has(String(r.db)))
        .map((r) => {
          const id = tableId(String(r.db), '', String(r.name));
          const lock = lockMap.get(id);
          return { id, reads: num(r.r), writes: num(r.w), locks: num(lock?.held), waiting: num(lock?.waiting) };
        });
      routines = programs.map((p) => ({
        id: routineId(String(p.db), String(p.type), String(p.name)),
        calls: num(p.calls),
        totalMs: num(p.ms),
      }));
      indexes = usage
        .filter((u) => this.visible.has(String(u.db)))
        .map((u) => ({ id: indexId(tableId(String(u.db), '', String(u.tbl)), String(u.name)), scans: num(u.scans) }));
    } else if (this.capture.on) {
      await this.readLog().catch((err) => {
        this.capture.error = (err as Error).message;
      });
      const seen = new Set<string>();
      tables = [...this.logTables.values()].map((t) => {
        seen.add(t.id);
        const lock = lockMap.get(t.id);
        return { ...t, locks: num(lock?.held), waiting: num(lock?.waiting) };
      });
      for (const [id, lock] of lockMap) {
        if (seen.has(id) || !this.visible.has(id.split('.')[0])) continue;
        tables.push({ id, reads: 0, writes: 0, locks: num(lock.held), waiting: num(lock.waiting) });
      }
      routines = [...this.logRoutines.values()].map((r) => ({ ...r }));
    }

    const now = Date.now();
    const sessions: SessionInfo[] = [];
    const active = new Set<string>();
    for (const [user, r] of this.recent) {
      if (now - r.at > RECENT_MS) continue;
      active.add(user);
      sessions.push({
        id: `log-${user}`,
        user,
        database: r.tableId?.split('.')[0] ?? '',
        state: 'active',
        tableId: r.tableId,
        routineId: r.routineId,
        query: r.query,
        durationMs: now - r.at,
      });
    }
    for (const p of processes) {
      const user = String(p.usr);
      const db = String(p.db ?? '');
      const command = String(p.command ?? '');
      const running = command === 'Query' || command === 'Execute';
      if (!running && active.has(user)) continue;
      const query = running ? String(p.query ?? '') : undefined;
      sessions.push({
        id: String(p.id),
        user,
        database: db,
        state: !running ? 'idle' : /lock/i.test(String(p.state ?? '')) ? 'waiting' : 'active',
        tableId: this.tables.find(query, db),
        routineId: this.routines.find(query, db),
        query: query?.slice(0, 300),
        durationMs: num(p.time) * 1000,
      });
    }

    const fingerprint = [schema[0], accounts[0]].map((r) => (r ? Object.values(r).join('/') : '')).join('|');
    return { tables, routines, indexes, sessions, fingerprint };
  }
}

function dedupeUsers(users: UserInfo[]): UserInfo[] {
  const map = new Map<string, UserInfo>();
  for (const u of users) {
    const existing = map.get(u.name);
    if (existing) {
      existing.superuser ||= u.superuser;
      existing.roles = [...new Set([...existing.roles, ...u.roles])];
    } else {
      map.set(u.name, { ...u });
    }
  }
  return [...map.values()];
}
