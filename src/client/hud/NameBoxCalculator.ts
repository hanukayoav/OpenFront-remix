import { Game, NameViewData, Player } from "../../core/game/Game";
import { calculateBoundingBox } from "../../core/Util";

export interface Point {
  x: number;
  y: number;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Spawn region diameter (see getSpawnTiles in SpawnExecution — euclidean
// radius 4). Used to size spawn-phase names directly off the spawn tile,
// instead of waiting on cluster recomputation.
const SPAWN_REGION_DIAMETER = 8;

/**
 * Place a player's name during the spawn phase using their currently-selected
 * spawn tile. Tracks re-rolls immediately, since spawnTile updates the same
 * tick the player picks a new location.
 */
export function placeSpawnName(game: Game, player: Player): NameViewData {
  const spawnTile = player.spawnTile();
  if (spawnTile === undefined) {
    return { x: 0, y: 0, size: 0 };
  }
  const fontSize = calculateFontSize(
    {
      x: 0,
      y: 0,
      width: SPAWN_REGION_DIAMETER,
      height: SPAWN_REGION_DIAMETER,
    },
    player.displayName(),
  );
  return {
    x: Math.ceil(game.x(spawnTile)),
    y: Math.ceil(game.y(spawnTile) - fontSize / 3),
    size: fontSize,
  };
}

// Reusable scratch buffers for zero-allocation placeName() passes
let flatGridBuf = new Uint8Array(0);
let heightsBuf = new Int32Array(0);
let stackBuf = new Int32Array(0);

function findLargestInscribedRectFlat(
  game: Game,
  player: Player,
  boundingBox: { min: Point; max: Point },
  scalingFactor: number,
): Rectangle {
  const minGx = Math.floor(boundingBox.min.x / scalingFactor);
  const minGy = Math.floor(boundingBox.min.y / scalingFactor);
  const maxGx = Math.floor(boundingBox.max.x / scalingFactor);
  const maxGy = Math.floor(boundingBox.max.y / scalingFactor);

  const cols = maxGx - minGx + 1;
  const rows = maxGy - minGy + 1;
  if (cols <= 0 || rows <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const total = cols * rows;
  if (flatGridBuf.length < total) {
    flatGridBuf = new Uint8Array(total);
  }
  if (heightsBuf.length < cols) {
    heightsBuf = new Int32Array(cols);
  } else {
    heightsBuf.fill(0, 0, cols);
  }
  if (stackBuf.length < cols + 1) {
    stackBuf = new Int32Array(cols + 1);
  }

  const mapW = game.width();
  const mapH = game.height();

  // Fill row-major so each row scan reads contiguous bytes
  for (let r = 0; r < rows; r++) {
    const cy = (minGy + r) * scalingFactor;
    const rowOffset = r * cols;
    if (cy < 0 || cy >= mapH) {
      flatGridBuf.fill(0, rowOffset, rowOffset + cols);
      continue;
    }
    for (let c = 0; c < cols; c++) {
      const cx = (minGx + c) * scalingFactor;
      if (cx >= 0 && cx < mapW) {
        const tile = game.ref(cx, cy);
        flatGridBuf[rowOffset + c] =
          game.isShore(tile) ||
          (game.isOcean(tile) && game.magnitude(tile) < 10) ||
          game.owner(tile) === player ||
          game.hasFallout(tile)
            ? 1
            : 0;
      } else {
        flatGridBuf[rowOffset + c] = 0;
      }
    }
  }

  let bestArea = 0;
  let bestX = 0;
  let bestY = 0;
  let bestW = 0;
  let bestH = 0;

  for (let row = 0; row < rows; row++) {
    const rowOffset = row * cols;
    for (let col = 0; col < cols; col++) {
      heightsBuf[col] = flatGridBuf[rowOffset + col] ? heightsBuf[col] + 1 : 0;
    }

    let sp = 0;
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heightsBuf[i];
      while (sp > 0 && h < heightsBuf[stackBuf[sp - 1]]) {
        const height = heightsBuf[stackBuf[--sp]];
        const width = sp === 0 ? i : i - stackBuf[sp - 1] - 1;
        const area = height * width;
        if (area > bestArea) {
          bestArea = area;
          bestX = sp === 0 ? 0 : stackBuf[sp - 1] + 1;
          bestY = row - height + 1;
          bestW = width;
          bestH = height;
        }
      }
      stackBuf[sp++] = i;
    }
  }

  return { x: bestX, y: bestY, width: bestW, height: bestH };
}

export function placeName(game: Game, player: Player): NameViewData {
  const boundingBox =
    player.largestClusterBoundingBox ??
    calculateBoundingBox(game, player.borderTiles());

  let scalingFactor: number;
  const width = boundingBox.max.x - boundingBox.min.x;
  const height = boundingBox.max.y - boundingBox.min.y;
  const size = Math.min(width, height);
  if (size < 25) {
    scalingFactor = 1;
  } else if (size < 50) {
    scalingFactor = 2;
  } else if (size < 100) {
    scalingFactor = 4;
  } else if (size < 250) {
    scalingFactor = 8;
  } else if (size < 500) {
    scalingFactor = 16;
  } else {
    scalingFactor = 32;
  }

  const largestRectangle = findLargestInscribedRectFlat(
    game,
    player,
    boundingBox,
    scalingFactor,
  );
  largestRectangle.x = largestRectangle.x * scalingFactor;
  largestRectangle.y = largestRectangle.y * scalingFactor;
  largestRectangle.width = largestRectangle.width * scalingFactor;
  largestRectangle.height = largestRectangle.height * scalingFactor;

  const centerX = Math.floor(
    largestRectangle.x + largestRectangle.width / 2 + boundingBox.min.x,
  );
  const centerY = Math.floor(
    largestRectangle.y + largestRectangle.height / 2 + boundingBox.min.y,
  );

  const fontSize = calculateFontSize(largestRectangle, player.displayName());

  return {
    x: Math.ceil(centerX),
    y: Math.ceil(centerY - fontSize / 3),
    size: fontSize,
  };
}

export function createGrid(
  game: Game,
  player: Player,
  boundingBox: { min: Point; max: Point },
  scalingFactor: number,
): boolean[][] {
  const scaledBoundingBox: { min: Point; max: Point } = {
    min: {
      x: Math.floor(boundingBox.min.x / scalingFactor),
      y: Math.floor(boundingBox.min.y / scalingFactor),
    },
    max: {
      x: Math.floor(boundingBox.max.x / scalingFactor),
      y: Math.floor(boundingBox.max.y / scalingFactor),
    },
  };

  const width = scaledBoundingBox.max.x - scaledBoundingBox.min.x + 1;
  const height = scaledBoundingBox.max.y - scaledBoundingBox.min.y + 1;
  const grid: boolean[][] = new Array(width);
  for (let i = 0; i < width; i++) {
    grid[i] = new Array(height).fill(false);
  }

  const mapW = game.width();
  const mapH = game.height();

  for (let x = scaledBoundingBox.min.x; x <= scaledBoundingBox.max.x; x++) {
    const cx = x * scalingFactor;
    const col = grid[x - scaledBoundingBox.min.x];
    for (let y = scaledBoundingBox.min.y; y <= scaledBoundingBox.max.y; y++) {
      const cy = y * scalingFactor;
      if (cx >= 0 && cx < mapW && cy >= 0 && cy < mapH) {
        const tile = game.ref(cx, cy);
        col[y - scaledBoundingBox.min.y] =
          game.isShore(tile) ||
          (game.isOcean(tile) && game.magnitude(tile) < 10) ||
          game.owner(tile) === player ||
          game.hasFallout(tile);
      }
    }
  }

  return grid;
}

export function findLargestInscribedRectangle(grid: boolean[][]): Rectangle {
  const rows = grid[0].length;
  const cols = grid.length;
  const heights: number[] = new Array(cols).fill(0);
  let largestRect: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (grid[col][row]) {
        heights[col]++;
      } else {
        heights[col] = 0;
      }
    }

    const rectForRow = largestRectangleInHistogram(heights);

    if (
      rectForRow.width * rectForRow.height >
      largestRect.width * largestRect.height
    ) {
      largestRect = {
        x: rectForRow.x,
        y: row - rectForRow.height + 1,
        width: rectForRow.width,
        height: rectForRow.height,
      };
    }
  }

  return largestRect;
}

export function largestRectangleInHistogram(widths: number[]): Rectangle {
  const stack: number[] = [];
  let maxArea = 0;
  let largestRect: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let i = 0; i <= widths.length; i++) {
    const h = i === widths.length ? 0 : widths[i];

    while (stack.length > 0 && h < widths[stack[stack.length - 1]]) {
      const height = widths[stack.pop()!];
      const width = stack.length === 0 ? i : i - stack[stack.length - 1] - 1;

      if (height * width > maxArea) {
        maxArea = height * width;
        largestRect = {
          x: stack.length === 0 ? 0 : stack[stack.length - 1] + 1,
          y: 0,
          width: width,
          height: height,
        };
      }
    }

    stack.push(i);
  }

  return largestRect;
}

export function calculateFontSize(rectangle: Rectangle, name: string): number {
  // This is a simplified calculation. You might want to adjust it based on your specific font and rendering system.
  const widthConstrained = (rectangle.width / name.length) * 2;
  const heightConstrained = rectangle.height / 3;
  return Math.min(widthConstrained, heightConstrained);
}
