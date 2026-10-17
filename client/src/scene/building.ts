import * as THREE from 'three';
import { COLORS } from './palette';
import { floorTexture, gratingTexture } from './textures';
import { UNIT_BOX, chair, desk, fence, screenTable, shelf, table, wallLight, wallScreen } from './furniture';
import { mergeStatic } from './merge';

export const FLOOR_HALF = 20;
export const HALL_HALF = 10;
const BAND = 12;
const WALL_H = 2.4;
const WALL_T = 0.25;
const DOOR_W = 1.4;
const LIGHT_Y = 2.25;

const RIGHT = Math.PI / 2;
const BACK = Math.PI;

const wallSide = new THREE.MeshLambertMaterial({ color: COLORS.wall });
const wallTop = new THREE.MeshLambertMaterial({ color: COLORS.wallTop });
const WALL_MATS = [wallSide, wallSide, wallTop, wallSide, wallSide, wallSide];

/**
 * Procedural replica of the reference floor plan: square plate, 12 perimeter rooms,
 * a corridor ring and a glass-walled central server hall (racks are added by Datacenter).
 */
export class Building {
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.buildFloor();
    this.buildWalls();
    this.buildGlassHall();
    this.furnish();
    mergeStatic(this.group);
    this.addRoomLights();
  }

  private buildFloor(): void {
    const size = FLOOR_HALF * 2 + WALL_T;
    const top = floorTexture();
    top.repeat.set(size / 4, size / 4);
    const side = new THREE.MeshLambertMaterial({ color: COLORS.floorSide });
    const slab = new THREE.Mesh(UNIT_BOX, [side, side, new THREE.MeshLambertMaterial({ map: top }), side, side, side]);
    slab.scale.set(size, 0.7, size);
    slab.position.y = -0.35;
    this.group.add(slab);

    const grating = gratingTexture();
    grating.repeat.set(HALL_HALF / 2, HALL_HALF / 2);
    const hall = new THREE.Mesh(
      new THREE.PlaneGeometry(HALL_HALF * 2, HALL_HALF * 2),
      new THREE.MeshLambertMaterial({ map: grating }),
    );
    hall.rotation.x = -Math.PI / 2;
    hall.position.y = 0.005;
    this.group.add(hall);
  }

  /** Straight wall from A to B; `gaps` are door centers measured from A. */
  private wall(ax: number, az: number, bx: number, bz: number, gaps: number[] = [], h = WALL_H): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const pieces: Array<[number, number]> = [];
    let start = -WALL_T / 2;
    for (const g of [...gaps].sort((a, b) => a - b)) {
      pieces.push([start, g - DOOR_W / 2]);
      start = g + DOOR_W / 2;
    }
    pieces.push([start, len + WALL_T / 2]);

    for (const [s, e] of pieces) {
      const L = e - s;
      if (L < 0.05) continue;
      const mid = (s + e) / 2;
      const m = new THREE.Mesh(UNIT_BOX, WALL_MATS);
      m.scale.set(L, h, WALL_T);
      m.position.set(ax + ux * mid, h / 2, az + uz * mid);
      m.rotation.y = -Math.atan2(uz, ux);
      this.group.add(m);
    }
  }

  private buildWalls(): void {
    const F = FLOOR_HALF;
    const B = BAND;

    this.wall(-F, -F, F, -F);
    this.wall(F, -F, F, F);
    this.wall(F, F, -F, F);
    this.wall(-F, F, -F, -F);

    // Inner face of the perimeter band (rooms ↔ corridor), two doors per side.
    this.wall(-B, -B, -B, B, [6, 18]);
    this.wall(B, -B, B, B, [6, 18]);
    this.wall(-B, -B, B, -B, [6, 18]);
    this.wall(-B, B, B, B, [6, 18]);

    // Corner rooms.
    this.wall(-F, -B, -B, -B, [4]);
    this.wall(-B, -F, -B, -B, [4]);
    this.wall(B, -F, B, -B, [4]);
    this.wall(B, -B, F, -B, [4]);
    this.wall(B, B, F, B, [4]);
    this.wall(B, B, B, F, [4]);
    this.wall(-B, B, -B, F, [4]);
    this.wall(-F, B, -B, B, [4]);

    // Side room splits.
    this.wall(0, -F, 0, -B, [4]);
    this.wall(F, 0, B, 0, [4]);
    this.wall(0, B, 0, F, [4]);
  }

  private buildGlassHall(): void {
    const H = HALL_HALF;
    const glass = new THREE.MeshLambertMaterial({
      color: 0x9fd9c0,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    });
    const frame = new THREE.MeshLambertMaterial({ color: 0x3a4145 });
    const glassH = 2.3;
    const runs: Array<[number, number, number, number]> = [];
    for (const s of [-1, 1]) {
      runs.push([-H, s * H, -1.6, s * H], [1.6, s * H, H, s * H]);
      runs.push([s * H, -H, s * H, -1.6], [s * H, 1.6, s * H, H]);
    }

    for (const [ax, az, bx, bz] of runs) {
      const len = Math.hypot(bx - ax, bz - az);
      const alongX = Math.abs(bz - az) < 1e-6;
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;

      const pane = new THREE.Mesh(UNIT_BOX, glass);
      pane.scale.set(alongX ? len : 0.05, glassH, alongX ? 0.05 : len);
      pane.position.set(cx, glassH / 2, cz);
      pane.renderOrder = 2;
      this.group.add(pane);

      const rail = new THREE.Mesh(UNIT_BOX, frame);
      rail.scale.set(alongX ? len : 0.08, 0.06, alongX ? 0.08 : len);
      rail.position.set(cx, glassH, cz);
      this.group.add(rail);

      const posts = Math.round(len / 1.7);
      for (let k = 0; k <= posts; k++) {
        const t = k / posts;
        const post = new THREE.Mesh(UNIT_BOX, frame);
        post.scale.set(0.07, glassH, 0.07);
        post.position.set(ax + (bx - ax) * t, glassH / 2, az + (bz - az) * t);
        this.group.add(post);
      }
    }
  }

  private furnish(): void {
    const g = this.group;
    const W = -FLOOR_HALF + WALL_T / 2 + 0.03;

    // Rooms whose content is data-driven (control/ops/analytics: routines; cage/offices: users)
    // only get wall dressing here.

    // Control room: video wall behind the procedure workstations.
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 7; i++) {
        wallScreen(g, W, 1.25 + row * 0.95, -4.74 + i * 1.58, RIGHT, 1.48, 0.85, i + row);
      }
    }
    shelf(g, -19.55, -11.3, RIGHT);
    shelf(g, -19.55, 11.3, RIGHT);

    // Storage (corner).
    shelf(g, -18.6, -19.55, 0);
    shelf(g, -17.2, -19.55, 0);
    shelf(g, -15.8, -19.55, 0);
    shelf(g, -19.55, -16.2, RIGHT);
    shelf(g, -19.55, -14.8, RIGHT);
    desk(g, -15.2, -16.8, 0, { width: 1.4, monitors: 1 });

    // Ops + analytics rooms: dashboards behind the function workstations.
    for (let i = 0; i < 3; i++) wallScreen(g, -9 + i * 3, 1.75, W, 0, 2.2, 1.0, i);
    wallScreen(g, 3.2, 1.75, W, 0, 2.6, 1.0, 1);
    wallScreen(g, 6.6, 1.75, W, 0, 2.6, 1.0, 0);
    wallScreen(g, 9.6, 1.75, W, 0, 1.4, 1.0, 2);

    // Backup room (corner).
    shelf(g, 13.4, -19.55, 0);
    shelf(g, 14.8, -19.55, 0);
    shelf(g, 16.2, -19.55, 0);
    shelf(g, 17.6, -19.55, 0);
    table(g, 17.2, -14.6, 0);
    chair(g, 17.2, -13.8, 0);

    // Cage: the root/superuser office is fenced in.
    fence(g, [[12.7, -11.5], [19.5, -11.5], [19.5, -0.6], [12.7, -0.6]]);

    // Corner office (x 12..20, z 12..20): 2x2 desk cluster.
    wallScreen(g, 16.2, 1.55, 12.16, 0, 2.4, 1.2, 1);
    desk(g, 15.0, 15.2, 0);
    desk(g, 17.0, 15.2, 0);
    desk(g, 15.0, 16.75, BACK);
    desk(g, 17.0, 16.75, BACK);
    shelf(g, 12.45, 18.4, RIGHT);

    shelf(g, 0.45, 18.6, RIGHT);
    shelf(g, -11.55, 18.6, RIGHT);

    // Lab (corner): workbench + blue screen table.
    wallScreen(g, W, 1.5, 15.2, RIGHT, 1.8, 1.0, 3);
    desk(g, -19.2, 17.8, RIGHT, { width: 1.8, monitors: 2 });
    screenTable(g, -15.8, 16.6, 0, 'blue');
    chair(g, -15.8, 17.6, 0);
    shelf(g, -18.0, 12.55, 0);
    shelf(g, -16.6, 12.55, 0);

    // Wall light bars on walls facing the camera.
    const lights: Array<[number, number, number]> = [
      [-18.3, -11.84, 0],
      [-16, -19.84, 0],
      [-11.84, -18.4, RIGHT],
      [0.16, -18.6, RIGHT],
      [12.16, -18.4, RIGHT],
      [18.3, -11.84, 0],
      [18.3, 0.16, 0],
      [12.16, 18.4, RIGHT],
      [3, 12.16, 0],
      [-9.5, 12.16, 0],
      [-18.3, 12.16, 0],
      [-19.84, -7.5, RIGHT],
    ];
    for (const [x, z, rot] of lights) wallLight(g, x, LIGHT_Y, z, rot);
  }

  private addRoomLights(): void {
    const glows: Array<[number, number, number, number]> = [
      [-16.5, 0, 0x3dff8c, 14],
      [-6, -16, 0x3dff8c, 9],
      [6, -16.5, 0x3dff8c, 8],
      [16, -15.5, 0x3dff8c, 5],
      [15.5, -8, 0x3dff8c, 6],
      [15, 6, 0x3dff8c, 6],
      [16, 15.5, 0x3dff8c, 7],
      [6, 15.5, 0x3dff8c, 7],
      [-6, 15.5, 0x3dff8c, 5],
      [-16, 16, 0x5aa0ff, 6],
    ];
    for (const [x, z, color, intensity] of glows) {
      const light = new THREE.PointLight(color, intensity, 9, 2);
      light.position.set(x, 1.8, z);
      this.group.add(light);
    }
  }
}
