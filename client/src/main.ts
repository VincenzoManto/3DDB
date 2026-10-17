import * as THREE from 'three';
import './style.css';
import type { ActivityEvent, Metrics, SchemaChange, SessionInfo, Topology } from '../../shared/types';
import { createScene } from './scene/setup';
import { createPostFx } from './scene/postfx';
import { CameraRig } from './scene/rig';
import { FxStore } from './fx';
import { FxPanel } from './ui/fxPanel';
import { Building } from './scene/building';
import { Datacenter, INDEX_COLORS, OP_COLOR, type TopologyDiff } from './scene/datacenter';
import { RoutineFloor, FUNC_COLOR, PROC_COLOR } from './scene/routines';
import { People, PUBLIC_ROLE, SUPER_COLOR, type TargetResolver } from './scene/people';
import { ActivityFx } from './scene/activity';
import { buildNav } from './scene/nav';
import { WsClient } from './ws/client';
import { ConnectionPanel } from './ui/connectionPanel';
import { Hud, type HudContent } from './ui/hud';
import { Legend } from './ui/legend';
import { Feed, type FeedTag } from './ui/feed';
import { SqlConsole } from './ui/console';
import { NoticeBanner } from './ui/notice';

type Kind = 'table' | 'routine' | 'user' | 'role' | 'database' | 'index';
interface Pick {
  kind: Kind;
  id: string;
}

/** The demo's visitor account: console statements run as this user, so the feed skips its sessions. */
const YOU = 'you';
/** Pulses of one profiler delta are spread over about one poll interval. */
const SPREAD_MS = 900;
const MAX_PULSES_PER_TICK = 70;

const app = document.getElementById('app')!;
const { scene, renderer } = createScene(app);
const rig = new CameraRig(renderer.domElement);
const camera = rig.camera;
const postfx = createPostFx(renderer, scene, camera);
const fxStore = new FxStore();
new FxPanel(fxStore);
fxStore.onChange((s) => {
  rig.setFocalLength(s.focalLength);
  postfx.apply(s);
});
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  rig.resize();
  postfx.setSize(window.innerWidth, window.innerHeight);
});

new Building(scene);
const datacenter = new Datacenter(scene);
const routines = new RoutineFloor(scene);
const people = new People(scene);
const activity = new ActivityFx(scene, datacenter);
const hud = new Hud();
const legend = new Legend();
const feed = new Feed();

const statusBar = document.createElement('div');
statusBar.id = 'status-bar';
statusBar.textContent = '[ disconnected ]';
document.body.appendChild(statusBar);

const hint = document.createElement('div');
hint.id = 'controls-hint';
hint.textContent = 'drag: rotate · scroll: zoom · right-drag: pan · double-click: reset view · click: details';
document.body.appendChild(hint);

let topology: Topology | null = null;
let metrics: Metrics = { tables: {}, routines: {}, indexes: {} };
let sessions: SessionInfo[] = [];
let selected: Pick | null = null;

const pending: Array<{ at: number; run: () => void }> = [];
function later(delayMs: number, run: () => void): void {
  if (pending.length < 600) pending.push({ at: performance.now() + delayMs, run });
}
function runPending(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].at > now) continue;
    const [due] = pending.splice(i, 1);
    due.run();
  }
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const formatBytes = (b: number) =>
  b >= 1e9 ? `${fmt.format(b / 1e9)} GB` : b >= 1e6 ? `${fmt.format(b / 1e6)} MB` : b >= 1e3 ? `${fmt.format(b / 1e3)} KB` : `${b} B`;
const isWrite = (q?: string) => /^\s*(insert|update|delete|merge|upsert|replace|truncate)\b/i.test(q ?? '');

const tableName = (id: string) => {
  const t = topology?.tables.find((x) => x.id === id);
  return t ? `${t.database}.${t.schema ? `${t.schema}.` : ''}${t.name}` : id;
};
const routineName = (id: string) => {
  const r = topology?.routines.find((x) => x.id === id);
  return r ? `${r.kind === 'procedure' ? 'SP' : 'FN'} ${r.name}` : id;
};

const indexLine = (id: string) => {
  const ix = topology?.indexes.find((x) => x.id === id);
  if (!ix) return id;
  const im = metrics.indexes[id];
  const tag = ix.primary ? 'PK' : ix.unique ? 'UQ' : 'IX';
  const use = !im ? '' : im.scans === 0 ? ' · never used' : ` · ${im.scans.toLocaleString('en-US')} scans`;
  return `[${tag}] ${ix.name} (${ix.columns.join(', ')})${use}`;
};

const resolveTarget: TargetResolver = (s, slot) => {
  if (s.routineId && routines.has(s.routineId)) {
    return {
      kind: 'routine',
      id: s.routineId,
      stand: routines.standPoint(s.routineId, slot)!,
      look: routines.deskPoint(s.routineId)!,
      anchor: routines.anchor(s.routineId)!,
      op: 'call',
    };
  }
  if (s.tableId && datacenter.has(s.tableId)) {
    const top = datacenter.rackTop(s.tableId)!;
    return {
      kind: 'table',
      id: s.tableId,
      stand: datacenter.standPoint(s.tableId, slot)!,
      look: datacenter.rackCenter(s.tableId)!,
      anchor: top.setY(top.y * 0.6),
      op: isWrite(s.query) ? 'write' : 'read',
    };
  }
  return null;
};

function applyTopology(t: Topology): TopologyDiff {
  topology = t;
  const diff = datacenter.setTopology(t);
  const routinesChanged = routines.setTopology(t);
  const peopleChanged = people.setTopology(t);
  if (diff.changed || routinesChanged || peopleChanged) {
    people.setNav(buildNav(datacenter.layout, [...routines.navLinks(), ...people.navLinks()], datacenter.allStandPoints()));
  }
  if (selected && !exists(selected)) select(null);
  else refreshSelection();
  legend.update(t, sessions, people.overflow, metrics);
  sqlConsole.setEnabled(t.engine === 'demo');
  return diff;
}

function exists(p: Pick): boolean {
  if (!topology) return false;
  switch (p.kind) {
    case 'table':
      return topology.tables.some((t) => t.id === p.id);
    case 'index':
      return topology.indexes.some((i) => i.id === p.id);
    case 'routine':
      return topology.routines.some((r) => r.id === p.id);
    case 'user':
      return topology.users.some((u) => u.name === p.id);
    case 'database':
      return topology.databases.some((d) => d.name === p.id);
    case 'role':
      return p.id === '__superuser' || p.id === PUBLIC_ROLE || topology.roles.some((r) => r.name === p.id);
  }
}

function roleMembers(id: string): string[] {
  if (!topology) return [];
  if (id === '__superuser') return topology.users.filter((u) => u.superuser).map((u) => u.name);
  if (id === PUBLIC_ROLE) {
    const known = new Set(topology.roles.map((r) => r.name));
    return topology.users.filter((u) => !u.superuser && !u.roles.some((r) => known.has(r))).map((u) => u.name);
  }
  return topology.roles.find((r) => r.name === id)?.members ?? [];
}

function hudContent(p: Pick): HudContent | null {
  if (!topology) return null;
  const active = sessions.filter((s) => s.state !== 'idle');
  switch (p.kind) {
    case 'table': {
      const t = topology.tables.find((x) => x.id === p.id);
      if (!t) return null;
      const m = metrics.tables[p.id];
      const indexes = topology.indexes.filter((i) => i.tableId === p.id);
      return {
        kicker: t.kind === 'collection' ? 'Collection · rack' : 'Table · rack',
        title: t.name,
        rows: [
          ['Database', t.database],
          ...(t.schema ? ([['Schema', t.schema]] as Array<[string, string]>) : []),
          ['Rows', t.rowCount.toLocaleString('en-US')],
          ['Size', formatBytes(t.sizeBytes)],
          ['Indexes', String(indexes.length)],
          ['Reads/s', fmt.format(m?.readsPerSec ?? 0)],
          ['Writes/s', fmt.format(m?.writesPerSec ?? 0)],
          ['Active locks', String(m?.locks ?? 0)],
          ['Sessions waiting', String(m?.waiting ?? 0)],
        ],
        sections: [
          { label: 'Indexes', items: indexes.map((i) => indexLine(i.id)) },
          { label: 'Users working here', items: active.filter((s) => s.tableId === p.id).map((s) => `${s.user}${s.state === 'waiting' ? ' (waiting on a lock)' : ''}`) },
          { label: 'Routines that use it', items: topology.routines.filter((r) => r.touches.includes(p.id)).map((r) => routineName(r.id)) },
        ],
      };
    }
    case 'index': {
      const ix = topology.indexes.find((x) => x.id === p.id);
      if (!ix) return null;
      const im = metrics.indexes[p.id];
      const kind = ix.primary ? 'primary' : ix.unique ? 'unique' : 'plain';
      const dead = im !== undefined && im.scans === 0;
      return {
        kicker: ix.primary ? 'Index · primary key' : ix.unique ? 'Index · unique' : 'Index',
        title: ix.name,
        color: dead ? INDEX_COLORS.dead : INDEX_COLORS[kind],
        rows: [
          ['Table', tableName(ix.tableId)],
          ['Columns', ix.columns.join(', ') || '(expression)'],
          ['Type', ix.method || '—'],
          ['Size', ix.sizeBytes ? formatBytes(ix.sizeBytes) : 'n/a'],
          ['Total scans', im ? im.scans.toLocaleString('en-US') : 'n/a'],
          ['Scans/s', im ? fmt.format(im.scansPerSec) : 'n/a'],
          ['Stato', !im ? 'statistics not available' : dead ? 'never used' : 'in use'],
        ],
        sections: dead && !ix.primary && !ix.unique ? [{ label: 'Suggestion', items: ['No scans recorded: candidate for removal'] }] : [],
      };
    }
    case 'routine': {
      const r = topology.routines.find((x) => x.id === p.id);
      if (!r) return null;
      const m = metrics.routines[p.id];
      return {
        kicker: r.kind === 'procedure' ? 'Stored procedure · workstation' : 'Function · workstation',
        title: r.name,
        color: r.kind === 'function' ? '#3dd6ff' : undefined,
        rows: [
          ['Database', r.database],
          ...(r.schema ? ([['Schema', r.schema]] as Array<[string, string]>) : []),
          ['Language', r.language],
          ['Total calls', m ? m.calls.toLocaleString('en-US') : 'n/a'],
          ['Calls/s', fmt.format(m?.callsPerSec ?? 0)],
          ['Average duration', m ? `${fmt.format(m.avgMs)} ms` : 'n/a'],
        ],
        sections: [
          { label: 'Tables touched', items: r.touches.map(tableName) },
          { label: 'Running now by', items: active.filter((s) => s.routineId === p.id).map((s) => s.user) },
        ],
      };
    }
    case 'user': {
      const u = topology.users.find((x) => x.name === p.id);
      if (!u) return null;
      const s = active.find((x) => x.user === p.id) ?? sessions.find((x) => x.user === p.id);
      const target = s?.routineId ? routineName(s.routineId) : s?.tableId ? tableName(s.tableId) : undefined;
      const state = !s ? 'not connected' : s.state === 'waiting' ? 'WAITING ON A LOCK' : s.state === 'active' ? 'working' : 'connected, idle';
      return {
        kicker: u.superuser ? 'User · superuser' : 'User',
        title: u.name,
        color: u.superuser ? SUPER_COLOR : people.roleColors.get(u.roles.find((r) => people.roleColors.has(r)) ?? ''),
        rows: [
          ['Status', state],
          ['Database', s?.database || '—'],
          ['Query duration', s && s.state !== 'idle' ? `${fmt.format(s.durationMs / 1000)} s` : '—'],
          ['Working on', target ?? '—'],
        ],
        code: s && s.state !== 'idle' ? s.query : undefined,
        sections: [{ label: 'Roles', items: u.superuser ? ['superuser', ...u.roles] : u.roles }],
      };
    }
    case 'role': {
      const members = roleMembers(p.id);
      const title = p.id === '__superuser' ? 'superuser' : p.id === PUBLIC_ROLE ? 'no role' : p.id;
      return {
        kicker: 'Role · office',
        title,
        color: p.id === '__superuser' ? SUPER_COLOR : people.roleColors.get(p.id),
        rows: [
          ['Members', String(members.length)],
          ['Active now', String(members.filter((m) => active.some((s) => s.user === m)).length)],
        ],
        sections: [{ label: 'Members', items: members.map((m) => (active.some((s) => s.user === m) ? `${m} ●` : m)) }],
      };
    }
    case 'database': {
      const d = topology.databases.find((x) => x.name === p.id);
      const tables = topology.tables.filter((t) => t.database === p.id);
      const rs = topology.routines.filter((r) => r.database === p.id);
      return {
        kicker: 'Database · zone',
        title: p.id,
        rows: [
          ['Size', formatBytes(d?.sizeBytes ?? 0)],
          ['Tabelle', String(tables.length)],
          ['Procedure', String(rs.filter((r) => r.kind === 'procedure').length)],
          ['Funzioni', String(rs.filter((r) => r.kind === 'function').length)],
          ['Active sessions', String(active.filter((s) => s.database === p.id).length)],
        ],
        sections: [
          {
            label: 'Largest tables',
            items: [...tables].sort((a, b) => b.sizeBytes - a.sizeBytes).map((t) => `${t.name} · ${formatBytes(t.sizeBytes)}`),
          },
        ],
      };
    }
  }
}

function linksFor(p: Pick | null): Array<{ from: THREE.Vector3; to: THREE.Vector3; color: number }> {
  if (!p || !topology) return [];
  const out: Array<{ from: THREE.Vector3; to: THREE.Vector3; color: number }> = [];
  const push = (routineId: string, tableId: string, kind: 'procedure' | 'function') => {
    const from = routines.anchor(routineId);
    const to = datacenter.rackTop(tableId);
    if (from && to) out.push({ from, to, color: kind === 'function' ? FUNC_COLOR : PROC_COLOR });
  };
  if (p.kind === 'table') {
    for (const r of topology.routines) if (r.touches.includes(p.id)) push(r.id, p.id, r.kind);
  } else if (p.kind === 'routine') {
    const r = topology.routines.find((x) => x.id === p.id);
    if (r) for (const t of r.touches) push(r.id, t, r.kind);
  }
  return out;
}

function refreshSelection(): void {
  const content = selected ? hudContent(selected) : null;
  if (content) hud.show(content);
  else hud.hide();
}

function select(p: Pick | null): void {
  selected = p;
  datacenter.setSelected(p?.kind === 'table' ? p.id : null);
  datacenter.setSelectedIndex(p?.kind === 'index' ? p.id : null);
  routines.setSelected(p?.kind === 'routine' ? p.id : null);
  people.setSelected(p?.kind === 'user' ? p.id : null);
  people.highlight(p?.kind === 'role' ? roleMembers(p.id) : []);
  datacenter.highlightDatabase(p?.kind === 'database' ? p.id : null);
  activity.setLinks(linksFor(p));
  refreshSelection();
}
hud.onClose = () => select(null);

const ws = new WsClient();
const panel = new ConnectionPanel(
  (target) => {
    ws.send({ type: 'connect', target });
    statusBar.textContent = `[ connecting to ${target.kind}${target.host ? ` ${target.host}` : ''}... ]`;
  },
  () => ws.send({ type: 'scan' }),
);

const sqlConsole = new SqlConsole((sql) => ws.send({ type: 'exec', sql }));
const noticeBanner = new NoticeBanner((action) => ws.send({ type: 'capture', on: action === 'enableCapture' }));

const KIND_NOUN: Record<SchemaChange['kind'], string> = {
  database: 'database',
  table: 'table',
  index: 'index',
  routine: 'routine',
  user: 'user',
  role: 'role',
};

/** One pulse per query: counts from the profiler are spread over the poll interval so each one is visible. */
function schedulePulses(events: ActivityEvent[]): void {
  let budget = MAX_PULSES_PER_TICK;
  const spread = (n: number, fire: () => void) => {
    for (let i = 0; i < n && budget > 0; i++, budget--) later(i === 0 ? 0 : Math.random() * SPREAD_MS, fire);
  };

  for (const e of events.slice(0, 120)) {
    if (e.kind === 'table') {
      const op = e.op === 'write' ? 'write' : 'read';
      // Reads count scans (≈ queries); writes count rows, so they are compressed.
      const n = Math.min(12, op === 'write' ? Math.ceil(Math.sqrt(e.count)) : Math.ceil(e.count));
      spread(n, () => activity.queryPulse(e.id, op, e.lockWait));
    } else if (e.kind === 'index') {
      spread(Math.min(5, Math.ceil(e.count)), () => datacenter.flashIndex(e.id));
    } else {
      const r = routines.routine(e.id);
      if (!r) continue;
      spread(Math.min(4, Math.ceil(e.count)), () => {
        routines.flash(e.id);
        const from = routines.anchor(e.id);
        for (const t of r.touches) {
          const to = datacenter.rackTop(t);
          if (!from || !to) continue;
          activity.arc(from, to, r.kind === 'function' ? FUNC_COLOR : PROC_COLOR);
          later(900, () => datacenter.pulse(t, 0.3, false));
        }
      });
    }
  }
}

let seenQueries = new Set<string>();
let firstTick = true;

/** New statements from other sessions, as they start. */
function feedSessions(list: SessionInfo[]): void {
  const now = new Set<string>();
  let added = 0;
  for (const s of list) {
    if (s.state === 'idle' || !s.query) continue;
    const key = `${s.id}|${s.query}`;
    now.add(key);
    if (firstTick || seenQueries.has(key) || s.user === YOU || added >= 3) continue;
    added++;
    const tag: FeedTag = s.state === 'waiting' ? 'LOCK' : s.routineId ? 'CALL' : isWrite(s.query) ? 'WRITE' : 'READ';
    feed.add(tag, `${s.user}  ${s.query.replace(/\s+/g, ' ')}`);
  }
  seenQueries = now;
  firstTick = false;
}

function feedChanges(changes: SchemaChange[]): void {
  for (const c of changes.slice(0, 8)) {
    feed.add(c.action === 'created' ? 'CREATE' : 'DROP', `${KIND_NOUN[c.kind]} ${c.label} ${c.action === 'created' ? 'created' : 'dropped'}`);
  }
  if (changes.length > 8) feed.add('SQL', `…and ${changes.length - 8} more changes`);
}

ws.onMessage((msg) => {
  if (msg.type === 'scanResult') {
    panel.showScanResults(msg.results);
  } else if (msg.type === 'topology') {
    const diff = applyTopology(msg.topology);
    for (const c of diff.created) activity.ring(c.cx, c.z, c.w, OP_COLOR.ddl, true);
    for (const d of diff.dropped) activity.ring(d.cx, d.z, d.w, 0xff5a5a, true);
    statusBar.textContent = `[ online — ${msg.topology.server} ]`;
    panel.collapse();
  } else if (msg.type === 'preset') {
    // The server was started with a database on the command line and is already connecting to it.
    statusBar.textContent = `[ connecting to ${msg.label}... ]`;
    panel.collapse();
  } else if (msg.type === 'notice') {
    noticeBanner.show(msg.notice);
  } else if (msg.type === 'changes') {
    feedChanges(msg.changes);
  } else if (msg.type === 'execResult') {
    sqlConsole.showResult(msg.result);
    feed.add(msg.result.ok ? 'SQL' : 'ERR', msg.result.ok ? `${YOU}  ${msg.result.message}` : msg.result.message);
  } else if (msg.type === 'tick') {
    metrics = msg.metrics;
    sessions = msg.sessions;
    datacenter.applyMetrics(metrics);
    routines.applyMetrics(metrics);
    people.applySessions(sessions, resolveTarget);
    schedulePulses(msg.events);
    feedSessions(sessions);

    if (topology) legend.update(topology, sessions, people.overflow, metrics);
    refreshSelection();
  } else if (msg.type === 'error') {
    statusBar.textContent = `[ error: ${msg.message} ]`;
    panel.expand();
  }
});
ws.connect();

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pickAt(clientX: number, clientY: number): Pick | null {
  pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const targets = [...people.hitTargets, ...routines.hitTargets, ...datacenter.hitTargets];
  for (const hit of raycaster.intersectObjects(targets, false)) {
    const data = hit.object.userData as Partial<Pick>;
    if (data.kind && data.id) return { kind: data.kind, id: data.id };
  }
  return null;
}

let hovered: Pick | null = null;
renderer.domElement.addEventListener('pointermove', (event) => {
  const p = pickAt(event.clientX, event.clientY);
  if (p?.kind === hovered?.kind && p?.id === hovered?.id) return;
  hovered = p;
  datacenter.setHovered(p?.kind === 'table' ? p.id : null);
  datacenter.setHoveredIndex(p?.kind === 'index' ? p.id : null);
  routines.setHovered(p?.kind === 'routine' ? p.id : null);
  people.setHovered(p?.kind === 'user' ? p.id : null);
  renderer.domElement.style.cursor = p ? 'pointer' : 'grab';
});

let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('click', (event) => {
  if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
  select(pickAt(event.clientX, event.clientY));
});

const clock = new THREE.Clock();
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const elapsed = clock.elapsedTime;
  rig.update();
  postfx.setFocus(rig.distance());
  runPending(performance.now());
  datacenter.tick(dt, elapsed);
  routines.tick(dt);
  people.tick(dt, performance.now(), elapsed, (from, to, color) => activity.bolt(from, to, color));
  activity.tick(dt, elapsed);
  postfx.render();
}
animate();
