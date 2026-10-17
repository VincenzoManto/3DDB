import { HALL_WALK, type HallLayout } from './layout';
import { CORRIDOR, ROOMS, doorOutside, type P } from './rooms';

const EPS = 1e-3;
const key = (p: P) => `${p.x.toFixed(2)}|${p.z.toFixed(2)}`;

interface Seg {
  a: P;
  b: P;
  pts: P[];
}

function onSeg(s: Seg, p: P): boolean {
  const minX = Math.min(s.a.x, s.b.x) - EPS;
  const maxX = Math.max(s.a.x, s.b.x) + EPS;
  const minZ = Math.min(s.a.z, s.b.z) - EPS;
  const maxZ = Math.max(s.a.z, s.b.z) + EPS;
  if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) return false;
  const cross = (s.b.x - s.a.x) * (p.z - s.a.z) - (s.b.z - s.a.z) * (p.x - s.a.x);
  return Math.abs(cross) < EPS * Math.max(1, Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z));
}

/** Walkable network: free axis-aligned walkways plus explicit links (seat ↔ door). Dijkstra paths. */
export class NavGraph {
  private segs: Seg[] = [];
  private extras: P[] = [];
  private links: Array<[P, P]> = [];
  private nodes = new Map<string, P>();
  private adj = new Map<string, Array<[string, number]>>();

  segment(a: P, b: P): void {
    this.segs.push({ a, b, pts: [a, b] });
  }

  point(p: P): void {
    this.extras.push(p);
  }

  link(a: P, b: P): void {
    this.links.push([a, b]);
  }

  private edge(a: P, b: P): void {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    this.nodes.set(ka, a);
    this.nodes.set(kb, b);
    (this.adj.get(ka) ?? this.adj.set(ka, []).get(ka)!).push([kb, d]);
    (this.adj.get(kb) ?? this.adj.set(kb, []).get(kb)!).push([ka, d]);
  }

  build(): this {
    for (let i = 0; i < this.segs.length; i++) {
      for (let j = i + 1; j < this.segs.length; j++) {
        const s = this.segs[i];
        const t = this.segs[j];
        const sVertical = Math.abs(s.a.x - s.b.x) < EPS;
        const tVertical = Math.abs(t.a.x - t.b.x) < EPS;
        if (sVertical !== tVertical) {
          const ip = sVertical ? { x: s.a.x, z: t.a.z } : { x: t.a.x, z: s.a.z };
          if (onSeg(s, ip) && onSeg(t, ip)) {
            s.pts.push(ip);
            t.pts.push(ip);
          }
        }
        for (const p of [t.a, t.b]) if (onSeg(s, p)) s.pts.push(p);
        for (const p of [s.a, s.b]) if (onSeg(t, p)) t.pts.push(p);
      }
    }
    const loose = [...this.extras, ...this.links.flat()];
    for (const s of this.segs) for (const p of loose) if (onSeg(s, p)) s.pts.push(p);

    for (const s of this.segs) {
      const len2 = (s.b.x - s.a.x) ** 2 + (s.b.z - s.a.z) ** 2 || 1;
      const t = (p: P) => ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.z - s.a.z) * (s.b.z - s.a.z)) / len2;
      const unique = new Map(s.pts.map((p) => [key(p), p]));
      const sorted = [...unique.values()].sort((p, q) => t(p) - t(q));
      for (let i = 0; i < sorted.length - 1; i++) this.edge(sorted[i], sorted[i + 1]);
    }
    for (const [a, b] of this.links) this.edge(a, b);
    return this;
  }

  private nearest(p: P): string | undefined {
    let best: string | undefined;
    let bestD = Infinity;
    for (const [k, n] of this.nodes) {
      const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /** Waypoints from `from` to `to` (both included). Falls back to a straight line. */
  path(from: P, to: P): P[] {
    const start = this.nearest(from);
    const goal = this.nearest(to);
    if (!start || !goal) return [to];
    const dist = new Map<string, number>([[start, 0]]);
    const prev = new Map<string, string>();
    const open = new Set<string>([start]);
    const done = new Set<string>();
    while (open.size) {
      let current = '';
      let best = Infinity;
      for (const k of open) {
        const d = dist.get(k)!;
        if (d < best) {
          best = d;
          current = k;
        }
      }
      if (current === goal) break;
      open.delete(current);
      done.add(current);
      for (const [next, w] of this.adj.get(current) ?? []) {
        if (done.has(next)) continue;
        const nd = best + w;
        if (nd < (dist.get(next) ?? Infinity)) {
          dist.set(next, nd);
          prev.set(next, current);
          open.add(next);
        }
      }
    }
    if (!dist.has(goal)) return [to];
    const keys: string[] = [goal];
    while (keys[0] !== start) keys.unshift(prev.get(keys[0])!);
    const pts = keys.map((k) => this.nodes.get(k)!);
    return [...pts, to];
  }
}

/** Corridor ring, room doors, hall walkways/aisles, and links from seats/stand points into the network. */
export function buildNav(hall: HallLayout, seatLinks: Array<[P, P]>, standPoints: P[]): NavGraph {
  const g = new NavGraph();
  const C = CORRIDOR;
  const W = HALL_WALK;

  g.segment({ x: -C, z: -C }, { x: C, z: -C });
  g.segment({ x: C, z: -C }, { x: C, z: C });
  g.segment({ x: C, z: C }, { x: -C, z: C });
  g.segment({ x: -C, z: C }, { x: -C, z: -C });

  for (const room of Object.values(ROOMS)) for (const d of room.doors) g.segment(doorOutside(d), d);

  for (const [a, b] of [
    [{ x: W, z: 0 }, { x: C, z: 0 }],
    [{ x: -W, z: 0 }, { x: -C, z: 0 }],
    [{ x: 0, z: W }, { x: 0, z: C }],
    [{ x: 0, z: -W }, { x: 0, z: -C }],
  ] as Array<[P, P]>) {
    g.segment(a, b);
  }

  g.segment({ x: -W, z: -W }, { x: W, z: -W });
  g.segment({ x: W, z: -W }, { x: W, z: W });
  g.segment({ x: W, z: W }, { x: -W, z: W });
  g.segment({ x: -W, z: W }, { x: -W, z: -W });
  for (const [x0, z0, x1, z1] of hall.walkways) g.segment({ x: x0, z: z0 }, { x: x1, z: z1 });
  for (const b of hall.blocks) for (const z of b.standLines) g.segment({ x: b.left, z }, { x: b.right, z });

  for (const p of standPoints) g.point(p);
  for (const [a, b] of seatLinks) g.link(a, b);
  return g.build();
}
