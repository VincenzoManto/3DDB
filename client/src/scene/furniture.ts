import * as THREE from 'three';
import { COLORS } from './palette';
import { screenTexture, type Hue } from './textures';

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

export const M = {
  dark: new THREE.MeshLambertMaterial({ color: COLORS.furniture }),
  light: new THREE.MeshLambertMaterial({ color: COLORS.furnitureLight }),
  desk: new THREE.MeshLambertMaterial({ color: COLORS.desk }),
  cabinet: new THREE.MeshLambertMaterial({ color: COLORS.cabinet }),
  cabinetTop: new THREE.MeshLambertMaterial({ color: COLORS.cabinetTop }),
  lightBar: new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.green).multiplyScalar(1.6) }),
};

const ITEM_MATS = [M.dark, M.light, M.desk, M.cabinetTop];

const screenMats = new Map<string, THREE.MeshBasicMaterial>();

export function screenMat(variant: number, hue: Hue = 'green', boost = 1.25): THREE.MeshBasicMaterial {
  const key = `${hue}-${variant % 4}-${boost}`;
  let mat = screenMats.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      map: screenTexture(variant, hue),
      color: new THREE.Color(boost, boost, boost),
    });
    screenMats.set(key, mat);
  }
  return mat;
}

const randInt = (n: number) => Math.floor(Math.random() * n);

/** Adds a box whose `y` is its bottom edge (easier furniture stacking). */
export function block(
  parent: THREE.Object3D,
  mat: THREE.Material | THREE.Material[],
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

/** Local frame convention: an item's "front" faces local +z. rot = π/2 faces +x, π faces -z, -π/2 faces -x. */
export function placed(parent: THREE.Object3D, x: number, z: number, rot: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  parent.add(g);
  return g;
}

export function chair(parent: THREE.Object3D, x: number, z: number, rot: number): void {
  const g = placed(parent, x, z, rot);
  block(g, M.dark, 0.5, 0.04, 0.5, 0, 0, 0);
  block(g, M.dark, 0.06, 0.42, 0.06, 0, 0, 0);
  block(g, M.dark, 0.46, 0.07, 0.46, 0, 0.42, 0);
  block(g, M.dark, 0.46, 0.5, 0.06, 0, 0.5, 0.22);
}

export function desk(
  parent: THREE.Object3D,
  x: number,
  z: number,
  rot: number,
  opts: { width?: number; monitors?: number; chair?: boolean; hue?: Hue } = {},
): void {
  const w = opts.width ?? 1.6;
  const n = opts.monitors ?? 2;
  const g = placed(parent, x, z, rot);
  block(g, M.desk, w, 0.05, 0.75, 0, 0.72, 0);
  block(g, M.dark, 0.05, 0.72, 0.7, -w / 2 + 0.04, 0, 0);
  block(g, M.dark, 0.05, 0.72, 0.7, w / 2 - 0.04, 0, 0);
  block(g, M.dark, w - 0.1, 0.4, 0.03, 0, 0.3, -0.33);

  for (let i = 0; i < n; i++) {
    const mx = n === 1 ? 0 : -w / 2 + 0.35 + i * ((w - 0.7) / (n - 1));
    block(g, M.dark, 0.05, 0.14, 0.05, mx, 0.77, -0.22);
    block(g, M.dark, 0.52, 0.34, 0.03, mx, 0.9, -0.24);
    const s = new THREE.Mesh(UNIT_PLANE, screenMat(randInt(4), opts.hue));
    s.scale.set(0.48, 0.3, 1);
    s.position.set(mx, 1.07, -0.222);
    g.add(s);
  }

  if (opts.chair !== false) chair(g, 0, 0.75, 0);
}

export function table(parent: THREE.Object3D, x: number, z: number, rot: number, w = 1.4, d = 0.9): void {
  const g = placed(parent, x, z, rot);
  block(g, M.desk, w, 0.05, d, 0, 0.72, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) block(g, M.dark, 0.05, 0.72, 0.05, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06));
  }
}

/** Table with a glowing horizontal touch-screen top (the blue table in the lab). */
export function screenTable(parent: THREE.Object3D, x: number, z: number, rot: number, hue: Hue = 'blue'): void {
  const g = placed(parent, x, z, rot);
  block(g, M.desk, 1.5, 0.06, 1.0, 0, 0.72, 0);
  block(g, M.dark, 1.3, 0.72, 0.8, 0, 0, 0);
  const s = new THREE.Mesh(UNIT_PLANE, screenMat(3, hue, 1.7));
  s.rotation.x = -Math.PI / 2;
  s.scale.set(1.3, 0.85, 1);
  s.position.set(0, 0.785, 0);
  g.add(s);
}

export function shelf(parent: THREE.Object3D, x: number, z: number, rot: number, w = 1.2, h = 1.9): void {
  const g = placed(parent, x, z, rot);
  block(g, M.dark, w, h, 0.04, 0, 0, -0.2);
  block(g, M.light, 0.04, h, 0.42, -w / 2, 0, 0);
  block(g, M.light, 0.04, h, 0.42, w / 2, 0, 0);
  const levels = 5;
  const step = (h - 0.03) / (levels - 1);
  for (let i = 0; i < levels; i++) block(g, M.light, w, 0.03, 0.42, 0, i * step, 0);
  for (let i = 0; i < levels - 1; i++) {
    let cx = -w / 2 + 0.06;
    while (cx < w / 2 - 0.2) {
      const iw = 0.12 + Math.random() * 0.2;
      if (Math.random() < 0.75) {
        block(g, ITEM_MATS[randInt(ITEM_MATS.length)], iw, 0.12 + Math.random() * (step - 0.2), 0.3, cx + iw / 2, i * step + 0.03, 0);
      }
      cx += iw + 0.03;
    }
  }
}

/** Wall-mounted dashboard. `y` is the screen center height. */
export function wallScreen(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  rot: number,
  w: number,
  h: number,
  variant = randInt(4),
  hue: Hue = 'green',
): void {
  const g = placed(parent, x, z, rot);
  block(g, M.dark, w + 0.1, h + 0.1, 0.06, 0, y - (h + 0.1) / 2, 0);
  const s = new THREE.Mesh(UNIT_PLANE, screenMat(variant, hue));
  s.scale.set(w, h, 1);
  s.position.set(0, y, 0.035);
  g.add(s);
}

/** Short glowing light bar mounted near the top of a wall. */
export function wallLight(parent: THREE.Object3D, x: number, y: number, z: number, rot: number, len = 1.6): void {
  const g = placed(parent, x, z, rot);
  block(g, M.dark, len + 0.12, 0.09, 0.1, 0, y - 0.045, 0.02);
  block(g, M.lightBar, len, 0.04, 0.04, 0, y - 0.02, 0.08);
}

/** Wire cage fence through a polyline of [x, z] points. */
export function fence(parent: THREE.Object3D, points: Array<[number, number]>, h = 2.0): void {
  const verts: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const bars = Math.max(1, Math.round(len / 0.18));
    for (let k = 0; k <= bars; k++) {
      const t = k / bars;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      verts.push(x, 0, z, x, h, z);
    }
    for (const y of [0.05, h / 2, h]) verts.push(ax, y, az, bx, y, bz);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  parent.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x59636a })));
}
