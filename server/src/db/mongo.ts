import { MongoClient, type Document } from 'mongodb';
import type { ConnectionTarget, IndexInfo, RoutineInfo, SessionInfo, TableInfo, Topology, UserInfo } from '../../../shared/types';
import type { DbConnector, IndexStat, RoutineStat, Sample, TableStat } from './types';
import { MAX_DATABASES, PROFILER_APP, indexId, num, rolesFromMembership, tableId } from './util';

const MAX_INDEX_STAT_COLLECTIONS = 60;

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

/** Collection named by a command document, e.g. { find: 'orders' } or { insert: 'logs' }. */
function commandCollection(command: Document | undefined): string | undefined {
  if (!command) return undefined;
  for (const key of ['find', 'insert', 'update', 'delete', 'aggregate', 'count', 'distinct', 'findAndModify', 'findandmodify', 'getMore']) {
    const v = command[key];
    if (typeof v === 'string') return v;
  }
  return typeof command.collection === 'string' ? command.collection : undefined;
}

export class MongoConnector implements DbConnector {
  private client: MongoClient | null = null;
  private target: ConnectionTarget = { kind: 'mongo' };
  private databases: string[] = [];
  private tableIds = new Set<string>();

  async connect(target: ConnectionTarget): Promise<void> {
    this.target = target;
    const host = target.host ?? 'localhost';
    const port = target.port ?? 27017;
    const auth = target.user
      ? `${encodeURIComponent(target.user)}:${encodeURIComponent(target.password ?? '')}@`
      : '';
    const params = [
      target.database ? `authSource=${encodeURIComponent(target.database)}` : '',
      target.ssl ? 'tls=true&tlsAllowInvalidCertificates=true' : '',
    ].filter(Boolean);
    // A full URI (replica sets, SRV, options) is used exactly as given.
    const uri = target.uri ?? `mongodb://${auth}${host}:${port}/${params.length ? `?${params.join('&')}` : ''}`;
    this.client = new MongoClient(uri, {
      appName: PROFILER_APP,
      serverSelectionTimeoutMS: 5000,
    });
    await this.client.connect();
    await this.client.db('admin').command({ ping: 1 });
  }

  async disconnect(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private admin() {
    return this.client!.db('admin');
  }

  async topology(): Promise<Topology> {
    const list = await this.admin().command({ listDatabases: 1 });
    const dbs = (list.databases as Document[])
      .filter((d) => !SYSTEM_DBS.has(String(d.name)))
      .slice(0, MAX_DATABASES);
    this.databases = dbs.map((d) => String(d.name));

    const tables: TableInfo[] = [];
    const indexes: IndexInfo[] = [];
    const routines: RoutineInfo[] = [];
    for (const name of this.databases) {
      const db = this.client!.db(name);
      const collections = await db.listCollections({}, { nameOnly: false }).toArray().catch(() => []);
      for (const c of collections) {
        if (c.type !== 'collection' || c.name.startsWith('system.')) continue;
        const stats = await db
          .collection(c.name)
          .aggregate([{ $collStats: { storageStats: {} } }])
          .toArray()
          .then((r) => r[0]?.storageStats as Document | undefined)
          .catch(() => undefined);
        const tid = tableId(name, '', c.name);
        tables.push({
          id: tid,
          database: name,
          schema: '',
          name: c.name,
          kind: 'collection',
          rowCount: num(stats?.count),
          sizeBytes: num(stats?.size) + num(stats?.totalIndexSize),
        });

        const sizes = (stats?.indexSizes ?? {}) as Record<string, unknown>;
        const defs = await db.collection(c.name).listIndexes().toArray().catch(() => [] as Document[]);
        for (const ix of defs) {
          const ixName = String(ix.name);
          indexes.push({
            id: indexId(tid, ixName),
            tableId: tid,
            name: ixName,
            columns: Object.keys((ix.key ?? {}) as Record<string, unknown>),
            unique: ixName === '_id_' || Boolean(ix.unique),
            primary: ixName === '_id_',
            method: Object.values((ix.key ?? {}) as Record<string, unknown>).some((v) => typeof v === 'string') ? 'special' : 'btree',
            sizeBytes: num(sizes[ixName]),
          });
        }
      }

      // Server-side stored JavaScript functions (db.system.js).
      const stored = await db.collection('system.js').find({}).toArray().catch(() => []);
      const collectionNames = collections.map((c) => c.name);
      for (const fn of stored) {
        const code = String((fn.value as { code?: string })?.code ?? fn.value ?? '');
        routines.push({
          id: `${name}.system.js.${String(fn._id)}`,
          database: name,
          schema: '',
          name: String(fn._id),
          kind: 'function',
          language: 'javascript',
          touches: collectionNames
            .filter((cn) => new RegExp(`\\b${cn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code))
            .map((cn) => tableId(name, '', cn)),
        });
      }
    }
    this.tableIds = new Set(tables.map((t) => t.id));

    const { users, roleNames } = await this.principals();

    return {
      engine: 'mongo',
      server: `${this.target.host ?? 'localhost'}:${this.target.port ?? 27017}`,
      databases: dbs.map((d) => ({ name: String(d.name), sizeBytes: num(d.sizeOnDisk) })),
      tables,
      indexes,
      routines,
      roles: rolesFromMembership(users, roleNames),
      users,
    };
  }

  private async principals(): Promise<{ users: UserInfo[]; roleNames: string[] }> {
    const info = await this.admin()
      .command({ usersInfo: { forAllDBs: true } })
      .catch(() => ({ users: [] as Document[] }));
    const raw = (info.users ?? []) as Document[];
    const dupes = new Set(raw.map((u) => u.user).filter((u, i, arr) => arr.indexOf(u) !== i));
    const users: UserInfo[] = raw.map((u) => {
      const roles = ((u.roles ?? []) as Document[]).map((r) => (r.db === 'admin' ? String(r.role) : `${r.role}@${r.db}`));
      return {
        name: dupes.has(u.user) ? `${u.user}@${u.db}` : String(u.user),
        roles,
        superuser: roles.includes('root') || roles.includes('__system'),
      };
    });

    const custom = await this.admin()
      .command({ rolesInfo: 1, showBuiltinRoles: false })
      .then((r) => ((r.roles ?? []) as Document[]).map((role) => String(role.role)))
      .catch(() => [] as string[]);

    return { users, roleNames: [...new Set([...users.flatMap((u) => u.roles), ...custom])] };
  }

  async sample(): Promise<Sample> {
    const top = await this.admin()
      .command({ top: 1 })
      .catch(() => ({ totals: {} as Document }));
    const ops = await this.admin()
      .aggregate([{ $currentOp: { allUsers: true, idleConnections: true } }])
      .toArray()
      .catch(() => [] as Document[]);

    const waitingByNs = new Map<string, number>();
    const activeByNs = new Map<string, number>();
    const sessions: SessionInfo[] = [];

    for (const op of ops) {
      if (op.appName === PROFILER_APP || !op.client) continue;
      const user = (op.effectiveUsers as Document[] | undefined)?.[0]?.user ?? 'anonymous';
      const [db, ...rest] = String(op.ns ?? '').split('.');
      let coll = rest.join('.');
      if (coll === '$cmd') coll = commandCollection(op.command as Document) ?? '';
      const id = coll ? tableId(db, '', coll) : undefined;
      const tableIdKnown = id && this.tableIds.has(id) ? id : undefined;
      const active = Boolean(op.active);
      const waiting = Boolean(op.waitingForLock);

      if (tableIdKnown && active) {
        activeByNs.set(tableIdKnown, (activeByNs.get(tableIdKnown) ?? 0) + 1);
        if (waiting) waitingByNs.set(tableIdKnown, (waitingByNs.get(tableIdKnown) ?? 0) + 1);
      }

      sessions.push({
        id: String(op.opid ?? op.connectionId ?? op.client),
        user: String(user),
        database: db,
        state: !active ? 'idle' : waiting ? 'waiting' : 'active',
        tableId: active ? tableIdKnown : undefined,
        query: active && op.command ? JSON.stringify(op.command).slice(0, 300) : undefined,
        durationMs: num(op.microsecs_running) / 1000,
      });
    }

    const tables: TableStat[] = [];
    for (const [ns, t] of Object.entries((top.totals ?? {}) as Record<string, Document>)) {
      if (ns === 'note' || typeof t !== 'object') continue;
      const [db, ...rest] = ns.split('.');
      const id = tableId(db, '', rest.join('.'));
      if (!this.tableIds.has(id)) continue;
      const count = (k: string) => num((t[k] as Document | undefined)?.count);
      tables.push({
        id,
        reads: count('queries') + count('getmore'),
        writes: count('insert') + count('update') + count('remove'),
        locks: activeByNs.get(id) ?? 0,
        waiting: waitingByNs.get(id) ?? 0,
      });
    }

    const routines: RoutineStat[] = [];

    const indexes: IndexStat[] = [];
    const tableList = [...this.tableIds].slice(0, MAX_INDEX_STAT_COLLECTIONS);
    await Promise.all(
      tableList.map(async (tid) => {
        const [db, ...rest] = tid.split('.');
        const rows = await this.client!
          .db(db)
          .collection(rest.join('.'))
          .aggregate([{ $indexStats: {} }])
          .toArray()
          .catch(() => [] as Document[]);
        for (const r of rows) indexes.push({ id: indexId(tid, String(r.name)), scans: num((r.accesses as Document | undefined)?.ops) });
      }),
    );

    const digests = await Promise.all(
      this.databases.map((name) =>
        this.client!.db(name)
          .command({ dbStats: 1 })
          .then((s) => `${name}:${num(s.collections)}/${num(s.indexes)}`)
          .catch(() => name),
      ),
    );
    const fingerprint = digests.join('|');

    return {
      tables,
      routines,
      indexes,
      sessions: sessions.filter((s) => s.user !== 'anonymous' || s.state !== 'idle'),
      fingerprint,
    };
  }
}
