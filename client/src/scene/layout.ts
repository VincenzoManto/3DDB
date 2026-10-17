import type { TableInfo, Topology } from '../../../shared/types';

export const CAB_W = 0.8;
export const CAB_D = 1.0;
/** Walkway just inside the glass walls of the hall. */
export const HALL_WALK = 9.4;
const HALL_INNER = 8.9;
const CELL_GAP = 1.4;
const PAIR_GAP = 1.3;
const STAND_OFFSET = 0.45;
const PAIR_PITCH = 2 * CAB_D + PAIR_GAP;
const MAX_ZONES = 9;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface RackPlacement {
  table: TableInfo;
  block: number;
  cabinets: number;
  height: number;
  x0: number;
  x1: number;
  z: number;
  /** Aisle line in front of the rack where people stand. */
  standZ: number;
}

export interface BlockLayout {
  database: string;
  index: number;
  cell: Rect;
  rect: Rect | null;
  /** Free vertical walkways bounding the cell. */
  left: number;
  right: number;
  standLines: number[];
  tableCount: number;
  hidden: number;
}

export interface HallLayout {
  blocks: BlockLayout[];
  racks: RackPlacement[];
  /** Free axis-aligned walkway segments between zones: [x0, z0, x1, z1]. */
  walkways: Array<[number, number, number, number]>;
}

/** Rack size encodes table dimensionality: width (cabinets) ∝ log(rows), height ∝ log(bytes). */
export function cabinetsFor(t: TableInfo): number {
  return Math.max(1, Math.round(Math.log10(t.rowCount + 1) * 2));
}

export function heightFor(t: TableInfo): number {
  return 1.5 + Math.min(1, Math.max(0, Math.log10(t.sizeBytes + 1) / 9)) * 1.3;
}

function pack(sizes: number[], perRow: number, maxRows: number): Array<{ row: number; col: number }> | null {
  const out: Array<{ row: number; col: number }> = [];
  let row = 0;
  let col = 0;
  for (const n of sizes) {
    if (col + n > perRow) {
      row++;
      col = 0;
    }
    if (row >= maxRows) return null;
    out.push({ row, col });
    col += n;
  }
  return out;
}

/** One zone per database in a grid inside the glass hall; one rack segment per table. */
export function layoutHall(topology: Topology): HallLayout {
  const names = [...new Set([...topology.databases.map((d) => d.name), ...topology.tables.map((t) => t.database)])].slice(
    0,
    MAX_ZONES,
  );
  if (names.length === 0) return { blocks: [], racks: [], walkways: [] };

  const cols = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / cols);
  const span = 2 * HALL_INNER;
  const ch = (span - (rows - 1) * CELL_GAP) / rows;
  const cellZ0 = (r: number) => -HALL_INNER + r * (ch + CELL_GAP);
  // The last row stretches its zones so the hall has no empty quadrant.
  const colsIn = (r: number) => (r === rows - 1 ? names.length - (rows - 1) * cols : cols);
  const cellW = (r: number) => (span - (colsIn(r) - 1) * CELL_GAP) / colsIn(r);
  const cellX0 = (r: number, c: number) => -HALL_INNER + c * (cellW(r) + CELL_GAP);
  const lineX = (r: number, c: number) => (c === 0 ? -HALL_WALK : c === colsIn(r) ? HALL_WALK : cellX0(r, c) - CELL_GAP / 2);
  const lineZ = (r: number) => (r === 0 ? -HALL_WALK : r === rows ? HALL_WALK : cellZ0(r) - CELL_GAP / 2);

  const walkways: HallLayout['walkways'] = [];
  for (let r = 1; r < rows; r++) walkways.push([-HALL_WALK, lineZ(r), HALL_WALK, lineZ(r)]);
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < colsIn(r); c++) walkways.push([lineX(r, c), lineZ(r), lineX(r, c), lineZ(r + 1)]);
  }

  const maxRows = Math.max(1, Math.floor((ch + PAIR_GAP) / PAIR_PITCH)) * 2;

  const blocks: BlockLayout[] = [];
  const racks: RackPlacement[] = [];

  names.forEach((database, index) => {
    const c = index % cols;
    const r = Math.floor(index / cols);
    const cw = cellW(r);
    const perRow = Math.max(1, Math.floor(cw / CAB_W));
    const cell = { x0: cellX0(r, c), x1: cellX0(r, c) + cw, z0: cellZ0(r), z1: cellZ0(r) + ch };
    const tables = topology.tables.filter((t) => t.database === database).sort((a, b) => a.name.localeCompare(b.name));

    let sizes = tables.map((t) => Math.min(perRow, cabinetsFor(t)));
    let placed = pack(sizes, perRow, maxRows);
    if (!placed) {
      sizes = sizes.map(() => 1);
      placed = pack(sizes, perRow, maxRows);
    }
    let shown = tables.length;
    if (!placed) {
      shown = perRow * maxRows;
      sizes = sizes.slice(0, shown);
      placed = pack(sizes, perRow, maxRows) ?? [];
    }

    const usedRows = placed.length ? Math.max(...placed.map((p) => p.row)) + 1 : 0;
    const pairs = Math.max(1, Math.ceil(usedRows / 2));
    const depth = pairs * 2 * CAB_D + (pairs - 1) * PAIR_GAP;
    const top = (cell.z0 + cell.z1) / 2 - depth / 2;
    const startX = (cell.x0 + cell.x1) / 2 - (perRow * CAB_W) / 2;

    const standLines = new Set<number>();
    let rect: Rect | null = null;
    placed.forEach((p, i) => {
      const front = p.row % 2 === 0 ? -1 : 1;
      const z = top + Math.floor(p.row / 2) * PAIR_PITCH + (front < 0 ? 0.5 : 1.5) * CAB_D;
      const standZ = z + front * (CAB_D / 2 + STAND_OFFSET);
      const x0 = startX + p.col * CAB_W;
      const x1 = x0 + sizes[i] * CAB_W;
      standLines.add(standZ);
      racks.push({ table: tables[i], block: index, cabinets: sizes[i], height: heightFor(tables[i]), x0, x1, z, standZ });
      rect = rect
        ? { x0: Math.min(rect.x0, x0), x1: Math.max(rect.x1, x1), z0: Math.min(rect.z0, z - CAB_D / 2), z1: Math.max(rect.z1, z + CAB_D / 2) }
        : { x0, x1, z0: z - CAB_D / 2, z1: z + CAB_D / 2 };
    });

    blocks.push({
      database,
      index,
      cell,
      rect,
      left: lineX(r, c),
      right: lineX(r, c + 1),
      standLines: [...standLines],
      tableCount: tables.length,
      hidden: tables.length - shown,
    });
  });

  return { blocks, racks, walkways };
}
