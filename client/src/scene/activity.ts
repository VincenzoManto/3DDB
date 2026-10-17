import * as THREE from 'three';
import { COLORS } from './palette';
import { OP_COLOR, type Datacenter, type QueryOp } from './datacenter';
import type { Rect } from './layout';

type StripRect = Rect & { y: number };

const DOT = new THREE.BoxGeometry(0.15, 0.15, 0.15);
const RING = new THREE.RingGeometry(0.92, 1, 56);
const RED = new THREE.Color(COLORS.red);
const RING_LIFE = 0.8;
const RISE_TIME = 0.3;
const RUN_TIME = 1.3;
const SPEED = 5.5;
const MAX_ITEMS = 260;

interface StripPacket {
  kind: 'strip';
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  rect: StripRect;
  start: number;
  dir: 1 | -1;
  t: number;
}

interface Arc {
  kind: 'arc';
  line: THREE.Line;
  lineMat: THREE.LineBasicMaterial;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  curve: THREE.QuadraticBezierCurve3;
  t: number;
  life: number;
}

interface Bolt {
  kind: 'bolt';
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

interface Ring {
  kind: 'ring';
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  w: number;
  big: boolean;
  t: number;
}

type Item = StripPacket | Arc | Bolt | Ring;

interface Link {
  line: THREE.Line;
  lineMat: THREE.LineBasicMaterial;
  dots: THREE.Mesh[];
  dotMat: THREE.MeshBasicMaterial;
  curve: THREE.QuadraticBezierCurve3;
}

function perimeterPoint(r: StripRect, s: number, out: THREE.Vector3): THREE.Vector3 {
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const p = 2 * (w + d);
  s = ((s % p) + p) % p;
  if (s < w) return out.set(r.x0 + s, r.y, r.z0);
  if (s < w + d) return out.set(r.x1, r.y, r.z0 + (s - w));
  if (s < 2 * w + d) return out.set(r.x1 - (s - w - d), r.y, r.z1);
  return out.set(r.x0, r.y, r.z1 - (s - 2 * w - d));
}

function arcCurve(from: THREE.Vector3, to: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const mid = from.clone().lerp(to, 0.5);
  mid.y = Math.max(from.y, to.y) + 1.5 + from.distanceTo(to) * 0.18;
  return new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
}

/** Everything that moves: strip packets, routine→table arcs, user→target bolts, selection links. */
export class ActivityFx {
  private group = new THREE.Group();
  private items: Item[] = [];
  private links: Link[] = [];
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, private datacenter: Datacenter) {
    scene.add(this.group);
  }

  private material(color: THREE.Color, boost = 2.6): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(boost), transparent: true });
  }

  /**
   * One query on a table: the rack kicks and flashes, a ring spreads on the floor, and a packet climbs
   * to the zone's light strip and races along it. `op` picks the color (read / write / schema change).
   */
  queryPulse(id: string, op: QueryOp, alert: boolean): void {
    const spot = this.datacenter.queryPulse(id, op, alert);
    if (!spot) return;
    const color = new THREE.Color(alert ? COLORS.red : OP_COLOR[op]);
    this.ring(spot.cx, spot.z, spot.w, color, false);

    const strip = this.datacenter.stripFor(id);
    const top = this.datacenter.rackTop(id);
    if (!strip || !top || this.items.length >= MAX_ITEMS) return;
    const mat = this.material(color);
    const mesh = new THREE.Mesh(DOT, mat);
    mesh.position.copy(top);
    this.group.add(mesh);
    this.items.push({ kind: 'strip', mesh, mat, from: top.clone(), rect: strip.rect, start: strip.start, dir: Math.random() < 0.5 ? 1 : -1, t: 0 });
  }

  /** Expanding ellipse on the floor around a rack (queries, new/dropped objects). */
  ring(cx: number, z: number, w: number, color: THREE.ColorRepresentation, big: boolean): void {
    if (this.items.length >= MAX_ITEMS) return;
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(2.2),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(RING, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0.05, z);
    mesh.scale.set(w / 2 + 0.3, 0.9, 1);
    this.group.add(mesh);
    this.items.push({ kind: 'ring', mesh, mat, w, big, t: 0 });
  }

  /** A routine call reaching one of the tables it touches. */
  arc(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation): void {
    if (this.items.length >= MAX_ITEMS) return;
    const c = new THREE.Color(color);
    const curve = arcCurve(from, to);
    const lineMat = new THREE.LineBasicMaterial({ color: c.clone().multiplyScalar(1.6), transparent: true, opacity: 0.9 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), lineMat);
    const mat = this.material(c, 3);
    const mesh = new THREE.Mesh(DOT, mat);
    mesh.position.copy(from);
    this.group.add(line, mesh);
    this.items.push({ kind: 'arc', line, lineMat, mesh, mat, curve, t: 0, life: 1.6 });
  }

  /** Short straight packet, e.g. a person typing a query into a rack. */
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    if (this.items.length >= MAX_ITEMS) return;
    const mat = this.material(color, 2.2);
    const mesh = new THREE.Mesh(DOT, mat);
    mesh.scale.setScalar(0.7);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.items.push({ kind: 'bolt', mesh, mat, from: from.clone(), to: to.clone(), t: 0 });
  }

  /** Persistent dependency links for the current selection. */
  setLinks(links: Array<{ from: THREE.Vector3; to: THREE.Vector3; color: THREE.ColorRepresentation }>): void {
    for (const l of this.links) {
      this.group.remove(l.line, ...l.dots);
      l.line.geometry.dispose();
      l.lineMat.dispose();
      l.dotMat.dispose();
    }
    this.links = links.map(({ from, to, color }) => {
      const c = new THREE.Color(color);
      const curve = arcCurve(from, to);
      const lineMat = new THREE.LineBasicMaterial({ color: c.clone().multiplyScalar(1.3), transparent: true, opacity: 0.55 });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), lineMat);
      const dotMat = this.material(c, 2.2);
      const dots = [0, 1, 2].map(() => new THREE.Mesh(DOT, dotMat));
      this.group.add(line, ...dots);
      return { line, lineMat, dots, dotMat, curve };
    });
  }

  tick(dt: number, elapsed: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      let done = false;
      if (it.kind === 'strip') {
        if (it.t < 0) continue;
        if (it.t < RISE_TIME) {
          perimeterPoint(it.rect, it.start, this.tmp);
          it.mesh.position.lerpVectors(it.from, this.tmp, it.t / RISE_TIME);
        } else {
          const run = it.t - RISE_TIME;
          perimeterPoint(it.rect, it.start + it.dir * run * SPEED, it.mesh.position);
          it.mat.opacity = run > RUN_TIME * 0.6 ? Math.max(0, 1 - (run - RUN_TIME * 0.6) / (RUN_TIME * 0.4)) : 1;
        }
        done = it.t >= RISE_TIME + RUN_TIME;
      } else if (it.kind === 'arc') {
        const travel = it.life * 0.55;
        it.mesh.position.copy(it.curve.getPoint(Math.min(1, it.t / travel)));
        const fade = Math.max(0, (it.t - travel) / (it.life - travel));
        it.lineMat.opacity = 0.9 * (1 - fade);
        it.mat.opacity = 1 - fade;
        done = it.t >= it.life;
      } else if (it.kind === 'ring') {
        const k = Math.min(1, it.t / RING_LIFE);
        const eased = 1 - (1 - k) ** 2;
        const reach = it.big ? 3.2 : 1.5;
        // The mesh is a unit ring lying on the floor; scale.y maps to world z after the -90° tilt.
        it.mesh.scale.set(it.w / 2 + 0.3 + eased * reach, 0.9 + eased * reach * 0.8, 1);
        it.mat.opacity = 0.9 * (1 - k);
        done = k >= 1;
      } else {
        const k = Math.min(1, it.t / 0.45);
        it.mesh.position.lerpVectors(it.from, it.to, k);
        it.mat.opacity = 1 - k * 0.6;
        done = k >= 1;
      }
      if (done) {
        this.group.remove(it.mesh);
        it.mat.dispose();
        if (it.kind === 'arc') {
          this.group.remove(it.line);
          it.line.geometry.dispose();
          it.lineMat.dispose();
        }
        this.items.splice(i, 1);
      }
    }

    for (const l of this.links) {
      l.dots.forEach((d, i) => d.position.copy(l.curve.getPoint(((elapsed / 1.8 + i / 3) % 1 + 1) % 1)));
    }
  }
}
