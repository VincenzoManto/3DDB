export interface P {
  x: number;
  z: number;
}

export interface Seat {
  desk: P;
  /** Desk rotation: 0 → monitors face +z, π/2 → monitors face +x. */
  rot: number;
  /** Where the person sits. */
  chair: P;
  room: RoomId;
}

export type RoomId = 'control' | 'ops' | 'analytics' | 'cage' | 'east' | 'southEast' | 'southWest';

export interface RoomDef {
  id: RoomId;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Door points just inside the room (on the corridor-facing wall). */
  doors: P[];
  /** Spot on a camera-facing wall for the room sign. */
  sign: P;
}

const RIGHT = Math.PI / 2;

/** Corridor ring between the room band (|12|) and the glass hall (|10|). */
export const CORRIDOR = 11;

export const ROOMS: Record<RoomId, RoomDef> = {
  control: { id: 'control', x0: -20, x1: -12, z0: -12, z1: 12, doors: [{ x: -13.2, z: -6 }, { x: -13.2, z: 6 }], sign: { x: -16, z: 0 } },
  ops: { id: 'ops', x0: -12, x1: 0, z0: -20, z1: -12, doors: [{ x: -6, z: -13.2 }], sign: { x: -6, z: -16 } },
  analytics: { id: 'analytics', x0: 0, x1: 12, z0: -20, z1: -12, doors: [{ x: 6, z: -13.2 }], sign: { x: 6, z: -16 } },
  cage: { id: 'cage', x0: 12, x1: 20, z0: -12, z1: 0, doors: [{ x: 13.2, z: -6 }], sign: { x: 16, z: -6 } },
  east: { id: 'east', x0: 12, x1: 20, z0: 0, z1: 12, doors: [{ x: 13.2, z: 6 }], sign: { x: 16, z: 6 } },
  southEast: { id: 'southEast', x0: 0, x1: 12, z0: 12, z1: 20, doors: [{ x: 6, z: 13.2 }], sign: { x: 6, z: 16 } },
  southWest: { id: 'southWest', x0: -12, x1: 0, z0: 12, z1: 20, doors: [{ x: -6, z: 13.2 }], sign: { x: -6, z: 16 } },
};

/** Point on the corridor ring right outside a door. */
export function doorOutside(d: P): P {
  if (Math.abs(d.x) > 12) return { x: Math.sign(d.x) * CORRIDOR, z: d.z };
  return { x: d.x, z: Math.sign(d.z) * CORRIDOR };
}

export function nearestDoor(room: RoomId, p: P): P {
  return ROOMS[room].doors.reduce((best, d) =>
    Math.hypot(d.x - p.x, d.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? d : best,
  );
}

const range = (start: number, step: number, n: number) => Array.from({ length: n }, (_, i) => start + i * step);

function grid(room: RoomId, xs: number[], zs: number[], rot: number): Seat[] {
  const doors = ROOMS[room].doors;
  const seats: Seat[] = [];
  for (const x of xs) {
    for (const z of zs) {
      const chair = rot === 0 ? { x, z: z + 0.75 } : { x: x + 0.75, z };
      const blocksDoor = doors.some(
        (d) => Math.hypot(d.x - chair.x, d.z - chair.z) < 1.15 || Math.hypot(d.x - x, d.z - z) < 1.15,
      );
      if (!blocksDoor) seats.push({ desk: { x, z }, rot, chair, room });
    }
  }
  return seats;
}

/** Workstations: procedures in the control room, functions in the ops/analytics rooms. */
export const ROUTINE_SEATS = {
  procedure: grid('control', [-17.8, -15.7, -13.6], range(-10.8, 1.2, 19), RIGHT),
  function: [
    ...grid('ops', range(-11.2, 1.25, 9), [-18.4, -16.3, -14.2], 0),
    ...grid('analytics', range(1.2, 1.25, 9), [-18.4, -16.3, -14.2], 0),
  ],
};

/** Offices where users sit; roles are assigned to rooms, superusers to the cage. */
export const OFFICE_ROOMS: RoomId[] = ['east', 'southEast', 'southWest'];

export const OFFICE_SEATS: Record<'cage' | 'east' | 'southEast' | 'southWest', Seat[]> = {
  cage: grid('cage', [14.4, 16.9], range(-8.8, 1.25, 7), RIGHT),
  east: grid('east', [14.4, 16.9], range(1.6, 1.25, 8), RIGHT),
  southEast: grid('southEast', range(1.6, 1.25, 8), [14.6, 17.2], 0),
  southWest: grid('southWest', range(-10.35, 1.25, 8), [14.6, 17.2], 0),
};
