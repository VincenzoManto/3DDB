import * as THREE from 'three';
import type { SessionInfo, Topology, UserInfo } from '../../../shared/types';
import { M, UNIT_PLANE, block, chair, placed, screenMat } from './furniture';
import { disposeLabel, makeLabel } from './labels';
import { mergeStatic } from './merge';
import type { NavGraph } from './nav';
import { OFFICE_ROOMS, OFFICE_SEATS, ROOMS, nearestDoor, type P, type RoomId, type Seat } from './rooms';

export const ROLE_COLORS = ['#3dff8c', '#3dd6ff', '#ffc23d', '#c77dff', '#ff7ab6', '#9dff3d', '#7af0ff', '#ffe066'];
export const SUPER_COLOR = '#ff6a3d';
const PUBLIC_COLOR = '#9aa4a8';
export const PUBLIC_ROLE = 'PUBLIC';

const SPEED = 3.4;
const MIN_DWELL_MS = 2600;
const MAX_SIGNS = 3;

export interface Target {
  kind: 'table' | 'routine';
  id: string;
  stand: P;
  look: P;
  anchor: THREE.Vector3;
  op: 'read' | 'write' | 'call';
}

export type TargetResolver = (session: SessionInfo, slot: number) => Target | null;
export type Emit = (from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color) => void;

type OfficeId = keyof typeof OFFICE_SEATS;

interface Avatar {
  user: UserInfo;
  color: THREE.Color;
  root: THREE.Group;
  pose: THREE.Group;
  legs: THREE.Mesh;
  visorMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  label: THREE.Sprite;
  icon: THREE.Sprite;
  iconKey: string;
  seat: Seat;
  pos: P;
  heading: number;
  path: P[];
  mode: 'home' | 'walking' | 'working';
  target: Target | null;
  targetKey: string;
  arrivedAt: number;
  wantHome: boolean;
  session: SessionInfo | null;
  emitAt: number;
  phase: number;
}

const LEG_GEOM = new THREE.BoxGeometry(0.26, 0.5, 0.16);
const BODY_GEOM = new THREE.CapsuleGeometry(0.17, 0.4, 4, 10);
const HEAD_GEOM = new THREE.SphereGeometry(0.15, 14, 10);
const VISOR_GEOM = new THREE.BoxGeometry(0.25, 0.06, 0.07);
const RING_GEOM = new THREE.RingGeometry(0.3, 0.38, 32);
const SPARE_DESKS = 3;
const AVATAR_SCALE = 1.3;
const legMat = new THREE.MeshLambertMaterial({ color: 0x3b454b });
const bodyMat = new THREE.MeshLambertMaterial({ color: 0x66747b });
const headMat = new THREE.MeshLambertMaterial({ color: 0x8a979d });
const darkScreen = new THREE.MeshBasicMaterial({ color: 0x061009 });

const iconCache = new Map<string, THREE.SpriteMaterial>();
function iconMaterial(text: string, color: string): THREE.SpriteMaterial {
  const key = `${text}|${color}`;
  let mat = iconCache.get(key);
  if (!mat) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(6,10,9,0.85)';
    ctx.fillRect(8, 8, 112, 48);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, 112, 48);
    ctx.fillStyle = color;
    ctx.font = '700 28px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 33);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    iconCache.set(key, mat);
  }
  return mat;
}

function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Users as people, roles as offices, superusers in the cage; live sessions make them walk to their work. */
export class People {
  private group = new THREE.Group();
  private furniture = new THREE.Group();
  private signs: THREE.Sprite[] = [];
  private avatars = new Map<string, Avatar>();
  private key = '';
  private nav: NavGraph | null = null;
  private hovered: string | null = null;
  private selected: string | null = null;
  private highlighted = new Set<string>();
  private targets: THREE.Object3D[] = [];
  roleColors = new Map<string, string>();
  roleRoom = new Map<string, RoomId>();
  overflow = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  setNav(nav: NavGraph): void {
    this.nav = nav;
  }

  setTopology(topology: Topology): boolean {
    const key = JSON.stringify([
      topology.users.map((u) => [u.name, u.roles, u.superuser]),
      topology.roles.map((r) => [r.name, r.members.length]),
    ]);
    if (key === this.key) return false;
    this.key = key;

    const roles = topology.roles
      .filter((r) => r.members.length > 0)
      .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
    this.roleColors = new Map(roles.map((r, i) => [r.name, ROLE_COLORS[i % ROLE_COLORS.length]]));
    const size = new Map(roles.map((r) => [r.name, r.members.length]));

    const load: Record<string, number> = Object.fromEntries(OFFICE_ROOMS.map((o) => [o, 0]));
    const leastLoaded = () => OFFICE_ROOMS.reduce((a, b) => (load[b] < load[a] ? b : a));
    this.roleRoom = new Map();
    for (const r of roles) {
      const office = leastLoaded();
      this.roleRoom.set(r.name, office);
      load[office] += r.members.length;
    }

    const used: Record<OfficeId, number> = { cage: 0, east: 0, southEast: 0, southWest: 0 };
    const placements: Array<{ user: UserInfo; seat: Seat; color: string }> = [];
    this.overflow = 0;
    for (const user of [...topology.users].sort((a, b) => a.name.localeCompare(b.name))) {
      let room: OfficeId;
      let color: string;
      if (user.superuser) {
        room = 'cage';
        color = SUPER_COLOR;
      } else {
        const primary = user.roles.filter((r) => this.roleRoom.has(r)).sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0))[0];
        if (primary) {
          room = this.roleRoom.get(primary) as OfficeId;
          color = this.roleColors.get(primary)!;
        } else {
          if (!this.roleRoom.has(PUBLIC_ROLE)) this.roleRoom.set(PUBLIC_ROLE, leastLoaded());
          room = this.roleRoom.get(PUBLIC_ROLE) as OfficeId;
          color = PUBLIC_COLOR;
        }
      }
      const candidates: OfficeId[] = [room, ...(room === 'cage' ? [] : (OFFICE_ROOMS as OfficeId[]).filter((o) => o !== room))];
      const office = candidates.find((o) => used[o] < OFFICE_SEATS[o].length);
      if (!office) {
        this.overflow++;
        continue;
      }
      placements.push({ user, seat: OFFICE_SEATS[office][used[office]++], color });
    }

    this.rebuildFurniture(used);
    this.rebuildSigns(roles.map((r) => r.name), topology);
    this.rebuildAvatars(placements);
    return true;
  }

  private rebuildFurniture(used: Record<OfficeId, number>): void {
    this.furniture.removeFromParent();
    this.furniture.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.furniture = new THREE.Group();
    for (const office of Object.keys(OFFICE_SEATS) as OfficeId[]) {
      OFFICE_SEATS[office].slice(0, used[office] + SPARE_DESKS).forEach((seat, i) => {
        const g = placed(this.furniture, seat.desk.x, seat.desk.z, seat.rot);
        block(g, M.desk, 1.1, 0.05, 0.75, 0, 0.72, 0);
        block(g, M.dark, 0.05, 0.72, 0.7, -0.51, 0, 0);
        block(g, M.dark, 0.05, 0.72, 0.7, 0.51, 0, 0);
        block(g, M.dark, 0.05, 0.14, 0.05, 0, 0.77, -0.22);
        block(g, M.dark, 0.56, 0.36, 0.03, 0, 0.9, -0.24);
        const screen = new THREE.Mesh(UNIT_PLANE, i < used[office] ? screenMat(i % 4) : darkScreen);
        screen.scale.set(0.52, 0.32, 1);
        screen.position.set(0, 1.08, -0.222);
        g.add(screen);
        chair(g, 0, 0.75, 0);
      });
    }
    mergeStatic(this.furniture);
    this.group.add(this.furniture);
  }

  private rebuildSigns(roles: string[], topology: Topology): void {
    for (const s of this.signs) {
      s.removeFromParent();
      disposeLabel(s);
    }
    this.signs = [];
    const byRoom = new Map<RoomId, string[]>();
    for (const [role, room] of this.roleRoom) byRoom.set(room, [...(byRoom.get(room) ?? []), role]);
    const members = new Map(topology.roles.map((r) => [r.name, r.members.length]));
    const publicCount = topology.users.filter((u) => !u.superuser && !u.roles.some((r) => roles.includes(r))).length;
    const superCount = topology.users.filter((u) => u.superuser).length;

    const add = (room: RoomId, i: number, text: string, sub: string, color: string, data: object) => {
      const sign = makeLabel(text, { sub, color, height: 0.72 });
      sign.position.set(ROOMS[room].sign.x, 3.1 + i * 0.85, ROOMS[room].sign.z);
      sign.userData = data;
      this.group.add(sign);
      this.signs.push(sign);
    };

    if (superCount) add('cage', 0, 'SUPERUSER', `${superCount} user${superCount === 1 ? '' : 's'} · full access`, SUPER_COLOR, { kind: 'role', id: '__superuser' });
    for (const [room, list] of byRoom) {
      const shown = list.slice(0, MAX_SIGNS);
      shown.forEach((role, i) => {
        const isPublic = role === PUBLIC_ROLE;
        add(
          room,
          i,
          isPublic ? 'NO ROLE' : `ROLE ${role}`,
          `${isPublic ? publicCount : members.get(role) ?? 0} members`,
          isPublic ? PUBLIC_COLOR : this.roleColors.get(role)!,
          { kind: 'role', id: role },
        );
      });
      if (list.length > MAX_SIGNS) add(room, MAX_SIGNS, `+${list.length - MAX_SIGNS} roles`, 'in this office', '#9aa4a8', {});
    }
  }

  private rebuildAvatars(placements: Array<{ user: UserInfo; seat: Seat; color: string }>): void {
    const previous = this.avatars;
    this.avatars = new Map();
    for (const { user, seat, color } of placements) {
      const old = previous.get(user.name);
      const av = this.createAvatar(user, seat, color);
      if (old) {
        av.pos = { ...old.pos };
        av.heading = old.heading;
        av.target = old.target;
        av.targetKey = old.targetKey;
        av.session = old.session;
        av.mode = old.mode === 'home' && (old.seat.chair.x !== seat.chair.x || old.seat.chair.z !== seat.chair.z) ? 'walking' : old.mode;
        av.path = av.mode === 'walking' ? (this.nav?.path(av.pos, av.target?.stand ?? seat.chair) ?? [seat.chair]) : [];
        av.arrivedAt = old.arrivedAt;
      }
      this.avatars.set(user.name, av);
    }
    for (const old of previous.values()) {
      old.root.removeFromParent();
      old.visorMat.dispose();
      old.ringMat.dispose();
      disposeLabel(old.label);
    }
    this.targets = [...this.avatars.values()].flatMap((a) => a.pose.children.filter((c) => (c as THREE.Mesh).isMesh));
    this.targets.push(...this.signs.filter((s) => (s.userData as { kind?: string }).kind));
    this.applyHighlight();
  }

  private createAvatar(user: UserInfo, seat: Seat, color: string): Avatar {
    const root = new THREE.Group();
    const pose = new THREE.Group();
    pose.scale.setScalar(AVATAR_SCALE);
    root.add(pose);
    const data = { kind: 'user', id: user.name };

    const legs = new THREE.Mesh(LEG_GEOM, legMat);
    legs.position.y = 0.25;
    const body = new THREE.Mesh(BODY_GEOM, bodyMat);
    body.position.y = 0.87;
    const head = new THREE.Mesh(HEAD_GEOM, headMat);
    head.position.y = 1.38;
    const c = new THREE.Color(color);
    const visorMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.8) });
    const visor = new THREE.Mesh(VISOR_GEOM, visorMat);
    visor.position.set(0, 1.4, 0.11);
    for (const m of [legs, body, head, visor]) {
      m.userData = data;
      pose.add(m);
    }

    const ringMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.5), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(RING_GEOM, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(ring);

    const label = makeLabel(user.name, {
      sub: user.superuser ? 'superuser' : user.roles.join(', ') || 'no role',
      color,
      height: 0.5,
      visible: false,
    });
    label.position.y = 2.75;
    root.add(label);

    const icon = new THREE.Sprite(iconMaterial('·', color));
    icon.scale.set(0.8, 0.4, 1);
    icon.position.y = 2.25;
    icon.visible = false;
    icon.renderOrder = 9;
    root.add(icon);

    this.group.add(root);
    return {
      user,
      color: c,
      root,
      pose,
      legs,
      visorMat,
      ring,
      ringMat,
      label,
      icon,
      iconKey: '',
      seat,
      pos: { ...seat.chair },
      heading: Math.atan2(seat.desk.x - seat.chair.x, seat.desk.z - seat.chair.z),
      path: [],
      mode: 'home',
      target: null,
      targetKey: '',
      arrivedAt: 0,
      wantHome: false,
      session: null,
      emitAt: 0,
      phase: Math.random() * 10,
    };
  }

  /** Seat ↔ door links for the nav graph. */
  navLinks(): Array<[P, P]> {
    return (Object.keys(OFFICE_SEATS) as OfficeId[]).flatMap((o) =>
      OFFICE_SEATS[o].map((s) => [s.chair, nearestDoor(s.room, s.chair)] as [P, P]),
    );
  }

  get hitTargets(): THREE.Object3D[] {
    return this.targets;
  }

  has(name: string): boolean {
    return this.avatars.has(name);
  }

  headPosition(name: string): THREE.Vector3 | null {
    const a = this.avatars.get(name);
    return a ? new THREE.Vector3(a.pos.x, 1.8, a.pos.z) : null;
  }

  targetOf(name: string): Target | null {
    return this.avatars.get(name)?.target ?? null;
  }

  setHovered(name: string | null): void {
    this.hovered = name;
    this.applyHighlight();
  }

  setSelected(name: string | null): void {
    this.selected = name;
    this.applyHighlight();
  }

  highlight(names: Iterable<string>): void {
    this.highlighted = new Set(names);
    this.applyHighlight();
  }

  private applyHighlight(): void {
    for (const [name, a] of this.avatars) {
      a.label.visible = name === this.hovered || name === this.selected || this.highlighted.has(name);
    }
  }

  applySessions(sessions: SessionInfo[], resolve: TargetResolver): void {
    const byUser = new Map<string, SessionInfo>();
    for (const s of sessions) {
      const cur = byUser.get(s.user);
      const rank = (x: SessionInfo) => (x.state === 'idle' ? 0 : 1) * 1e9 + x.durationMs;
      if (!cur || rank(s) > rank(cur)) byUser.set(s.user, s);
    }

    const slots = new Map<string, number>();
    for (const [name, av] of this.avatars) {
      const s = byUser.get(name) ?? null;
      av.session = s;
      const active = s && s.state !== 'idle';
      const tkey = active ? (s.routineId ? `r:${s.routineId}` : s.tableId ? `t:${s.tableId}` : '') : '';
      if (!active || !tkey) {
        if (av.target) av.wantHome = true;
        continue;
      }
      const slot = slots.get(tkey) ?? 0;
      slots.set(tkey, slot + 1);
      av.wantHome = false;
      if (tkey === av.targetKey) continue;
      const target = resolve(s, slot);
      if (!target) continue;
      av.target = target;
      av.targetKey = tkey;
      av.path = this.nav?.path(av.pos, target.stand) ?? [target.stand];
      av.mode = 'walking';
    }
  }

  tick(dt: number, now: number, elapsed: number, emit: Emit): void {
    for (const av of this.avatars.values()) {
      if (av.mode === 'working' && av.wantHome && now - av.arrivedAt > MIN_DWELL_MS) {
        av.target = null;
        av.targetKey = '';
        av.wantHome = false;
        av.path = this.nav?.path(av.pos, av.seat.chair) ?? [av.seat.chair];
        av.mode = 'walking';
      }

      let step = SPEED * dt;
      while (av.path.length && step > 0) {
        const next = av.path[0];
        const dx = next.x - av.pos.x;
        const dz = next.z - av.pos.z;
        const d = Math.hypot(dx, dz);
        if (d <= step) {
          av.pos = { ...next };
          av.path.shift();
          step -= d;
        } else {
          av.pos = { x: av.pos.x + (dx / d) * step, z: av.pos.z + (dz / d) * step };
          av.heading = angleLerp(av.heading, Math.atan2(dx, dz), Math.min(1, dt * 12));
          step = 0;
        }
      }
      if (!av.path.length && av.mode === 'walking') {
        if (av.target) {
          av.mode = 'working';
          av.arrivedAt = now;
        } else {
          av.mode = 'home';
        }
      }

      const waiting = av.session?.state === 'waiting';
      let face: P | null = null;
      if (av.mode === 'home') face = av.seat.desk;
      else if (av.mode === 'working' && av.target) face = av.target.look;
      if (face) av.heading = angleLerp(av.heading, Math.atan2(face.x - av.pos.x, face.z - av.pos.z), Math.min(1, dt * 8));

      const seated = av.mode === 'home';
      const walking = av.mode === 'walking';
      av.root.position.set(av.pos.x, 0, av.pos.z);
      av.pose.rotation.y = av.heading;
      av.legs.visible = !seated;
      av.pose.position.y = seated ? -0.18 : walking ? Math.abs(Math.sin(elapsed * 11 + av.phase)) * 0.06 : 0;

      const busy = !seated || Boolean(av.session && av.session.state !== 'idle');
      av.ringMat.opacity = busy ? 0.55 + 0.35 * Math.sin(elapsed * 4 + av.phase) : 0;
      const tint = waiting ? new THREE.Color('#ff3b3b') : av.color;
      const online = av.session !== null;
      av.ringMat.color.copy(tint).multiplyScalar(1.5);
      av.visorMat.color.copy(tint).multiplyScalar(waiting ? 1.8 + Math.sin(elapsed * 10) : online ? 1.8 : 0.45);

      let iconText = '';
      if (waiting) iconText = 'LOCK';
      else if (av.mode === 'working' && av.target && !av.wantHome) iconText = av.target.op === 'call' ? 'CALL' : av.target.op === 'write' ? 'WRITE' : 'READ';
      const iconColor = waiting ? '#ff3b3b' : `#${av.color.getHexString()}`;
      const iconKey = `${iconText}|${iconColor}`;
      if (iconKey !== av.iconKey) {
        av.iconKey = iconKey;
        av.icon.visible = Boolean(iconText);
        if (iconText) av.icon.material = iconMaterial(iconText, iconColor);
      }
      if (waiting) av.icon.visible = Math.sin(elapsed * 8) > -0.3;

      if (av.mode === 'working' && av.target && !av.wantHome && now >= av.emitAt) {
        av.emitAt = now + 550 + Math.random() * 450;
        emit(new THREE.Vector3(av.pos.x, 1.6, av.pos.z), av.target.anchor, waiting ? new THREE.Color('#ff3b3b') : av.color);
      }
    }
  }

  counts(): { shown: number; overflow: number; active: number; walking: number } {
    let active = 0;
    let walking = 0;
    for (const a of this.avatars.values()) {
      if (a.session && a.session.state !== 'idle') active++;
      if (a.mode === 'walking') walking++;
    }
    return { shown: this.avatars.size, overflow: this.overflow, active, walking };
  }
}
