import type { IndexInfo, RoleInfo, RoutineInfo, TableInfo, UserInfo } from '../../../shared/types';

/** application_name / appName used by our own connections so the profiler can exclude itself. */
export const PROFILER_APP = '3d-db-profiler';

export const MAX_DATABASES = 8;

export function tableId(database: string, schema: string, name: string): string {
  return schema ? `${database}.${schema}.${name}` : `${database}.${name}`;
}

const IDENT = '[\\w$#]+|"[^"]+"|`[^`]+`|\\[[^\\]]+\\]';
const QUALIFIED = `(?:(?:${IDENT})\\s*\\.\\s*){0,2}(?:${IDENT})`;
const TABLE_REF = new RegExp(`\\b(?:from|join|into|update|table)\\s+(${QUALIFIED})`, 'gi');
const CALL_REF = new RegExp(`(?:\\b(?:call|exec|execute)\\s+(${QUALIFIED}))|(?:(${QUALIFIED})\\s*\\()`, 'gi');

function splitIdent(ref: string): string[] {
  return ref.split('.').map((p) => p.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase());
}

export function classify(query: string | undefined): 'read' | 'write' {
  return /^\s*(insert|update|delete|merge|upsert|replace|truncate|alter|create|drop)\b/i.test(query ?? '') ? 'write' : 'read';
}

interface Named {
  id: string;
  database: string;
  schema: string;
  name: string;
}

function resolve<T extends Named>(index: Map<string, T[]>, parts: string[], database?: string): T | undefined {
  const candidates = index.get(parts[parts.length - 1]);
  if (!candidates?.length) return undefined;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    if (database && c.database === database) score += 2;
    if (qualifier && (c.schema.toLowerCase() === qualifier || c.database.toLowerCase() === qualifier)) score += 3;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function indexByName<T extends Named>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Maps table references found in SQL text (queries, routine bodies) to table ids. */
export class TableIndex {
  private byName: Map<string, TableInfo[]>;

  constructor(tables: TableInfo[]) {
    this.byName = indexByName(tables);
  }

  findAll(sql: string, database?: string): string[] {
    const found = new Set<string>();
    for (const m of sql.matchAll(TABLE_REF)) {
      const hit = resolve(this.byName, splitIdent(m[1]), database);
      if (hit) found.add(hit.id);
    }
    return [...found];
  }

  find(sql: string | undefined, database?: string): string | undefined {
    return sql ? this.findAll(sql, database)[0] : undefined;
  }

  byPlainName(name: string, database?: string): string | undefined {
    return resolve(this.byName, splitIdent(name), database)?.id;
  }
}

export class RoutineIndex {
  private byName: Map<string, RoutineInfo[]>;

  constructor(routines: RoutineInfo[]) {
    this.byName = indexByName(routines);
  }

  find(sql: string | undefined, database?: string): string | undefined {
    if (!sql || this.byName.size === 0) return undefined;
    for (const m of sql.matchAll(CALL_REF)) {
      const hit = resolve(this.byName, splitIdent(m[1] ?? m[2]), database);
      if (hit) return hit.id;
    }
    return undefined;
  }
}

export interface PgRoleRow {
  name: string;
  superuser: boolean;
  login: boolean;
  member_of: string[] | string | null;
}

export function pgArray(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (!value || value === '{}') return [];
  return value.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
}

/** Postgres: login roles are users, non-login roles are groups. */
export function principalsFromPg(rows: PgRoleRow[]): { roles: RoleInfo[]; users: UserInfo[] } {
  const users: UserInfo[] = rows
    .filter((r) => r.login)
    .map((r) => ({ name: r.name, roles: pgArray(r.member_of), superuser: Boolean(r.superuser) }));
  const roles: RoleInfo[] = rows
    .filter((r) => !r.login)
    .map((r) => ({ name: r.name, members: users.filter((u) => u.roles.includes(r.name)).map((u) => u.name) }));
  return { roles, users };
}

export function rolesFromMembership(users: UserInfo[], roleNames: Iterable<string>): RoleInfo[] {
  return [...new Set(roleNames)].map((name) => ({
    name,
    members: users.filter((u) => u.roles.includes(name)).map((u) => u.name),
  }));
}

export function num(v: unknown): number {
  if (typeof v === 'object' && v !== null && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function indexId(tableIdValue: string, name: string): string {
  return `${tableIdValue}#${name}`;
}

export interface PgIndexRow {
  schema: string;
  tbl: string;
  name: string;
  method: string;
  uniq: boolean;
  prim: boolean;
  bytes: number | string;
  cols: string[] | string | null;
}

/** pg_index rows (one database) → IndexInfo; only for tables we actually show. */
export function pgIndexInfos(database: string, rows: PgIndexRow[], tables: Set<string>): IndexInfo[] {
  const out: IndexInfo[] = [];
  for (const r of rows) {
    const tid = tableId(database, String(r.schema), String(r.tbl));
    if (!tables.has(tid)) continue;
    out.push({
      id: indexId(tid, String(r.name)),
      tableId: tid,
      name: String(r.name),
      columns: pgArray(r.cols),
      unique: Boolean(r.uniq),
      primary: Boolean(r.prim),
      method: String(r.method),
      sizeBytes: num(r.bytes),
    });
  }
  return out;
}
