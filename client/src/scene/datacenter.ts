import * as THREE from 'three';
import type { IndexInfo, Metrics, TableInfo, Topology } from '../../../shared/types';
import { COLORS } from './palette';
import { rackTextures } from './textures';
import { UNIT_BOX } from './furniture';
import { disposeLabel, makeLabel } from './labels';
import { CAB_D, CAB_W, layoutHall, type BlockLayout, type HallLayout, type Rect, type RackPlacement } from './layout';
import type { P } from './rooms';

export type QueryOp = 'read' | 'write' | 'ddl';

/** Flash/ring color of each kind of statement. */
export const OP_COLOR: Record<QueryOp, number> = { read: COLORS.green, write: 0xffd23d, ddl: 0x9ff3ff };

export const INDEX_COLORS = { primary: '#ffc23d', unique: '#c77dff', plain: '#5aa0ff', dead: '#7a8a92' } as const;
const SLAB_HEX = { primary: 0xffc23d, unique: 0xc77dff, plain: 0x5aa0ff, dead: 0x56626a };

const STRIP_Y = 2.92;
const GREEN = new THREE.Color(COLORS.green);
const AMBER = new THREE.Color(0xffb43d);
const RED = new THREE.Color(COLORS.red);
const WHITE = new THREE.Color(0xffffff);
const STRIP_BASE = GREEN.clone();
const STAND_SLOTS = [0, -0.55, 0.55, -1.1, 1.1];
const MAX_SLABS = 6;
const SLAB_H = 0.12;
const SLAB_GAP = 0.08;
const SPAWN_SECONDS = 0.9;
const GHOST_SECONDS = 0.75;

export interface RackSpot {
  id: string;
  cx: number;
  z: number;
  w: number;
}

export interface TopologyDiff {
  changed: boolean;
  created: RackSpot[];
  dropped: RackSpot[];
}

interface IndexSlab {
  info: IndexInfo;
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  known: boolean;
  scans: number;
  level: number;
  flash: number;
}

interface TableRack {
  placement: RackPlacement;
  info: TableInfo;
  indexes: IndexInfo[];
  group: THREE.Group;
  front: THREE.MeshLambertMaterial;
  outline: THREE.LineSegments;
  label: THREE.Sprite | null;
  labelKey: string;
  slabs: IndexSlab[];
  crown: number;
  load: number;
  alert: number;
  level: number;
  locks: number;
  waiting: number;
  phase: number;
  kick: number;
  flash: number;
  flashColor: THREE.Color;
  spawn: number;
}

interface Zone {
  block: BlockLayout;
  strip: THREE.MeshBasicMaterial | null;
  flash: number;
  outline: THREE.LineLoop;
  sign: THREE.Sprite;
  signSub: string;
}

interface Ghost {
  rack: TableRack;
  t: number;
}

const sideMat = new THREE.MeshLambertMaterial({ color: COLORS.cabinet });
const topMat = new THREE.MeshLambertMaterial({ color: COLORS.cabinetTop });
const slabBody = new THREE.Color(0x0d1417);

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function rectLoop(r: Rect, y: number): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(r.x0, y, r.z0),
    new THREE.Vector3(r.x1, y, r.z0),
    new THREE.Vector3(r.x1, y, r.z1),
    new THREE.Vector3(r.x0, y, r.z1),
  ]);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function slabKind(info: IndexInfo): 'primary' | 'unique' | 'plain' {
  return info.primary ? 'primary' : info.unique ? 'unique' : 'plain';
}

/** Primary keys first, then unique, then the rest by name. */
function sortIndexes(list: IndexInfo[]): IndexInfo[] {
  const rank = (i: IndexInfo) => (i.primary ? 0 : i.unique ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Central hall: one zone per database, one rack segment per table, one slab per index on top of it. */
export class Datacenter {
  private group = new THREE.Group();
  private dynamic = new THREE.Group();
  private ghostRoot = new THREE.Group();
  private tables = new Map<string, TableRack>();
  private slabIndex = new Map<string, { rack: TableRack; slab: IndexSlab }>();
  private ghosts: Ghost[] = [];
  private zones: Zone[] = [];
  private zoneByDb = new Map<string, number>();
  private key = '';
  private built = false;
  private targets: THREE.Object3D[] = [];
  private hovered: string | null = null;
  private selected: string | null = null;
  private hoveredIndex: string | null = null;
  private selectedIndex: string | null = null;
  private highlightedDb: string | null = null;
  layout: HallLayout = { blocks: [], racks: [], walkways: [] };

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.group.add(this.dynamic, this.ghostRoot);
  }

  private spot(t: TableRack): RackSpot {
    return { id: t.placement.table.id, cx: t.group.position.x, z: t.group.position.z, w: t.placement.x1 - t.placement.x0 };
  }

  private zoneSub(block: BlockLayout, sizes: Map<string, number>, indexCount: number): string {
    return `${block.tableCount} tables · ${indexCount} indexes · ${formatBytes(sizes.get(block.database) ?? 0)}${block.hidden ? ` · +${block.hidden} hidden` : ''}`;
  }

  private makeSign(block: BlockLayout, sub: string): THREE.Sprite {
    const sign = makeLabel(`DB ${block.database}`, { sub, height: 0.95 });
    sign.position.set((block.cell.x0 + block.cell.x1) / 2, 4.3, (block.cell.z0 + block.cell.z1) / 2);
    sign.userData = { kind: 'database', id: block.database };
    return sign;
  }

  /** Rebuilds the hall when its shape changes; otherwise only refreshes numbers (no flicker). */
  setTopology(topology: Topology): TopologyDiff {
    const layout = layoutHall(topology);
    const sizes = new Map(topology.databases.map((d) => [d.name, d.sizeBytes]));
    const byTable = new Map<string, IndexInfo[]>();
    for (const ix of topology.indexes) byTable.set(ix.tableId, [...(byTable.get(ix.tableId) ?? []), ix]);
    for (const [id, list] of byTable) byTable.set(id, sortIndexes(list));

    const key = JSON.stringify([
      layout.blocks.map((b) => [b.database, b.tableCount, b.hidden]),
      layout.racks.map((r) => [r.table.id, r.cabinets, r.height.toFixed(1), (byTable.get(r.table.id) ?? []).map((i) => i.id)]),
    ]);
    const indexCountOf = (block: BlockLayout) =>
      topology.indexes.filter((i) => topology.tables.find((t) => t.id === i.tableId)?.database === block.database).length;

    if (key === this.key) {
      layout.racks.forEach((p) => {
        const rack = this.tables.get(p.table.id);
        if (!rack) return;
        rack.info = p.table;
        rack.placement = { ...rack.placement, table: p.table };
        for (const slab of rack.slabs) slab.info = (byTable.get(p.table.id) ?? []).find((i) => i.id === slab.info.id) ?? slab.info;
      });
      this.zones.forEach((z) => {
        const sub = this.zoneSub(z.block, sizes, indexCountOf(z.block));
        if (sub === z.signSub) return;
        z.signSub = sub;
        z.sign.removeFromParent();
        disposeLabel(z.sign);
        z.sign = this.makeSign(z.block, sub);
        this.dynamic.add(z.sign);
      });
      this.refreshTargets();
      return { changed: false, created: [], dropped: [] };
    }
    this.key = key;
    this.layout = layout;

    const hadBuilt = this.built;
    this.built = true;
    const previous = this.tables;
    const nextIds = new Set(layout.racks.map((r) => r.table.id));
    const dropped: RackSpot[] = [];
    for (const [id, t] of previous) {
      if (nextIds.has(id)) continue;
      dropped.push(this.spot(t));
      if (hadBuilt) {
        this.dynamic.remove(t.group);
        this.ghostRoot.add(t.group);
        this.ghosts.push({ rack: t, t: 0 });
      }
    }
    const ghosted = new Set(this.ghosts.map((g) => g.rack));
    this.clear(previous, ghosted);

    layout.blocks.forEach((block) => {
      this.zoneByDb.set(block.database, block.index);
      const outline = new THREE.LineLoop(
        rectLoop({ x0: block.cell.x0 - 0.25, x1: block.cell.x1 + 0.25, z0: block.cell.z0 - 0.25, z1: block.cell.z1 + 0.25 }, 0.02),
        new THREE.LineBasicMaterial({ color: COLORS.green, transparent: true, opacity: 0.25 }),
      );
      this.dynamic.add(outline);

      let strip: THREE.MeshBasicMaterial | null = null;
      if (block.rect) {
        const r = { x0: block.rect.x0 - 0.2, x1: block.rect.x1 + 0.2, z0: block.rect.z0 - 0.2, z1: block.rect.z1 + 0.2 };
        strip = new THREE.MeshBasicMaterial({ color: STRIP_BASE.clone() });
        const midX = (r.x0 + r.x1) / 2;
        const midZ = (r.z0 + r.z1) / 2;
        for (const [x, z, sx, sz] of [
          [midX, r.z0, r.x1 - r.x0, 0.1],
          [midX, r.z1, r.x1 - r.x0, 0.1],
          [r.x0, midZ, 0.1, r.z1 - r.z0],
          [r.x1, midZ, 0.1, r.z1 - r.z0],
        ]) {
          const bar = new THREE.Mesh(UNIT_BOX, strip);
          bar.scale.set(sx, 0.06, sz);
          bar.position.set(x, STRIP_Y, z);
          this.dynamic.add(bar);
        }
      }

      const signSub = this.zoneSub(block, sizes, indexCountOf(block));
      const sign = this.makeSign(block, signSub);
      this.dynamic.add(sign);
      this.zones.push({ block, strip, flash: 0, outline, sign, signSub });
    });

    const created: RackSpot[] = [];
    layout.racks.forEach((placement, i) => {
      const old = previous.get(placement.table.id);
      const rack = this.createRack(placement, i, byTable.get(placement.table.id) ?? [], old);
      if (!old && hadBuilt) {
        rack.spawn = 0;
        rack.flash = 1;
        rack.flashColor.set(OP_COLOR.ddl);
        created.push(this.spot(rack));
      }
      this.tables.set(placement.table.id, rack);
    });

    this.refreshTargets();
    this.applyHighlight();
    return { changed: true, created, dropped };
  }

  private refreshTargets(): void {
    this.targets = [
      ...[...this.tables.values()].flatMap((t) => [
        ...t.group.children.filter((c) => (c as THREE.Mesh).isMesh && c.userData.kind === 'table'),
        ...t.slabs.map((s) => s.mesh),
      ]),
      ...this.zones.map((z) => z.sign),
    ];
  }

  private clear(previous: Map<string, TableRack>, keep: Set<TableRack>): void {
    for (const t of previous.values()) if (!keep.has(t)) this.disposeRack(t);
    for (const z of this.zones) {
      z.strip?.dispose();
      z.outline.geometry.dispose();
      disposeLabel(z.sign);
    }
    this.dynamic.clear();
    this.tables = new Map();
    this.slabIndex.clear();
    this.zones = [];
    this.zoneByDb.clear();
  }

  private disposeRack(t: TableRack): void {
    t.front.dispose();
    t.outline.geometry.dispose();
    if (t.label) disposeLabel(t.label);
    for (const s of t.slabs) s.mat.dispose();
  }

  private createRack(p: RackPlacement, index: number, indexes: IndexInfo[], old?: TableRack): TableRack {
    const cx = (p.x0 + p.x1) / 2;
    const group = new THREE.Group();
    group.position.set(cx, 0, p.z);

    const tex = rackTextures(index);
    const front = new THREE.MeshLambertMaterial({ map: tex.map, emissiveMap: tex.led, emissive: GREEN.clone(), emissiveIntensity: 1 });
    const mats = [sideMat, sideMat, topMat, sideMat, front, front];
    for (let k = 0; k < p.cabinets; k++) {
      const m = new THREE.Mesh(UNIT_BOX, mats);
      m.scale.set(CAB_W - 0.03, p.height, CAB_D);
      m.position.set(p.x0 + CAB_W * (k + 0.5) - cx, p.height / 2, 0);
      m.userData = { kind: 'table', id: p.table.id };
      group.add(m);
    }

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(p.x1 - p.x0 + 0.08, p.height + 0.08, CAB_D + 0.08)),
      new THREE.LineBasicMaterial({ color: 0xd8ffe8 }),
    );
    outline.position.set(0, p.height / 2, 0);
    outline.visible = false;
    group.add(outline);

    const rack: TableRack = {
      placement: p,
      info: p.table,
      indexes,
      group,
      front,
      outline,
      label: null,
      labelKey: '',
      slabs: [],
      crown: 0,
      load: old?.load ?? 0,
      alert: old?.alert ?? 0,
      level: old?.level ?? 0,
      locks: old?.locks ?? 0,
      waiting: old?.waiting ?? 0,
      phase: Math.random() * 10,
      kick: 0,
      flash: 0,
      flashColor: new THREE.Color(OP_COLOR.read),
      spawn: 1,
    };

    const width = Math.max(0.5, p.x1 - p.x0 - 0.16);
    indexes.slice(0, MAX_SLABS).forEach((info, i) => {
      const mat = new THREE.MeshLambertMaterial({ color: slabBody, emissive: new THREE.Color(SLAB_HEX[slabKind(info)]), emissiveIntensity: 0.6 });
      const mesh = new THREE.Mesh(UNIT_BOX, mat);
      mesh.scale.set(width, SLAB_H, CAB_D * 0.62);
      mesh.position.set(0, p.height + 0.07 + i * (SLAB_H + SLAB_GAP) + SLAB_H / 2, 0);
      mesh.userData = { kind: 'index', id: info.id };
      group.add(mesh);
      const slab: IndexSlab = { info, mesh, mat, known: false, scans: 0, level: 0, flash: 0 };
      rack.slabs.push(slab);
      this.slabIndex.set(info.id, { rack, slab });
    });
    rack.crown = rack.slabs.length * (SLAB_H + SLAB_GAP);

    this.dynamic.add(group);
    return rack;
  }

  get hitTargets(): THREE.Object3D[] {
    return this.targets;
  }

  has(id: string): boolean {
    return this.tables.has(id);
  }

  setHovered(id: string | null): void {
    this.hovered = id;
    this.applyHighlight();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.applyHighlight();
  }

  setHoveredIndex(id: string | null): void {
    this.hoveredIndex = id;
    this.applyHighlight();
  }

  setSelectedIndex(id: string | null): void {
    this.selectedIndex = id;
    this.applyHighlight();
  }

  highlightDatabase(db: string | null): void {
    this.highlightedDb = db;
    this.zones.forEach((z, i) => {
      const on = this.zoneByDb.get(db ?? '') === i;
      (z.outline.material as THREE.LineBasicMaterial).opacity = on ? 0.9 : 0.25;
    });
  }

  private ensureLabel(t: TableRack): void {
    const key = `${t.info.rowCount}|${t.info.sizeBytes}|${t.indexes.length}`;
    if (t.label && t.labelKey === key) return;
    if (t.label) {
      t.group.remove(t.label);
      disposeLabel(t.label);
    }
    const sub = `${t.info.rowCount.toLocaleString('en-US')} rows · ${formatBytes(t.info.sizeBytes)} · ${t.indexes.length} indexes`;
    t.label = makeLabel(t.info.name, { sub });
    t.label.position.set(0, t.placement.height + t.crown + 1.0, 0);
    t.group.add(t.label);
    t.labelKey = key;
  }

  private applyHighlight(): void {
    for (const t of this.tables.values()) {
      const id = t.placement.table.id;
      const viaIndex = t.slabs.some((s) => s.info.id === this.hoveredIndex || s.info.id === this.selectedIndex);
      const outlined = id === this.hovered || id === this.selected;
      t.outline.visible = outlined;
      if (outlined || viaIndex) {
        this.ensureLabel(t);
        t.label!.visible = true;
      } else if (t.label) {
        t.label.visible = false;
      }
    }
    if (this.highlightedDb) this.highlightDatabase(this.highlightedDb);
  }

  applyMetrics(metrics: Metrics): void {
    for (const [id, t] of this.tables) {
      const m = metrics.tables[id];
      t.level = m ? Math.min(1, Math.log10(1 + m.readsPerSec + m.writesPerSec) / 2) : 0;
      t.locks = m?.locks ?? 0;
      t.waiting = m?.waiting ?? 0;
      for (const slab of t.slabs) {
        const im = metrics.indexes[slab.info.id];
        slab.known = Boolean(im);
        slab.scans = im?.scans ?? 0;
        slab.level = im ? Math.min(1, Math.log10(1 + im.scansPerSec) / 1.5) : 0;
      }
    }
  }

  /** Smooth glow, e.g. when a routine reaches this table. */
  pulse(id: string, intensity: number, alert: boolean): void {
    const t = this.tables.get(id);
    if (!t) return;
    t.load = Math.min(1, t.load + intensity);
    if (alert) t.alert = 1;
  }

  /** One discrete query: the rack kicks and flashes in the statement's color. Returns where, for the floor ring. */
  queryPulse(id: string, op: QueryOp, alert: boolean): RackSpot | null {
    const t = this.tables.get(id);
    if (!t) return null;
    t.kick = 1;
    t.flash = 1;
    t.flashColor.set(OP_COLOR[op]);
    if (alert) t.alert = 1;
    const zone = this.zones[t.placement.block];
    if (zone) zone.flash = Math.min(1, zone.flash + 0.35);
    return this.spot(t);
  }

  flashIndex(id: string): void {
    const hit = this.slabIndex.get(id);
    if (hit) hit.slab.flash = 1;
  }

  /** Light-strip rectangle over the table's zone and the perimeter position closest to the rack. */
  stripFor(id: string): { rect: Rect & { y: number }; start: number } | null {
    const t = this.tables.get(id);
    const rect = t ? this.layout.blocks[t.placement.block]?.rect : null;
    if (!t || !rect) return null;
    const r = { x0: rect.x0 - 0.2, x1: rect.x1 + 0.2, z0: rect.z0 - 0.2, z1: rect.z1 + 0.2, y: STRIP_Y };
    const cx = (t.placement.x0 + t.placement.x1) / 2;
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const start = t.placement.z - r.z0 < r.z1 - t.placement.z ? cx - r.x0 : w + d + (r.x1 - cx);
    return { rect: r, start };
  }

  rackTop(id: string): THREE.Vector3 | null {
    const t = this.tables.get(id);
    if (!t) return null;
    return new THREE.Vector3((t.placement.x0 + t.placement.x1) / 2, t.placement.height, t.placement.z);
  }

  rackCenter(id: string): P | null {
    const t = this.tables.get(id);
    return t ? { x: (t.placement.x0 + t.placement.x1) / 2, z: t.placement.z } : null;
  }

  /** Spot in the aisle in front of the rack; `slot` spreads several visitors along it. */
  standPoint(id: string, slot = 0): P | null {
    const t = this.tables.get(id);
    if (!t) return null;
    const p = t.placement;
    const half = Math.max(0, (p.x1 - p.x0) / 2 - 0.25);
    const offset = Math.max(-half, Math.min(half, STAND_SLOTS[slot % STAND_SLOTS.length]));
    return { x: Math.round(((p.x0 + p.x1) / 2 + offset) * 100) / 100, z: p.standZ };
  }

  allStandPoints(): P[] {
    const pts: P[] = [];
    for (const id of this.tables.keys()) for (let s = 0; s < STAND_SLOTS.length; s++) pts.push(this.standPoint(id, s)!);
    return pts;
  }

  tick(dt: number, elapsed: number): void {
    for (const t of this.tables.values()) {
      t.load = Math.max(0, t.load - dt * 0.6);
      t.alert = Math.max(0, t.alert - dt * 0.6);
      t.flash = Math.max(0, t.flash - dt * 3.2);
      t.kick = Math.max(0, t.kick - dt * 4.5);
      if (t.spawn < 1) t.spawn = Math.min(1, t.spawn + dt / SPAWN_SECONDS);

      const rise = t.spawn < 1 ? Math.max(0.001, easeOutBack(t.spawn)) : 1;
      t.group.scale.set(1 + t.kick * 0.03, rise * (1 + t.kick * 0.07), 1 + t.kick * 0.03);

      const flicker = 0.12 * Math.sin(elapsed * 9 + t.phase) + (Math.random() < 0.03 ? 0.3 : 0);
      t.front.emissiveIntensity = 0.7 + t.level * 1.4 + t.load * 2.4 + flicker + t.flash * 3.4;
      const danger = Math.max(t.alert, t.waiting > 0 ? 0.6 + 0.4 * Math.sin(elapsed * 8) : 0);
      t.front.emissive.copy(GREEN).lerp(AMBER, t.locks > 0 ? 0.55 : 0).lerp(RED, danger).lerp(t.flashColor, Math.min(1, t.flash * 1.2));

      for (const slab of t.slabs) {
        slab.flash = Math.max(0, slab.flash - dt * 2.6);
        const kind = slabKind(slab.info);
        const dead = slab.known && slab.scans === 0;
        const boost = slab.info.id === this.hoveredIndex || slab.info.id === this.selectedIndex ? 1.1 : 0;
        slab.mat.emissive.set(dead ? SLAB_HEX.dead : SLAB_HEX[kind]).lerp(WHITE, Math.min(1, slab.flash * 0.7));
        slab.mat.emissiveIntensity = (dead ? 0.35 : 0.65) + slab.level * 1.1 + slab.flash * 3 + boost;
      }
    }

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t += dt / GHOST_SECONDS;
      g.rack.group.scale.set(1 + (1 - g.t) * 0.02, Math.max(0.001, 1 - g.t * g.t), 1);
      g.rack.front.emissive.copy(RED);
      g.rack.front.emissiveIntensity = 2.6 * (1 - g.t) + 0.4;
      if (g.t >= 1) {
        this.ghostRoot.remove(g.rack.group);
        this.disposeRack(g.rack);
        this.ghosts.splice(i, 1);
      }
    }

    this.zones.forEach((z) => {
      z.flash = Math.max(0, z.flash - dt * 1.2);
      z.strip?.color.copy(STRIP_BASE).multiplyScalar(1 + z.flash * 1.2);
    });
  }
}
