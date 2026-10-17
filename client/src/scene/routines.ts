import * as THREE from 'three';
import type { Metrics, RoutineInfo, Topology } from '../../../shared/types';
import { M, UNIT_PLANE, block, chair, placed } from './furniture';
import { disposeLabel, makeLabel } from './labels';
import { mergeStatic } from './merge';
import { ROUTINE_SEATS, nearestDoor, type P, type Seat } from './rooms';

export const PROC_COLOR = 0x3dff8c;
export const FUNC_COLOR = 0x3dd6ff;
const HISTORY = 24;

interface Desk {
  routine: RoutineInfo | null;
  seat: Seat;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  screen: THREE.Mesh;
  beam: THREE.Mesh;
  outline: THREE.LineSegments;
  label: THREE.Sprite | null;
  anchor: THREE.Vector3;
  flash: number;
  calls: number;
  rate: number;
  avgMs: number;
  history: number[];
  dirty: boolean;
  overflow: number;
}

const BEAM_GEOM = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true);

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Monitor center height and how the screen faces for a given seat rotation. */
function screenPose(seat: Seat): { pos: THREE.Vector3; rotY: number } {
  const facing = new THREE.Vector3(Math.sin(seat.rot), 0, Math.cos(seat.rot));
  const pos = new THREE.Vector3(seat.desk.x, 1.13, seat.desk.z).addScaledVector(facing, -0.21);
  return { pos, rotY: seat.rot };
}

/** Stored procedures (control room) and functions (ops/analytics rooms) as staffed workstations. */
export class RoutineFloor {
  private group = new THREE.Group();
  private furniture = new THREE.Group();
  private desks = new Map<string, Desk>();
  private extras: Desk[] = [];
  private key = '';
  private built = false;
  private targets: THREE.Object3D[] = [];
  private hovered: string | null = null;
  private selected: string | null = null;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  setTopology(topology: Topology): boolean {
    const sort = (a: RoutineInfo, b: RoutineInfo) => a.database.localeCompare(b.database) || a.name.localeCompare(b.name);
    const procs = topology.routines.filter((r) => r.kind === 'procedure').sort(sort);
    const funcs = topology.routines.filter((r) => r.kind === 'function').sort(sort);
    const key = JSON.stringify([procs.map((r) => r.id), funcs.map((r) => r.id)]);
    if (key === this.key) {
      for (const r of topology.routines) {
        const d = this.desks.get(r.id);
        if (d) d.routine = r;
      }
      return false;
    }
    this.key = key;
    const before = new Set(this.desks.keys());
    const hadBuilt = this.built;
    this.built = true;
    this.clear();

    this.place(procs, ROUTINE_SEATS.procedure);
    this.place(funcs, ROUTINE_SEATS.function);
    mergeStatic(this.furniture);
    this.group.add(this.furniture);

    // A routine created while we watch: its beam stays on a little longer.
    if (hadBuilt) {
      for (const [id, d] of this.desks) {
        if (before.has(id)) continue;
        d.flash = 2.2;
        d.dirty = true;
      }
    }

    this.targets = [...this.desks.values()].map((d) => d.screen);
    return true;
  }

  private place(routines: RoutineInfo[], seats: Seat[]): void {
    const fits = routines.length <= seats.length;
    const shown = fits ? routines : routines.slice(0, seats.length - 1);
    shown.forEach((r, i) => this.desks.set(r.id, this.buildDesk(seats[i], r, 0)));
    if (!fits) this.extras.push(this.buildDesk(seats[seats.length - 1], null, routines.length - shown.length));
  }

  private buildDesk(seat: Seat, routine: RoutineInfo | null, overflow: number): Desk {
    const g = placed(this.furniture, seat.desk.x, seat.desk.z, seat.rot);
    block(g, M.desk, 1.1, 0.05, 0.75, 0, 0.72, 0);
    block(g, M.dark, 0.05, 0.72, 0.7, -0.51, 0, 0);
    block(g, M.dark, 0.05, 0.72, 0.7, 0.51, 0, 0);
    block(g, M.dark, 0.05, 0.1, 0.05, 0, 0.77, -0.22);
    block(g, M.dark, 0.78, 0.5, 0.03, 0, 0.87, -0.24);
    chair(g, 0, 0.75, 0);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.2, 1.2, 1.2) }));
    const pose = screenPose(seat);
    screen.position.copy(pose.pos);
    screen.rotation.y = pose.rotY;
    screen.scale.set(0.74, 0.46, 1);
    screen.userData = routine ? { kind: 'routine', id: routine.id } : {};
    this.group.add(screen);

    const color = routine?.kind === 'function' ? FUNC_COLOR : PROC_COLOR;
    const beam = new THREE.Mesh(
      BEAM_GEOM,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0, depthWrite: false }),
    );
    beam.scale.set(1, 2.4, 1);
    beam.position.set(pose.pos.x, 1.4 + 1.2, pose.pos.z);
    this.group.add(beam);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.82, 0.54, 0.06)),
      new THREE.LineBasicMaterial({ color: 0xd8ffe8 }),
    );
    outline.position.copy(pose.pos);
    outline.rotation.y = pose.rotY;
    outline.visible = false;
    this.group.add(outline);

    let label: THREE.Sprite | null = null;
    if (routine) {
      label = makeLabel(`${routine.kind === 'procedure' ? 'SP' : 'FN'} ${routine.name}`, {
        sub: `${routine.database}${routine.schema ? `.${routine.schema}` : ''} · ${routine.touches.length} table${routine.touches.length === 1 ? '' : 's'}`,
        color: routine.kind === 'function' ? '#3dd6ff' : '#3dff8c',
        visible: false,
      });
      label.position.set(pose.pos.x, 2.2, pose.pos.z);
      this.group.add(label);
    }

    const desk: Desk = {
      routine,
      seat,
      canvas,
      ctx,
      texture,
      screen,
      beam,
      outline,
      label,
      anchor: pose.pos.clone().setY(1.4),
      flash: 0,
      calls: 0,
      rate: 0,
      avgMs: 0,
      history: new Array(HISTORY).fill(0),
      dirty: true,
      overflow,
    };
    this.draw(desk);
    return desk;
  }

  private draw(d: Desk): void {
    const { ctx } = d;
    const isFn = d.routine?.kind === 'function';
    const base = isFn ? [61, 214, 255] : [61, 255, 140];
    const col = (a: number) => `rgba(${base[0]},${base[1]},${base[2]},${a})`;
    ctx.fillStyle = isFn ? '#04121a' : '#04140b';
    ctx.fillRect(0, 0, 256, 160);
    ctx.strokeStyle = d.flash > 0.05 ? `rgba(255,255,255,${0.5 + d.flash / 2})` : col(0.85);
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, 250, 154);

    if (!d.routine) {
      ctx.fillStyle = col(0.9);
      ctx.font = '600 44px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`+${d.overflow}`, 128, 92);
      ctx.font = '18px Consolas, monospace';
      ctx.fillText('routines not shown', 128, 124);
      ctx.textAlign = 'left';
      d.texture.needsUpdate = true;
      return;
    }

    ctx.fillStyle = col(0.95);
    ctx.fillRect(12, 12, 44, 26);
    ctx.fillStyle = '#04140b';
    ctx.font = '700 18px Consolas, monospace';
    ctx.fillText(isFn ? 'FN' : 'SP', 20, 31);

    ctx.fillStyle = col(0.75);
    ctx.font = '16px Consolas, monospace';
    ctx.fillText(d.routine.database.slice(0, 16), 66, 31);

    const name = d.routine.name;
    ctx.fillStyle = col(1);
    ctx.font = '600 24px Consolas, monospace';
    ctx.fillText(name.slice(0, 17), 12, 66);
    if (name.length > 17) ctx.fillText(name.slice(17, 33), 12, 92);

    const max = Math.max(1, ...d.history);
    ctx.strokeStyle = col(0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    d.history.forEach((v, i) => {
      const x = 12 + (i * 120) / (HISTORY - 1);
      const y = 146 - (v / max) * 34;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.fillStyle = col(1);
    ctx.font = '700 32px Consolas, monospace';
    ctx.fillText(formatCount(d.calls), 244, 136);
    ctx.font = '14px Consolas, monospace';
    ctx.fillStyle = col(0.7);
    ctx.fillText('calls', 244, 152);
    ctx.textAlign = 'left';
    d.texture.needsUpdate = true;
  }

  private clear(): void {
    for (const d of [...this.desks.values(), ...this.extras]) {
      d.texture.dispose();
      (d.screen.material as THREE.Material).dispose();
      (d.beam.material as THREE.Material).dispose();
      d.outline.geometry.dispose();
      if (d.label) disposeLabel(d.label);
    }
    this.group.clear();
    this.furniture = new THREE.Group();
    this.desks.clear();
    this.extras = [];
  }

  get hitTargets(): THREE.Object3D[] {
    return this.targets;
  }

  has(id: string): boolean {
    return this.desks.has(id);
  }

  routine(id: string): RoutineInfo | null {
    return this.desks.get(id)?.routine ?? null;
  }

  anchor(id: string): THREE.Vector3 | null {
    return this.desks.get(id)?.anchor.clone() ?? null;
  }

  deskPoint(id: string): P | null {
    const d = this.desks.get(id);
    return d ? d.seat.desk : null;
  }

  /** Spot by the workstation; `slot` > 0 lines extra visitors up behind the chair. */
  standPoint(id: string, slot = 0): P | null {
    const d = this.desks.get(id);
    if (!d) return null;
    const dir = { x: Math.sin(d.seat.rot), z: Math.cos(d.seat.rot) };
    const back = slot * 0.55;
    return { x: d.seat.chair.x + dir.x * back, z: d.seat.chair.z + dir.z * back };
  }

  /** Seat ↔ door links for the nav graph. */
  navLinks(): Array<[P, P]> {
    return [...this.desks.values()].map((d) => [d.seat.chair, nearestDoor(d.seat.room, d.seat.chair)]);
  }

  setHovered(id: string | null): void {
    this.hovered = id;
    this.applyHighlight();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.applyHighlight();
  }

  private applyHighlight(): void {
    for (const [id, d] of this.desks) {
      const on = id === this.hovered || id === this.selected;
      d.outline.visible = on;
      if (d.label) d.label.visible = on;
    }
  }

  applyMetrics(metrics: Metrics): void {
    for (const [id, d] of this.desks) {
      const m = metrics.routines[id];
      if (!m) continue;
      if (m.calls !== d.calls || m.callsPerSec !== d.rate) d.dirty = true;
      d.calls = m.calls;
      d.rate = m.callsPerSec;
      d.avgMs = m.avgMs;
      d.history.push(m.callsPerSec);
      d.history.shift();
    }
  }

  stats(id: string): { calls: number; rate: number; avgMs: number } | null {
    const d = this.desks.get(id);
    return d ? { calls: d.calls, rate: d.rate, avgMs: d.avgMs } : null;
  }

  flash(id: string): void {
    const d = this.desks.get(id);
    if (!d) return;
    d.flash = 1;
    d.dirty = true;
  }

  tick(dt: number): void {
    for (const d of this.desks.values()) {
      const wasFlashing = d.flash > 0.05;
      d.flash = Math.max(0, d.flash - dt * 1.4);
      (d.beam.material as THREE.MeshBasicMaterial).opacity = Math.min(1, d.flash) * 0.85;
      if (d.dirty || (wasFlashing && d.flash <= 0.05)) {
        this.draw(d);
        d.dirty = false;
      }
    }
  }
}
