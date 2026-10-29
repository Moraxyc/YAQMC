type Point = readonly [number, number];
type Grid = Point[][];

export interface PinchMesh {
  /** Interleaved `fromX, fromY, toX, toY, u, v` per vertex, positions in clip space. */
  vertices: Float32Array;
  indices: Uint16Array;
}

/** Control points per side before subdivision (third-party inference of Apple's portrait/landscape grids). */
export const PORTRAIT_CONTROL_POINTS = 6;
export const LANDSCAPE_CONTROL_POINTS = 9;
const SUBDIVISION_LEVELS = 2;
/** Full From→To→From cycle length. */
const PINCH_PERIOD_SECONDS = 10;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds From/To control grids on [0, 1]². Apple's preset tables are not
 * reproduced; this seeded generator keeps their observable structure: a fixed
 * border, small static jitter, and a few interior points that travel most of a
 * cell between the two poses. Jitter plus travel stays below one cell so no
 * control point crosses a neighbour, which would fold the mesh into a crease.
 */
export function createControlGrids(size: number, seed: number): { from: Grid; to: Grid } {
  const random = mulberry32(seed);
  const cell = 1 / (size - 1);
  const from: Grid = [];
  const to: Grid = [];
  for (let row = 0; row < size; row += 1) {
    const fromRow: Point[] = [];
    const toRow: Point[] = [];
    for (let column = 0; column < size; column += 1) {
      const border = row === 0 || column === 0 || row === size - 1 || column === size - 1;
      const jitterX = border ? 0 : (random() - 0.5) * 0.3 * cell;
      const jitterY = border ? 0 : (random() - 0.5) * 0.3 * cell;
      const point: Point = [column * cell + jitterX, row * cell + jitterY];
      fromRow.push(point);
      toRow.push(point);
    }
    from.push(fromRow);
    to.push(toRow);
  }
  const interior = (size - 2) ** 2;
  const movers = Math.max(2, Math.round(interior / 6));
  // Movers are never 8-neighbours, so two of them cannot approach each other.
  const moved: Array<[number, number]> = [];
  for (let attempt = 0; moved.length < movers && attempt < movers * 20; attempt += 1) {
    const row = 1 + Math.floor(random() * (size - 2));
    const column = 1 + Math.floor(random() * (size - 2));
    if (moved.some(([r, c]) => Math.abs(r - row) <= 1 && Math.abs(c - column) <= 1)) continue;
    moved.push([row, column]);
    const angle = random() * Math.PI * 2;
    const distance = (0.4 + random() * 0.3) * cell;
    const [x, y] = to[row]![column]!;
    to[row]![column] = [x + Math.cos(angle) * distance, y + Math.sin(angle) * distance];
  }
  return { from, to };
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Point, factor: number): Point => [a[0] * factor, a[1] * factor];
const average = (...points: Point[]): Point =>
  scale(points.reduce(add, [0, 0] as Point), 1 / points.length);

/** One Catmull-Clark step on a structured grid with sharp boundary corners and cubic boundary curves. */
function subdivideGrid(source: Grid): Grid {
  const rows = source.length;
  const columns = source[0]!.length;
  const at = (row: number, column: number) => source[row]![column]!;
  const face = (row: number, column: number) =>
    average(at(row, column), at(row, column + 1), at(row + 1, column), at(row + 1, column + 1));
  const result: Grid = Array.from({ length: rows * 2 - 1 }, () =>
    Array.from({ length: columns * 2 - 1 }, () => [0, 0] as Point),
  );

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const point = at(row, column);
      const boundaryRow = row === 0 || row === rows - 1;
      const boundaryColumn = column === 0 || column === columns - 1;
      let next: Point;
      if (boundaryRow && boundaryColumn) {
        next = point;
      } else if (boundaryRow) {
        next = scale(add(add(at(row, column - 1), scale(point, 6)), at(row, column + 1)), 1 / 8);
      } else if (boundaryColumn) {
        next = scale(add(add(at(row - 1, column), scale(point, 6)), at(row + 1, column)), 1 / 8);
      } else {
        const faces = average(
          face(row - 1, column - 1),
          face(row - 1, column),
          face(row, column - 1),
          face(row, column),
        );
        const edges = average(
          average(point, at(row - 1, column)),
          average(point, at(row + 1, column)),
          average(point, at(row, column - 1)),
          average(point, at(row, column + 1)),
        );
        next = scale(add(add(faces, scale(edges, 2)), point), 1 / 4);
      }
      result[row * 2]![column * 2] = next;
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const edge = average(at(row, column), at(row, column + 1));
      result[row * 2]![column * 2 + 1] =
        row === 0 || row === rows - 1
          ? edge
          : average(at(row, column), at(row, column + 1), face(row - 1, column), face(row, column));
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const edge = average(at(row, column), at(row + 1, column));
      result[row * 2 + 1]![column * 2] =
        column === 0 || column === columns - 1
          ? edge
          : average(at(row, column), at(row + 1, column), face(row, column - 1), face(row, column));
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      result[row * 2 + 1]![column * 2 + 1] = face(row, column);
    }
  }
  return result;
}

export function createPinchMesh(portrait: boolean, seed: number): PinchMesh {
  const size = portrait ? PORTRAIT_CONTROL_POINTS : LANDSCAPE_CONTROL_POINTS;
  let { from, to } = createControlGrids(size, seed);
  for (let level = 0; level < SUBDIVISION_LEVELS; level += 1) {
    from = subdivideGrid(from);
    to = subdivideGrid(to);
  }
  const rows = from.length;
  const columns = from[0]!.length;
  const vertices = new Float32Array(rows * columns * 6);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const offset = (row * columns + column) * 6;
      const [fromX, fromY] = from[row]![column]!;
      const [toX, toY] = to[row]![column]!;
      vertices.set(
        [
          fromX * 2 - 1,
          fromY * 2 - 1,
          toX * 2 - 1,
          toY * 2 - 1,
          column / (columns - 1),
          row / (rows - 1),
        ],
        offset,
      );
    }
  }
  const indices = new Uint16Array((rows - 1) * (columns - 1) * 6);
  let index = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const bottomLeft = row * columns + column;
      const topLeft = bottomLeft + columns;
      indices.set(
        [bottomLeft, topLeft, topLeft + 1, topLeft + 1, bottomLeft + 1, bottomLeft],
        index,
      );
      index += 6;
    }
  }
  return { vertices, indices };
}

/** Smoothstepped triangle wave: 0 → 1 → 0 over one pinch period. */
export function pinchMix(seconds: number): number {
  const phase = Math.acos(Math.sin((seconds * 2 * Math.PI) / PINCH_PERIOD_SECONDS)) / Math.PI;
  return phase * phase * (3 - 2 * phase);
}
