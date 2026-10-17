import { PGlite } from '@electric-sql/pglite';
import type { ExecResult, IndexInfo, RoutineInfo, SessionInfo, TableInfo, Topology, UserInfo } from '../../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, Sample, TableStat } from './types';
import { PG_FINGERPRINT_SQL, PG_INDEXES_SQL, PG_ROLES_SQL } from './postgres';
import {
  RoutineIndex,
  TableIndex,
  classify,
  num,
  pgIndexInfos,
  principalsFromPg,
  tableId,
  type PgIndexRow,
  type PgRoleRow,
} from './util';

/** Seed layout: each schema plays the part of a separate database in the visualization. */
const SCHEMAS: Record<string, Array<[string, number]>> = {
  shop: [
    ['customers', 4000],
    ['products', 800],
    ['orders', 12000],
    ['order_items', 30000],
    ['inventory', 800],
    ['payments', 11000],
    ['shipments', 9000],
    ['coupons', 50],
  ],
  analytics: [
    ['events', 60000],
    ['pageviews', 40000],
    ['web_sessions', 8000],
    ['funnels', 30],
    ['reports', 120],
    ['ab_tests', 12],
  ],
  auth: [
    ['accounts', 4000],
    ['api_tokens', 6000],
    ['audit_log', 25000],
    ['permissions', 40],
  ],
};

const INDEXES_DDL = `
CREATE INDEX idx_orders_customer ON shop.orders (ref);
CREATE INDEX idx_order_items_order ON shop.order_items (ref);
CREATE INDEX idx_payments_order ON shop.payments (ref);
CREATE INDEX idx_shipments_order ON shop.shipments (ref);
CREATE UNIQUE INDEX uq_coupons_code ON shop.coupons (payload);
CREATE INDEX idx_events_ref ON analytics.events (ref);
CREATE INDEX idx_events_created ON analytics.events (created_at);
CREATE INDEX idx_events_payload_unused ON analytics.events (payload);
CREATE INDEX idx_pageviews_ref ON analytics.pageviews (ref);
CREATE INDEX idx_web_sessions_ref ON analytics.web_sessions (ref);
CREATE INDEX idx_tokens_account ON auth.api_tokens (ref);
CREATE INDEX idx_audit_ref ON auth.audit_log (ref);
CREATE INDEX idx_audit_created ON auth.audit_log (created_at);
`;

const ROUTINES_DDL = `
CREATE FUNCTION shop.order_total(p_order int) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM shop.order_items WHERE ref = p_order $$;
CREATE FUNCTION shop.apply_coupon(p_code text) RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN RETURN (SELECT count(*) FROM shop.coupons WHERE payload = p_code); END $$;
CREATE PROCEDURE shop.place_order(p_customer int) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shop.orders (payload, ref) VALUES ('order', p_customer);
  INSERT INTO shop.order_items (payload, ref) VALUES ('item', p_customer);
  UPDATE shop.inventory SET payload = 'reserved' WHERE id = 1 + (p_customer % 800);
  INSERT INTO shop.payments (payload, ref) VALUES ('pay', p_customer);
END $$;
CREATE PROCEDURE shop.refund_order(p_order int) LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shop.payments SET payload = 'refunded' WHERE id = 1 + (p_order % 11000);
  INSERT INTO auth.audit_log (payload, ref) VALUES ('refund', p_order);
END $$;
CREATE PROCEDURE shop.restock() LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shop.inventory SET payload = 'restocked'
  WHERE id IN (SELECT id FROM shop.products ORDER BY random() LIMIT 5);
END $$;
CREATE PROCEDURE shop.ship_order(p_order int) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shop.shipments (payload, ref) VALUES ('ship', p_order);
  UPDATE shop.orders SET payload = 'shipped' WHERE id = 1 + (p_order % 12000);
END $$;
CREATE FUNCTION analytics.track_event(p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analytics.events (payload, ref) VALUES (p_name, 0);
  INSERT INTO analytics.pageviews (payload, ref) VALUES (p_name, 0);
END $$;
CREATE FUNCTION analytics.conversion_rate() RETURNS numeric LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM analytics.funnels)::numeric
       / GREATEST(1, (SELECT count(*) FROM analytics.web_sessions)) $$;
CREATE PROCEDURE analytics.rollup_daily() LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analytics.reports (payload, ref) SELECT 'daily', count(*) FROM analytics.pageviews;
END $$;
CREATE FUNCTION analytics.ab_winner(p_test int) RETURNS text LANGUAGE sql AS $$
  SELECT payload FROM analytics.ab_tests WHERE id = p_test $$;
CREATE FUNCTION auth.check_permission(p_account int, p_perm text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM auth.permissions p JOIN auth.accounts a ON a.ref = p.ref WHERE a.id = p_account) $$;
CREATE PROCEDURE auth.login(p_account int) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.api_tokens (payload, ref) VALUES (md5(random()::text), p_account);
  INSERT INTO auth.audit_log (payload, ref) VALUES ('login', p_account);
END $$;
CREATE PROCEDURE auth.rotate_tokens() LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM auth.api_tokens WHERE id IN (SELECT id FROM auth.api_tokens ORDER BY id LIMIT 3);
END $$;
CREATE FUNCTION auth.hash_password(p_pw text) RETURNS text LANGUAGE sql AS $$ SELECT md5(p_pw) $$;
`;

const GROUP_ROLES = ['app_writer', 'analyst', 'app_readonly', 'auditor', 'ops', 'developer'];

/** The visitor: statements typed in the UI console run as this user, who then walks to the rack. */
export const CONSOLE_USER = 'you';

const DEMO_USERS: UserInfo[] = [
  { name: 'alice', roles: ['app_writer'], superuser: false },
  { name: 'bob', roles: ['app_writer'], superuser: false },
  { name: 'heidi', roles: ['app_writer'], superuser: false },
  { name: 'svc_api', roles: ['app_writer'], superuser: false },
  { name: 'carol', roles: ['analyst'], superuser: false },
  { name: 'ivan', roles: ['analyst'], superuser: false },
  { name: 'svc_etl', roles: ['analyst', 'app_writer'], superuser: false },
  { name: 'dave', roles: ['app_readonly', 'analyst'], superuser: false },
  { name: 'erin', roles: ['app_readonly'], superuser: false },
  { name: 'judy', roles: ['app_readonly'], superuser: false },
  { name: 'frank', roles: ['auditor'], superuser: false },
  { name: 'grace', roles: ['ops'], superuser: false },
  { name: 'svc_backup', roles: ['ops'], superuser: false },
  { name: 'admin', roles: [], superuser: true },
  { name: CONSOLE_USER, roles: ['developer'], superuser: false },
];

/** What each kind of user does; `#` is replaced with a random id. */
const ACTIONS: Record<string, string[]> = {
  app_writer: [
    'CALL shop.place_order(#)',
    'CALL shop.place_order(#)',
    'CALL shop.ship_order(#)',
    "SELECT shop.apply_coupon('seed-5')",
    'SELECT * FROM shop.orders WHERE id = #',
    "UPDATE shop.customers SET payload = 'touched' WHERE id = #",
    'CALL auth.login(#)',
  ],
  analyst: [
    'SELECT analytics.conversion_rate()',
    'CALL analytics.rollup_daily()',
    'SELECT analytics.ab_winner(3)',
    'SELECT count(*) FROM analytics.events',
    'SELECT * FROM analytics.pageviews ORDER BY id DESC LIMIT 20',
    "SELECT analytics.track_event('report_view')",
  ],
  app_readonly: [
    'SELECT * FROM shop.products WHERE id = #',
    'SELECT shop.order_total(#)',
    'SELECT * FROM shop.customers WHERE id = #',
    "SELECT auth.check_permission(#, 'read')",
  ],
  auditor: [
    'SELECT * FROM auth.audit_log ORDER BY id DESC LIMIT 50',
    'SELECT count(*) FROM shop.payments',
    "SELECT auth.check_permission(#, 'audit')",
  ],
  ops: ['CALL auth.rotate_tokens()', 'CALL shop.restock()', 'SELECT count(*) FROM auth.api_tokens'],
  superuser: [
    'CALL shop.refund_order(#)',
    'DELETE FROM analytics.events WHERE id = #',
    'SELECT * FROM auth.accounts LIMIT 10',
    'SELECT * FROM shop.shipments ORDER BY id DESC LIMIT 10',
  ],
};

const DDL = /^\s*(create|drop|alter|truncate|grant|revoke|comment|reindex|vacuum|analyze|cluster|refresh)\b/i;
const CONSOLE_SESSION_MS = 4200;
const SQL_LIMIT = 4000;
const RESULT_ROWS = 25;

interface SimUser {
  user: UserInfo;
  session: SessionInfo;
  startedAt: number;
  busyUntil: number;
  nextAt: number;
}

type Row = Record<string, unknown>;

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/**
 * Self-contained demo: a real PGlite (Postgres/WASM) instance with schemas, indexes, routines and
 * roles, plus simulated users that drive it. Shared singleton, pre-warmed at server boot because
 * the first WASM compile + seed takes a while. Profiler counters are simulated (PGlite has no
 * stats collector), but everything else comes from the live catalog, so DDL typed in the UI
 * console shows up in the scene.
 */
export class MicroDbConnector implements DbConnector {
  private db: PGlite | null = null;
  private connecting: Promise<void> | null = null;
  private users: UserInfo[] = DEMO_USERS;
  private sims: SimUser[] = [];
  private you: { until: number; session: SessionInfo } | null = null;
  private tableStats = new Map<string, TableStat>();
  private routineStats = new Map<string, RoutineStat>();
  private indexStats = new Map<string, IndexStat>();
  private tables = new TableIndex([]);
  private routines = new RoutineIndex([]);
  private routineList: RoutineInfo[] = [];
  private routineSrc = new Map<string, string>();
  private indexesByTable = new Map<string, IndexInfo[]>();
  private tableList: TableInfo[] = [];

  async connect(): Promise<void> {
    if (this.db) return;
    if (!this.connecting) this.connecting = this.initialize();
    await this.connecting;
  }

  private async initialize(): Promise<void> {
    const db = new PGlite();
    for (const [schema, tables] of Object.entries(SCHEMAS)) {
      await db.exec(`CREATE SCHEMA ${schema};`);
      for (const [name, rows] of tables) {
        await db.exec(`CREATE TABLE ${schema}.${name} (id SERIAL PRIMARY KEY, payload TEXT, ref INT, created_at TIMESTAMPTZ DEFAULT now());`);
        await db.query(
          `INSERT INTO ${schema}.${name} (payload, ref) SELECT 'seed-' || gs, gs % 1000 FROM generate_series(1, $1) AS gs;`,
          [rows],
        );
      }
    }
    await db.exec(INDEXES_DDL);
    await db.exec(ROUTINES_DDL);

    try {
      for (const role of GROUP_ROLES) await db.exec(`CREATE ROLE ${role};`);
      for (const u of DEMO_USERS) {
        await db.exec(`CREATE ROLE ${u.name} LOGIN${u.superuser ? ' SUPERUSER' : ''};`);
        for (const r of u.roles) await db.exec(`GRANT ${r} TO ${u.name};`);
      }
    } catch {
      // Roles are optional for the demo; the simulated user list is used as a fallback.
    }

    this.db = db;
    await this.topology();
    const now = Date.now();
    this.sims = this.users
      .filter((u) => u.name !== CONSOLE_USER)
      .map((user, i) => ({
        user,
        session: { id: `demo-${i}`, user: user.name, database: '', state: 'idle', durationMs: 0 },
        startedAt: now,
        busyUntil: 0,
        nextAt: now + 800 + Math.random() * 6000,
      }));
  }

  /** No-op: shared singleton, one session's teardown must not stop it for the others. */
  async disconnect(): Promise<void> {}

  async topology(): Promise<Topology> {
    const db = this.db!;

    const schemaRows = await db.query<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg\\_%' ORDER BY nspname`,
    );
    const tableRows = await db.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       ORDER BY n.nspname, c.relname`,
    );

    const tables: TableInfo[] = [];
    for (const t of tableRows.rows) {
      const q = `"${t.schema}"."${t.name}"`;
      const rowCount = await db
        .query<{ n: number }>(`SELECT count(*)::float8 AS n FROM ${q}`)
        .then((r) => num(r.rows[0]?.n))
        .catch(() => 0);
      const size = await db
        .query<{ b: number }>(`SELECT pg_total_relation_size('${q}'::regclass)::float8 AS b`)
        .then((r) => num(r.rows[0]?.b))
        .catch(() => 0);
      tables.push({
        id: tableId(t.schema, '', t.name),
        database: t.schema,
        schema: '',
        name: t.name,
        kind: 'table',
        rowCount,
        sizeBytes: size || rowCount * 120,
      });
    }
    this.tables = new TableIndex(tables);
    this.tableList = tables;

    const databases = schemaRows.rows
      .map((r) => r.name)
      .filter((name) => name !== 'public' || tables.some((t) => t.database === 'public'));

    // Indexes: catalog rows are keyed by schema + table, which the demo maps to "database" + table.
    const indexRows = await db.query<PgIndexRow>(PG_INDEXES_SQL).catch(() => ({ rows: [] as PgIndexRow[] }));
    const known = new Set(tables.map((t) => t.id));
    const indexes: IndexInfo[] = [];
    for (const schema of databases) {
      const mine = indexRows.rows.filter((r) => String(r.schema) === schema).map((r) => ({ ...r, schema: '' }));
      indexes.push(...pgIndexInfos(schema, mine, known));
    }
    this.indexesByTable = new Map();
    for (const ix of indexes) this.indexesByTable.set(ix.tableId, [...(this.indexesByTable.get(ix.tableId) ?? []), ix]);
    const liveIds = new Set(indexes.map((i) => i.id));
    for (const id of [...this.indexStats.keys()]) if (!liveIds.has(id)) this.indexStats.delete(id);
    for (const id of liveIds) if (!this.indexStats.has(id)) this.indexStats.set(id, { id, scans: 0 });

    const dbList = databases.map((s) => `'${s}'`).join(', ') || "''";
    const procs = await db.query<{ oid: string; schema: string; name: string; kind: string; lang: string; src: string }>(`
      SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, p.prokind::text AS kind, l.lanname AS lang, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname IN (${dbList}) AND p.prokind IN ('f', 'p')`);
    this.routineSrc = new Map(procs.rows.map((r) => [`${r.schema}:${r.oid}`, r.src]));
    this.routineList = procs.rows.map((r) => ({
      id: `${r.schema}:${r.oid}`,
      database: r.schema,
      schema: '',
      name: r.name,
      kind: r.kind === 'p' ? 'procedure' : 'function',
      language: r.lang,
      touches: this.tables.findAll(r.src, r.schema),
    }));
    this.routines = new RoutineIndex(this.routineList);

    let principals = await db
      .query<PgRoleRow>(PG_ROLES_SQL)
      .then((r) => principalsFromPg(r.rows.filter((row) => row.name !== 'postgres')))
      .catch(() => null);
    if (!principals || principals.users.length === 0) {
      principals = {
        users: DEMO_USERS,
        roles: GROUP_ROLES.map((name) => ({
          name,
          members: DEMO_USERS.filter((u) => u.roles.includes(name)).map((u) => u.name),
        })),
      };
    }
    this.users = principals.users;

    return {
      engine: 'demo',
      server: 'PGlite · built-in demo',
      databases: databases.map((s) => ({
        name: s,
        sizeBytes: tables.filter((t) => t.database === s).reduce((sum, t) => sum + t.sizeBytes, 0),
      })),
      tables,
      indexes,
      routines: this.routineList,
      roles: principals.roles,
      users: principals.users,
    };
  }

  private bump(id: string, op: 'read' | 'write', amount = 1): void {
    const s = this.tableStats.get(id) ?? { id, reads: 0, writes: 0, locks: 0, waiting: 0 };
    if (op === 'read') s.reads += amount;
    else s.writes += amount;
    this.tableStats.set(id, s);
  }

  /** An index counts as used when the statement mentions its leading column. */
  private touchIndexes(id: string, text: string, only?: Set<string>): void {
    const tokens = new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    for (const ix of this.indexesByTable.get(id) ?? []) {
      const lead = ix.columns[0]?.toLowerCase();
      if (!lead || !tokens.has(lead) || (only && !only.has(lead))) continue;
      const s = this.indexStats.get(ix.id);
      if (s) s.scans += 1;
    }
  }

  /** Books a statement against the simulated profiler counters. */
  private record(sql: string, ms: number, affected = 1): { tableId?: string; routineId?: string; database: string; ddl: boolean } {
    const ddl = DDL.test(sql);
    const routineId = ddl ? undefined : this.routines.find(sql);
    const routine = this.routineList.find((r) => r.id === routineId);
    const direct = this.tables.findAll(sql);
    const first = direct[0];
    const database = routine?.database ?? first?.split('.')[0] ?? '';
    if (ddl) return { tableId: first, database, ddl };

    if (routine) {
      const s = this.routineStats.get(routine.id) ?? { id: routine.id, calls: 0, totalMs: 0 };
      s.calls += 1;
      s.totalMs += ms;
      this.routineStats.set(routine.id, s);
      const body = this.routineSrc.get(routine.id) ?? '';
      for (const t of routine.touches) {
        this.bump(t, routine.kind === 'procedure' ? 'write' : 'read');
        this.touchIndexes(t, body);
      }
    }
    const op = classify(sql);
    for (const t of routine ? [] : direct) {
      this.bump(t, op, op === 'write' ? Math.max(1, affected) : 1);
      this.touchIndexes(t, sql);
    }
    return { tableId: first ?? routine?.touches[0], routineId: routine?.id, database, ddl };
  }

  async exec(sql: string): Promise<ExecResult> {
    const text = sql.trim();
    if (!text) return { ok: false, message: 'Empty query', ms: 0 };
    if (text.length > SQL_LIMIT) return { ok: false, message: `Query too long (max ${SQL_LIMIT} characters)`, ms: 0 };
    if (!this.db) return { ok: false, message: 'The demo is not ready yet', ms: 0 };

    const t0 = performance.now();
    let results: Array<{ rows: Row[]; fields: Array<{ name: string }>; affectedRows?: number }>;
    try {
      results = (await this.db.exec(text)) as unknown as typeof results;
    } catch (err) {
      return { ok: false, message: (err as Error).message, ms: Math.round(performance.now() - t0) };
    }
    const ms = performance.now() - t0;

    const statements = text.split(';').map((s) => s.trim()).filter(Boolean);
    let primary: ReturnType<MicroDbConnector['record']> | null = null;
    statements.forEach((stmt, i) => {
      const rec = this.record(stmt, ms / statements.length, results[i]?.affectedRows ?? results[i]?.rows?.length ?? 1);
      primary ??= rec;
    });
    const p = primary as ReturnType<MicroDbConnector['record']> | null;
    this.you = {
      until: Date.now() + CONSOLE_SESSION_MS,
      session: {
        id: 'demo-you',
        user: CONSOLE_USER,
        database: p?.database ?? '',
        state: 'active',
        tableId: p?.tableId,
        routineId: p?.routineId,
        query: text.slice(0, 300),
        durationMs: 0,
      },
    };

    const last = results[results.length - 1];
    const columns = last?.fields?.map((f) => f.name) ?? [];
    const rows = columns.length ? (last.rows ?? []).slice(0, RESULT_ROWS).map((r) => columns.map((c) => cell(r[c]))) : undefined;
    const affected = last?.affectedRows;
    const message = columns.length
      ? `${last.rows.length} row${last.rows.length === 1 ? '' : 's'}${last.rows.length > RESULT_ROWS ? ` (first ${RESULT_ROWS})` : ''}`
      : `OK${affected ? ` · ${affected} row${affected === 1 ? '' : 's'}` : ''}`;
    return { ok: true, message, columns: columns.length ? columns : undefined, rows, ms: Math.round(ms) };
  }

  private async runAction(sim: SimUser, now: number): Promise<void> {
    const pool = sim.user.superuser
      ? ACTIONS.superuser
      : ACTIONS[sim.user.roles.find((r) => ACTIONS[r]) ?? 'app_readonly'];
    const sql = pool[Math.floor(Math.random() * pool.length)].replace('#', String(1 + Math.floor(Math.random() * 3000)));

    const t0 = performance.now();
    let affected = 1;
    try {
      const res = await this.db!.query(sql);
      affected = res.affectedRows ?? res.rows.length ?? 1;
    } catch {
      return;
    }
    const rec = this.record(sql, performance.now() - t0, affected);

    const lockWait = Math.random() < 0.07 && Boolean(rec.tableId);
    const busy = 4000 + Math.random() * 6000;
    sim.startedAt = now;
    sim.busyUntil = now + busy;
    sim.nextAt = sim.busyUntil + 1500 + Math.random() * 9000;
    sim.session = {
      ...sim.session,
      database: rec.database,
      state: lockWait ? 'waiting' : 'active',
      tableId: rec.tableId,
      routineId: rec.routineId,
      query: sql,
      durationMs: 0,
    };
  }

  async sample(): Promise<Sample> {
    const now = Date.now();

    for (const sim of this.sims) {
      if (sim.session.state !== 'idle' && now > sim.busyUntil) {
        sim.session = { id: sim.session.id, user: sim.user.name, database: '', state: 'idle', durationMs: 0 };
      }
    }

    const ready = this.sims.filter((s) => s.session.state === 'idle' && now >= s.nextAt);
    for (const sim of ready.sort(() => Math.random() - 0.5).slice(0, 3)) await this.runAction(sim, now);

    // Background application traffic from pooled short queries that never show up as long-lived sessions.
    for (let i = 0; i < 2 && this.tableList.length; i++) {
      if (Math.random() < 0.4) continue;
      const t = this.tableList[Math.floor(Math.random() * this.tableList.length)];
      const op = Math.random() < 0.7 ? 'read' : 'write';
      this.bump(t.id, op, 1 + Math.floor(Math.random() * 4));
      if (op === 'read' && Math.random() < 0.5) this.touchIndexes(t.id, 'id', new Set(['id']));
    }

    for (const s of this.tableStats.values()) {
      s.locks = 0;
      s.waiting = 0;
    }
    const sessions: SessionInfo[] = this.sims.map((s) => ({ ...s.session }));
    const youActive = this.you && now < this.you.until;
    sessions.push(
      youActive
        ? { ...this.you!.session, durationMs: now - (this.you!.until - CONSOLE_SESSION_MS) }
        : { id: 'demo-you', user: CONSOLE_USER, database: '', state: 'idle', durationMs: 0 },
    );
    for (const s of sessions) {
      if (!s.tableId || s.state === 'idle') continue;
      const stat = this.tableStats.get(s.tableId) ?? { id: s.tableId, reads: 0, writes: 0, locks: 0, waiting: 0 };
      stat.locks += 1;
      if (s.state === 'waiting') stat.waiting += 1;
      this.tableStats.set(s.tableId, stat);
    }
    for (const sim of this.sims) if (sim.session.state !== 'idle') sim.session.durationMs = now - sim.startedAt;

    const fp = await this.db!.query<Row>(PG_FINGERPRINT_SQL).then((r) => (r.rows[0] ? Object.values(r.rows[0]).join('|') : '')).catch(() => '');

    return {
      tables: [...this.tableStats.values()].map((s) => ({ ...s })),
      routines: [...this.routineStats.values()].map((s) => ({ ...s })),
      indexes: [...this.indexStats.values()].map((s) => ({ ...s })),
      sessions,
      fingerprint: fp,
    };
  }
}

let sharedInstance: MicroDbConnector | null = null;

export function getSharedMicroDb(): MicroDbConnector {
  if (!sharedInstance) sharedInstance = new MicroDbConnector();
  return sharedInstance;
}

/** Call once at server boot so the WASM compile/seed cost is paid before any client connects. */
export function warmUpMicroDb(): Promise<void> {
  return getSharedMicroDb().connect();
}
