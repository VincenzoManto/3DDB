import mssql from 'mssql';
import type { ConnectionTarget, IndexInfo, RoutineInfo, SessionInfo, TableInfo, Topology, UserInfo } from '../../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, Sample, TableStat } from './types';
import { MAX_DATABASES, PROFILER_APP, RoutineIndex, TableIndex, indexId, num, rolesFromMembership, tableId } from './util';

const DATABASES_SQL = [
  `SELECT d.name, SUM(CAST(mf.size AS bigint)) * 8192 AS bytes
   FROM sys.databases d JOIN sys.master_files mf ON mf.database_id = d.database_id
   WHERE d.database_id > 4 AND d.state = 0
   GROUP BY d.name ORDER BY d.name`,
  `SELECT name, 0 AS bytes FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name`,
];

const quoteDb = (db: string) => `[${db.replace(/]/g, ']]')}]`;

const tablesSql = (q: string) => `
  SELECT s.name AS sch, t.name AS name,
    (SELECT SUM(p.rows) FROM ${q}.sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS row_count,
    (SELECT SUM(a.total_pages) * 8192 FROM ${q}.sys.partitions p
       JOIN ${q}.sys.allocation_units a ON a.container_id = p.partition_id WHERE p.object_id = t.object_id) AS bytes
  FROM ${q}.sys.tables t JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
  WHERE t.is_ms_shipped = 0`;

const routinesSql = (q: string) => `
  SELECT s.name AS sch, o.name AS name, o.type AS type, o.object_id AS oid, COALESCE(m.definition, '') AS def
  FROM ${q}.sys.objects o
  JOIN ${q}.sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN ${q}.sys.sql_modules m ON m.object_id = o.object_id
  WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT') AND o.is_ms_shipped = 0`;

const indexesSql = (q: string) => `
  SELECT s.name AS sch, t.name AS tbl, i.name AS name, i.index_id AS iid, i.is_unique AS uq, i.is_primary_key AS pk,
         i.type_desc AS method,
         (SELECT SUM(ps.used_page_count) * 8192 FROM ${q}.sys.dm_db_partition_stats ps
            WHERE ps.object_id = i.object_id AND ps.index_id = i.index_id) AS bytes,
         STUFF((SELECT ',' + c.name FROM ${q}.sys.index_columns ic
                  JOIN ${q}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                  WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                  ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '') AS cols
  FROM ${q}.sys.indexes i
  JOIN ${q}.sys.tables t ON t.object_id = i.object_id
  JOIN ${q}.sys.schemas s ON s.schema_id = t.schema_id
  WHERE i.type > 0 AND i.name IS NOT NULL AND t.is_ms_shipped = 0`;

const fingerprintSql = (q: string) => `
  SELECT (SELECT CAST(COUNT(*) AS varchar(20)) + '/' + CAST(COALESCE(MAX(CAST(modify_date AS float)), 0) AS varchar(40))
            FROM ${q}.sys.objects WHERE is_ms_shipped = 0) AS o,
         (SELECT CAST(COUNT(*) AS varchar(20)) FROM ${q}.sys.indexes WHERE object_id > 100) AS i`;

const ACCOUNTS_FINGERPRINT_SQL = `
  SELECT (SELECT COUNT(*) FROM sys.databases) AS d, (SELECT COUNT(*) FROM sys.server_principals) AS p,
         (SELECT COUNT(*) FROM sys.server_role_members) AS m`;

const PRINCIPALS_SQL = `
  SELECT principal_id AS pid, name, type FROM sys.server_principals
  WHERE type IN ('S', 'U', 'G', 'E', 'X', 'R') AND name NOT LIKE '##%' AND name NOT LIKE 'NT %' AND name <> 'public'`;

const ROLE_MEMBERS_SQL = `SELECT role_principal_id AS r, member_principal_id AS m FROM sys.server_role_members`;

const INDEX_USAGE_SQL = `
  SELECT DB_NAME(u.database_id) AS db, OBJECT_SCHEMA_NAME(u.object_id, u.database_id) AS sch,
         OBJECT_NAME(u.object_id, u.database_id) AS name,
         SUM(u.user_seeks + u.user_scans + u.user_lookups) AS reads, SUM(u.user_updates) AS writes
  FROM sys.dm_db_index_usage_stats u WHERE u.database_id > 4
  GROUP BY u.database_id, u.object_id`;

const INDEX_SCANS_SQL = `
  SELECT DB_NAME(u.database_id) AS db, OBJECT_SCHEMA_NAME(u.object_id, u.database_id) AS sch,
         OBJECT_NAME(u.object_id, u.database_id) AS tbl, u.index_id AS iid,
         u.user_seeks + u.user_scans + u.user_lookups AS scans
  FROM sys.dm_db_index_usage_stats u WHERE u.database_id > 4 AND u.index_id > 0`;

const PROC_STATS_SQL = `
  SELECT DB_NAME(database_id) AS db, object_id AS oid, SUM(execution_count) AS calls, SUM(total_elapsed_time) / 1000.0 AS ms
  FROM sys.dm_exec_procedure_stats WHERE database_id > 4 GROUP BY database_id, object_id`;

const FUNC_STATS_SQL = `
  SELECT DB_NAME(database_id) AS db, object_id AS oid, SUM(execution_count) AS calls, SUM(total_elapsed_time) / 1000.0 AS ms
  FROM sys.dm_exec_function_stats WHERE database_id > 4 GROUP BY database_id, object_id`;

const LOCKS_SQL = `
  SELECT DB_NAME(l.resource_database_id) AS db,
         OBJECT_SCHEMA_NAME(l.resource_associated_entity_id, l.resource_database_id) AS sch,
         OBJECT_NAME(l.resource_associated_entity_id, l.resource_database_id) AS name,
         SUM(CASE WHEN l.request_status = 'GRANT' THEN 1 ELSE 0 END) AS held,
         SUM(CASE WHEN l.request_status = 'WAIT' THEN 1 ELSE 0 END) AS waiting
  FROM sys.dm_tran_locks l
  WHERE l.resource_type = 'OBJECT' AND l.resource_database_id > 4
  GROUP BY l.resource_database_id, l.resource_associated_entity_id`;

const SESSIONS_SQL = `
  SELECT s.session_id AS id, s.login_name AS usr, DB_NAME(COALESCE(r.database_id, s.database_id)) AS db,
         s.status AS status, r.status AS rstatus, r.wait_type AS wait, COALESCE(r.total_elapsed_time, 0) AS ms,
         LEFT(t.text, 400) AS query, t.objectid AS oid, DB_NAME(t.dbid) AS objdb
  FROM sys.dm_exec_sessions s
  LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
  OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
  WHERE s.is_user_process = 1 AND s.session_id <> @@SPID AND COALESCE(s.program_name, '') <> '${PROFILER_APP}'`;

type Row = Record<string, unknown>;

export class MsSqlConnector implements DbConnector {
  private pool: mssql.ConnectionPool | null = null;
  private target: ConnectionTarget = { kind: 'mssql' };
  private databases: string[] = [];
  private tables = new TableIndex([]);
  private routines = new RoutineIndex([]);
  private routineIds = new Set<string>();

  private async query(sql: string | string[]): Promise<Row[]> {
    const variants = Array.isArray(sql) ? sql : [sql];
    let lastError: unknown;
    for (const v of variants) {
      try {
        return (await this.pool!.request().query(v)).recordset as Row[];
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async tryQuery(sql: string | string[]): Promise<Row[]> {
    try {
      return await this.query(sql);
    } catch {
      return [];
    }
  }

  async connect(target: ConnectionTarget): Promise<void> {
    this.target = target;
    this.pool = await new mssql.ConnectionPool({
      server: target.host ?? 'localhost',
      port: target.port ?? 1433,
      user: target.user,
      password: target.password,
      database: target.database || 'master',
      options: { trustServerCertificate: true, encrypt: Boolean(target.ssl), appName: PROFILER_APP },
      pool: { max: 3 },
    }).connect();
  }

  async disconnect(): Promise<void> {
    await this.pool?.close().catch(() => {});
    this.pool = null;
  }

  async topology(): Promise<Topology> {
    let dbRows = await this.query(DATABASES_SQL);
    const current = this.target.database;
    if (current && current !== 'master' && !dbRows.some((r) => r.name === current)) {
      dbRows = [{ name: current, bytes: 0 }, ...dbRows];
    }
    dbRows = dbRows.slice(0, MAX_DATABASES);
    this.databases = dbRows.map((r) => String(r.name));

    const tables: TableInfo[] = [];
    const indexes: IndexInfo[] = [];
    const routineRows: Array<{ db: string; row: Row }> = [];
    for (const db of this.databases) {
      const q = quoteDb(db);
      for (const r of await this.tryQuery(tablesSql(q))) {
        tables.push({
          id: tableId(db, String(r.sch), String(r.name)),
          database: db,
          schema: String(r.sch),
          name: String(r.name),
          kind: 'table',
          rowCount: num(r.row_count),
          sizeBytes: num(r.bytes),
        });
      }
      for (const r of await this.tryQuery(indexesSql(q))) {
        const tid = tableId(db, String(r.sch), String(r.tbl));
        indexes.push({
          // Keyed by index_id so the usage DMV (which has no index name) lines up.
          id: indexId(tid, String(r.iid)),
          tableId: tid,
          name: String(r.name),
          columns: String(r.cols ?? '').split(',').filter(Boolean),
          unique: Boolean(r.uq),
          primary: Boolean(r.pk),
          method: String(r.method ?? ''),
          sizeBytes: num(r.bytes),
        });
      }
      for (const row of await this.tryQuery(routinesSql(q))) routineRows.push({ db, row });
    }
    this.tables = new TableIndex(tables);

    const routines: RoutineInfo[] = routineRows.map(({ db, row }) => {
      const type = String(row.type).trim();
      return {
        id: `${db}:${row.oid}`,
        database: db,
        schema: String(row.sch),
        name: String(row.name),
        kind: type === 'P' || type === 'PC' ? 'procedure' : 'function',
        language: ['PC', 'FS', 'FT'].includes(type) ? 'CLR' : 'T-SQL',
        touches: this.tables.findAll(String(row.def), db),
      };
    });
    this.routines = new RoutineIndex(routines);
    this.routineIds = new Set(routines.map((r) => r.id));

    const principals = await this.tryQuery(PRINCIPALS_SQL);
    const members = await this.tryQuery(ROLE_MEMBERS_SQL);
    const nameOf = new Map(principals.map((p) => [num(p.pid), String(p.name)]));
    const roleNames = principals.filter((p) => String(p.type).trim() === 'R').map((p) => String(p.name));
    const users: UserInfo[] = principals
      .filter((p) => String(p.type).trim() !== 'R')
      .map((p) => {
        const roles = members
          .filter((m) => num(m.m) === num(p.pid))
          .map((m) => nameOf.get(num(m.r)))
          .filter((n): n is string => Boolean(n));
        return { name: String(p.name), roles, superuser: roles.includes('sysadmin') };
      });

    return {
      engine: 'mssql',
      server: `${this.target.host ?? 'localhost'}:${this.target.port ?? 1433}`,
      databases: dbRows.map((r) => ({ name: String(r.name), sizeBytes: num(r.bytes) })),
      tables,
      indexes,
      routines,
      roles: rolesFromMembership(users, roleNames).filter((r) => r.members.length > 0),
      users,
    };
  }

  async sample(): Promise<Sample> {
    const [usage, locks, procs, funcs, rows, scans, accounts] = await Promise.all([
      this.tryQuery(INDEX_USAGE_SQL),
      this.tryQuery(LOCKS_SQL),
      this.tryQuery(PROC_STATS_SQL),
      this.tryQuery(FUNC_STATS_SQL),
      this.tryQuery(SESSIONS_SQL),
      this.tryQuery(INDEX_SCANS_SQL),
      this.tryQuery(ACCOUNTS_FINGERPRINT_SQL),
    ]);
    const prints = await Promise.all(this.databases.map((db) => this.tryQuery(fingerprintSql(quoteDb(db)))));
    const fingerprint = [accounts[0], ...prints.map((p) => p[0])].map((r) => (r ? Object.values(r).join('/') : '')).join('|');
    const visibleDbs = new Set(this.databases);
    const indexes: IndexStat[] = scans
      .filter((s) => visibleDbs.has(String(s.db)) && s.tbl)
      .map((s) => ({ id: indexId(tableId(String(s.db), String(s.sch), String(s.tbl)), String(s.iid)), scans: num(s.scans) }));

    const visible = new Set(this.databases);
    const lockMap = new Map(locks.map((l) => [tableId(String(l.db), String(l.sch), String(l.name)), l]));
    const tables: TableStat[] = usage
      .filter((u) => visible.has(String(u.db)) && u.name)
      .map((u) => {
        const id = tableId(String(u.db), String(u.sch), String(u.name));
        const lock = lockMap.get(id);
        return { id, reads: num(u.reads), writes: num(u.writes), locks: num(lock?.held), waiting: num(lock?.waiting) };
      });

    const routines: RoutineStat[] = [...procs, ...funcs].map((p) => ({
      id: `${p.db}:${p.oid}`,
      calls: num(p.calls),
      totalMs: num(p.ms),
    }));

    const sessions: SessionInfo[] = rows.map((r) => {
      const db = String(r.db ?? '');
      const running = r.rstatus != null && r.rstatus !== 'background' && r.rstatus !== 'sleeping';
      const query = running ? String(r.query ?? '') : undefined;
      const objectRoutine = r.oid != null ? `${r.objdb}:${r.oid}` : undefined;
      return {
        id: String(r.id),
        user: String(r.usr),
        database: db,
        state: !running ? 'idle' : String(r.wait ?? '').startsWith('LCK_') ? 'waiting' : 'active',
        tableId: this.tables.find(query, db),
        routineId: objectRoutine && this.routineIds.has(objectRoutine) ? objectRoutine : this.routines.find(query, db),
        query: query?.slice(0, 300),
        durationMs: num(r.ms),
      };
    });

    return { tables, routines, indexes, sessions, fingerprint };
  }
}
