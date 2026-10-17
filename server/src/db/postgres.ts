import pg from 'pg';
import type { ConnectionTarget, IndexInfo, RoutineInfo, SessionInfo, TableInfo, Topology } from '../../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, Sample, TableStat } from './types';
import {
  MAX_DATABASES,
  PROFILER_APP,
  RoutineIndex,
  TableIndex,
  indexId,
  num,
  pgIndexInfos,
  principalsFromPg,
  tableId,
  type PgIndexRow,
  type PgRoleRow,
} from './util';

const DATABASES_SQL = `
  SELECT datname AS name,
         CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname)::float8 ELSE 0 END AS bytes
  FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`;

const TABLES_SQL = `
  SELECT schemaname AS schema, relname AS name, COALESCE(n_live_tup, 0)::float8 AS rows,
         pg_total_relation_size(relid)::float8 AS bytes
  FROM pg_stat_user_tables`;

const ROUTINES_SQL = [
  `SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, p.prokind::text AS kind, l.lanname AS lang,
          CASE WHEN l.lanname IN ('sql', 'plpgsql') THEN p.prosrc ELSE '' END AS src
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
  // PostgreSQL < 11 has no prokind / procedures.
  `SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, 'f' AS kind, l.lanname AS lang,
          CASE WHEN l.lanname IN ('sql', 'plpgsql') THEN p.prosrc ELSE '' END AS src
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND NOT p.proisagg`,
];

export const PG_ROLES_SQL = `
  SELECT r.rolname::text AS name, r.rolsuper AS superuser, r.rolcanlogin AS login,
         COALESCE((SELECT array_agg(g.rolname::text ORDER BY g.rolname)
                   FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                   WHERE m.member = r.oid), ARRAY[]::text[]) AS member_of
  FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname`;

export const PG_INDEXES_SQL = `
  SELECT n.nspname AS schema, t.relname AS tbl, i.relname AS name, am.amname AS method,
         ix.indisunique AS uniq, ix.indisprimary AS prim, pg_relation_size(i.oid)::float8 AS bytes,
         COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                   WHERE k.attnum > 0), ARRAY[]::text[]) AS cols
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE t.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

const INDEX_STATS_SQL = `
  SELECT schemaname AS schema, relname AS tbl, indexrelname AS name, COALESCE(idx_scan, 0)::float8 AS scans
  FROM pg_stat_user_indexes`;

/** Digest of what exists (counts + oid sums), so DDL is noticed within one poll. */
export const PG_FINGERPRINT_SQL = `
  SELECT (SELECT count(*)::text || '/' || COALESCE(sum(c.oid::bigint), 0)::text
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'i', 'I') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%') AS rel,
         (SELECT count(*)::text || '/' || COALESCE(sum(p.oid::bigint), 0)::text
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%') AS prc,
         (SELECT count(*)::text || '/' || COALESCE(sum(oid::bigint), 0)::text FROM pg_roles) AS rol,
         (SELECT count(*)::text FROM pg_auth_members) AS mem,
         (SELECT count(*)::text FROM pg_database WHERE NOT datistemplate) AS dbs`;

const TABLE_STATS_SQL = `
  SELECT schemaname AS schema, relname AS name,
         (COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0))::float8 AS reads,
         (COALESCE(n_tup_ins, 0) + COALESCE(n_tup_upd, 0) + COALESCE(n_tup_del, 0))::float8 AS writes
  FROM pg_stat_user_tables`;

const LOCKS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name,
         count(*) FILTER (WHERE l.granted)::float8 AS held,
         count(*) FILTER (WHERE NOT l.granted)::float8 AS waiting
  FROM pg_locks l
  JOIN pg_class c ON c.oid = l.relation
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  GROUP BY 1, 2`;

const FUNCTION_STATS_SQL = `SELECT funcid::text AS oid, calls::float8 AS calls, total_time::float8 AS ms FROM pg_stat_user_functions`;

const SESSIONS_SQL = [
  `SELECT pid::text AS id, usename AS usr, datname AS db, state, wait_event_type AS wait, left(query, 400) AS query,
          COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::float8 AS ms
   FROM pg_stat_activity
   WHERE usename IS NOT NULL AND pid <> pg_backend_pid()
     AND COALESCE(application_name, '') <> '${PROFILER_APP}' AND backend_type = 'client backend'`,
  `SELECT pid::text AS id, usename AS usr, datname AS db, state, NULL AS wait, left(query, 400) AS query,
          COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::float8 AS ms
   FROM pg_stat_activity
   WHERE usename IS NOT NULL AND pid <> pg_backend_pid() AND COALESCE(application_name, '') <> '${PROFILER_APP}'`,
];

interface Row {
  [key: string]: unknown;
}

export class PostgresConnector implements DbConnector {
  private target: ConnectionTarget = { kind: 'postgres' };
  private mainDb = 'postgres';
  private pools = new Map<string, pg.Pool>();
  private databases: string[] = [];
  private tables = new TableIndex([]);
  private routines = new RoutineIndex([]);
  private sqlChoice = new Map<string, number>();

  private pool(database: string): pg.Pool {
    let pool = this.pools.get(database);
    if (!pool) {
      pool = new pg.Pool({
        host: this.target.host ?? 'localhost',
        port: this.target.port ?? 5432,
        user: this.target.user,
        password: this.target.password,
        database,
        ssl: this.target.ssl ? { rejectUnauthorized: false } : undefined,
        max: 2,
        application_name: PROFILER_APP,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on('error', () => {});
      this.pools.set(database, pool);
    }
    return pool;
  }

  /** Runs the first SQL variant the server accepts and remembers it for next time. */
  private async query(database: string, key: string, variants: string | string[]): Promise<Row[]> {
    const sqls = Array.isArray(variants) ? variants : [variants];
    const cacheKey = `${database}|${key}`;
    let lastError: unknown;
    for (let i = this.sqlChoice.get(cacheKey) ?? 0; i < sqls.length; i++) {
      try {
        const res = await this.pool(database).query(sqls[i]);
        this.sqlChoice.set(cacheKey, i);
        return res.rows as Row[];
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async tryQuery(database: string, key: string, variants: string | string[]): Promise<Row[]> {
    try {
      return await this.query(database, key, variants);
    } catch {
      return [];
    }
  }

  async connect(target: ConnectionTarget): Promise<void> {
    this.target = target;
    this.mainDb = target.database || 'postgres';
    await this.pool(this.mainDb).query('SELECT 1');
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => {})));
    this.pools.clear();
  }

  async topology(): Promise<Topology> {
    const dbRows = await this.query(this.mainDb, 'databases', DATABASES_SQL);
    const all = dbRows.map((r) => String(r.name));
    this.databases = [this.mainDb, ...all.filter((n) => n !== this.mainDb)]
      .filter((n) => all.includes(n))
      .slice(0, MAX_DATABASES);

    for (const [name, pool] of this.pools) {
      if (name !== this.mainDb && !this.databases.includes(name)) {
        pool.end().catch(() => {});
        this.pools.delete(name);
      }
    }

    const tables: TableInfo[] = [];
    const indexes: IndexInfo[] = [];
    const routineRows: Array<{ db: string; row: Row }> = [];
    await Promise.all(
      this.databases.map(async (db) => {
        const [tableRows, rows, indexRows] = await Promise.all([
          this.tryQuery(db, 'tables', TABLES_SQL),
          this.tryQuery(db, 'routines', ROUTINES_SQL),
          this.tryQuery(db, 'indexes', PG_INDEXES_SQL),
        ]);
        const dbTables = new Set<string>();
        for (const r of tableRows) {
          const id = tableId(db, String(r.schema), String(r.name));
          dbTables.add(id);
          tables.push({
            id,
            database: db,
            schema: String(r.schema),
            name: String(r.name),
            kind: 'table',
            rowCount: num(r.rows),
            sizeBytes: num(r.bytes),
          });
        }
        indexes.push(...pgIndexInfos(db, indexRows as unknown as PgIndexRow[], dbTables));
        for (const row of rows) routineRows.push({ db, row });
      }),
    );
    this.tables = new TableIndex(tables);

    const routines: RoutineInfo[] = routineRows.map(({ db, row }) => ({
      id: `${db}:${row.oid}`,
      database: db,
      schema: String(row.schema),
      name: String(row.name),
      kind: row.kind === 'p' ? 'procedure' : 'function',
      language: String(row.lang),
      touches: this.tables.findAll(String(row.src ?? ''), db),
    }));
    this.routines = new RoutineIndex(routines);

    const { roles, users } = principalsFromPg(
      (await this.tryQuery(this.mainDb, 'roles', PG_ROLES_SQL)) as unknown as PgRoleRow[],
    );

    return {
      engine: 'postgres',
      server: `${this.target.host ?? 'localhost'}:${this.target.port ?? 5432}`,
      databases: dbRows
        .filter((r) => this.databases.includes(String(r.name)))
        .map((r) => ({ name: String(r.name), sizeBytes: num(r.bytes) })),
      tables,
      indexes,
      routines,
      roles,
      users,
    };
  }

  async sample(): Promise<Sample> {
    const tables: TableStat[] = [];
    const routines: RoutineStat[] = [];
    const indexes: IndexStat[] = [];
    const prints = new Map<string, string>();

    await Promise.all(
      this.databases.map(async (db) => {
        const [stats, locks, funcs, idx, fp] = await Promise.all([
          this.tryQuery(db, 'tableStats', TABLE_STATS_SQL),
          this.tryQuery(db, 'locks', LOCKS_SQL),
          this.tryQuery(db, 'functionStats', FUNCTION_STATS_SQL),
          this.tryQuery(db, 'indexStats', INDEX_STATS_SQL),
          this.tryQuery(db, 'fingerprint', PG_FINGERPRINT_SQL),
        ]);
        const lockMap = new Map(locks.map((l) => [tableId(db, String(l.schema), String(l.name)), l]));
        for (const s of stats) {
          const id = tableId(db, String(s.schema), String(s.name));
          const lock = lockMap.get(id);
          tables.push({ id, reads: num(s.reads), writes: num(s.writes), locks: num(lock?.held), waiting: num(lock?.waiting) });
        }
        for (const f of funcs) routines.push({ id: `${db}:${f.oid}`, calls: num(f.calls), totalMs: num(f.ms) });
        for (const i of idx) {
          indexes.push({ id: indexId(tableId(db, String(i.schema), String(i.tbl)), String(i.name)), scans: num(i.scans) });
        }
        prints.set(db, fp[0] ? Object.values(fp[0]).join('|') : '');
      }),
    );
    const fingerprint = this.databases.map((d) => `${d}=${prints.get(d) ?? ''}`).join(';');

    const sessionRows = await this.tryQuery(this.mainDb, 'sessions', SESSIONS_SQL);
    const sessions: SessionInfo[] = sessionRows.map((r) => {
      const db = String(r.db ?? '');
      const active = r.state === 'active';
      const query = active ? String(r.query ?? '') : undefined;
      return {
        id: String(r.id),
        user: String(r.usr),
        database: db,
        state: !active ? 'idle' : r.wait === 'Lock' ? 'waiting' : 'active',
        tableId: this.tables.find(query, db),
        routineId: this.routines.find(query, db),
        query: query?.slice(0, 300),
        durationMs: num(r.ms),
      };
    });

    return { tables, routines, indexes, sessions, fingerprint };
  }
}
