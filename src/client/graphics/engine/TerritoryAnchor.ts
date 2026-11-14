import {
  AVATAR_HAIR_PRESETS,
  AVATAR_MAX_SCALE,
  AVATAR_MIN_SCALE,
  AVATAR_SKIN_PRESETS,
  AvatarColorConfig,
  applyCameraZoomToAvatarScale,
} from "./AvatarSystem";

export { AVATAR_MAX_SCALE, AVATAR_MIN_SCALE, applyCameraZoomToAvatarScale };

export interface TerritoryMapView {
  width(): number;
  height(): number;
  ref(x: number, y: number): number;
  isLand(tile: number): boolean;
  ownerID(tile: number): number;
  x?(tile: number): number;
  y?(tile: number): number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TerritoryAnchorResult {
  x: number;
  y: number;
  tile: number;
  clearance: number;
  componentArea: number;
  tightBounds: BoundingBox;
}

export interface TerritoryAnchorOptions {
  smallID: number;
  bounds?: BoundingBox;
  prevX?: number;
  prevY?: number;
  seedX?: number;
  seedY?: number;
}

const AVATAR_HALF_SAT_TILES = 2200;

/**
 * Smooth nonlinear scaling from owned tile count into world/base avatar scale.
 * Bounded strictly in [AVATAR_MIN_SCALE, AVATAR_MAX_SCALE] using a Hill saturation curve.
 */
export function computeAvatarScale(tilesOwned: number): number {
  if (!Number.isFinite(tilesOwned) || tilesOwned <= 0) {
    return AVATAR_MIN_SCALE;
  }
  const tRoot = Math.pow(tilesOwned, 0.52);
  const kRoot = Math.pow(AVATAR_HALF_SAT_TILES, 0.52);
  return (
    AVATAR_MIN_SCALE +
    (AVATAR_MAX_SCALE - AVATAR_MIN_SCALE) * (tRoot / (tRoot + kRoot))
  );
}

/**
 * Deterministic distinct avatar appearance for AI/remote countries based on player ID and territory color.
 */
export function deriveCountryAvatarConfig(
  playerId: string,
  territoryHex: string,
): AvatarColorConfig {
  let h = 2166136261;
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = h >>> 0;
  return {
    skinTone: AVATAR_SKIN_PRESETS[idx % AVATAR_SKIN_PRESETS.length],
    shirtColor: territoryHex || "#3b82f6",
    hairColor: AVATAR_HAIR_PRESETS[(idx >>> 4) % AVATAR_HAIR_PRESETS.length],
  };
}

// Reusable scratch typed arrays (single-threaded main-thread anchor computation)
const GRID_DIM_CAP = 56;
let ownerMask = new Uint8Array(GRID_DIM_CAP * GRID_DIM_CAP);
let compGrid = new Int32Array(GRID_DIM_CAP * GRID_DIM_CAP);
let distGrid = new Int16Array(GRID_DIM_CAP * GRID_DIM_CAP);
let bfsQueue = new Int32Array(GRID_DIM_CAP * GRID_DIM_CAP);
let compAreaScratch = new Int32Array(GRID_DIM_CAP * GRID_DIM_CAP);
let compHasPrevScratch = new Uint8Array(GRID_DIM_CAP * GRID_DIM_CAP);
let compSumX = new Float64Array(GRID_DIM_CAP * GRID_DIM_CAP);
let compSumY = new Float64Array(GRID_DIM_CAP * GRID_DIM_CAP);

function ensureGridScratch(cells: number): void {
  if (ownerMask.length >= cells) return;
  ownerMask = new Uint8Array(cells);
  compGrid = new Int32Array(cells);
  distGrid = new Int16Array(cells);
  bfsQueue = new Int32Array(cells);
  compAreaScratch = new Int32Array(cells);
  compHasPrevScratch = new Uint8Array(cells);
  compSumX = new Float64Array(cells);
  compSumY = new Float64Array(cells);
}

function isOwnedLandAt(
  map: TerritoryMapView,
  x: number,
  y: number,
  smallID: number,
): boolean {
  if (x < 0 || y < 0 || x >= map.width() || y >= map.height()) return false;
  const tile = map.ref(x, y);
  return map.ownerID(tile) === smallID && map.isLand(tile);
}

/**
 * Finds the visually central interior tile inside the largest relevant connected land component.
 * Avoids water, enemy tiles, concave bays outside the territory, and tiny isolated fragments.
 */
export function findTerritoryAnchor(
  map: TerritoryMapView,
  opts: TerritoryAnchorOptions,
): TerritoryAnchorResult | null {
  const mapW = map.width();
  const mapH = map.height();
  if (mapW <= 0 || mapH <= 0 || opts.smallID <= 0) return null;

  const bounds = opts.bounds ?? {
    minX: 0,
    minY: 0,
    maxX: mapW - 1,
    maxY: mapH - 1,
  };
  const minX = Math.max(0, Math.min(mapW - 1, Math.floor(bounds.minX)));
  const minY = Math.max(0, Math.min(mapH - 1, Math.floor(bounds.minY)));
  const maxX = Math.max(minX, Math.min(mapW - 1, Math.ceil(bounds.maxX)));
  const maxY = Math.max(minY, Math.min(mapH - 1, Math.ceil(bounds.maxY)));

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const maxSpan = Math.max(spanX, spanY);

  // Adaptive step capped at <=48 cells per axis; falls back to finer step for thin strips.
  let step = Math.max(1, Math.ceil(maxSpan / 48));
  let result = solveAnchorAtStep(
    map,
    opts.smallID,
    minX,
    minY,
    maxX,
    maxY,
    step,
    opts.prevX,
    opts.prevY,
  );

  // If coarse stride missed a very thin strip or tiny territory, refine with smaller step.
  if (result === null && step > 1) {
    step = Math.max(1, Math.floor(step / 3));
    result = solveAnchorAtStep(
      map,
      opts.smallID,
      minX,
      minY,
      maxX,
      maxY,
      step,
      opts.prevX,
      opts.prevY,
    );
    if (result === null && step > 1) {
      result = solveAnchorAtStep(
        map,
        opts.smallID,
        minX,
        minY,
        maxX,
        maxY,
        1,
        opts.prevX,
        opts.prevY,
      );
    }
  }

  // Fallback to seed or full-map scan if supplied bounds became stale during rapid capture/shift.
  if (result === null && opts.seedX !== undefined && opts.seedY !== undefined) {
    if (isOwnedLandAt(map, opts.seedX, opts.seedY, opts.smallID)) {
      const tile = map.ref(opts.seedX, opts.seedY);
      return {
        x: opts.seedX,
        y: opts.seedY,
        tile,
        clearance: 1,
        componentArea: 1,
        tightBounds: {
          minX: opts.seedX,
          minY: opts.seedY,
          maxX: opts.seedX,
          maxY: opts.seedY,
        },
      };
    }
  }

  if (result === null && opts.bounds) {
    const fullStep = Math.max(1, Math.ceil(Math.max(mapW, mapH) / 48));
    result = solveAnchorAtStep(
      map,
      opts.smallID,
      0,
      0,
      mapW - 1,
      mapH - 1,
      fullStep,
      opts.prevX,
      opts.prevY,
    );
  }

  return result;
}

function solveAnchorAtStep(
  map: TerritoryMapView,
  smallID: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  step: number,
  prevX?: number,
  prevY?: number,
): TerritoryAnchorResult | null {
  const gw = Math.floor((maxX - minX) / step) + 1;
  const gh = Math.floor((maxY - minY) / step) + 1;
  if (gw <= 0 || gh <= 0) return null;

  // Guard against overly huge fine scans
  if (gw * gh > 65536 && step === 1) {
    return solveAnchorAtStep(
      map,
      smallID,
      minX,
      minY,
      maxX,
      maxY,
      Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) / 48),
      prevX,
      prevY,
    );
  }

  const totalCells = gw * gh;
  ensureGridScratch(totalCells);

  let ownedCount = 0;
  let tMinX = map.width();
  let tMinY = map.height();
  let tMaxX = -1;
  let tMaxY = -1;

  for (let gy = 0; gy < gh; gy++) {
    const wy = minY + gy * step;
    const rowOff = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const wx = minX + gx * step;
      const owned = isOwnedLandAt(map, wx, wy, smallID) ? 1 : 0;
      const idx = rowOff + gx;
      ownerMask[idx] = owned;
      compGrid[idx] = 0;
      if (owned) {
        ownedCount++;
        if (wx < tMinX) tMinX = wx;
        if (wx > tMaxX) tMaxX = wx;
        if (wy < tMinY) tMinY = wy;
        if (wy > tMaxY) tMaxY = wy;
      }
    }
  }

  if (ownedCount === 0) {
    return null;
  }

  const prevCellGx =
    prevX !== undefined ? Math.round((prevX - minX) / step) : -1;
  const prevCellGy =
    prevY !== undefined ? Math.round((prevY - minY) / step) : -1;
  const prevIdx =
    prevCellGx >= 0 && prevCellGx < gw && prevCellGy >= 0 && prevCellGy < gh
      ? prevCellGy * gw + prevCellGx
      : -1;

  // 1. Find 4-connected components
  let compCount = 0;
  for (let idx = 0; idx < totalCells; idx++) {
    if (!ownerMask[idx] || compGrid[idx] !== 0) continue;
    compCount++;
    const cid = compCount;
    let qHead = 0;
    let qTail = 0;
    bfsQueue[qTail++] = idx;
    compGrid[idx] = cid;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let hasPrev = 0;

    while (qHead < qTail) {
      const cur = bfsQueue[qHead++];
      const cx = cur % gw;
      const cy = (cur / gw) | 0;
      area++;
      sumX += cx;
      sumY += cy;
      if (cur === prevIdx) hasPrev = 1;

      if (cx > 0) {
        const n = cur - 1;
        if (ownerMask[n] && compGrid[n] === 0) {
          compGrid[n] = cid;
          bfsQueue[qTail++] = n;
        }
      }
      if (cx + 1 < gw) {
        const n = cur + 1;
        if (ownerMask[n] && compGrid[n] === 0) {
          compGrid[n] = cid;
          bfsQueue[qTail++] = n;
        }
      }
      if (cy > 0) {
        const n = cur - gw;
        if (ownerMask[n] && compGrid[n] === 0) {
          compGrid[n] = cid;
          bfsQueue[qTail++] = n;
        }
      }
      if (cy + 1 < gh) {
        const n = cur + gw;
        if (ownerMask[n] && compGrid[n] === 0) {
          compGrid[n] = cid;
          bfsQueue[qTail++] = n;
        }
      }
    }

    compAreaScratch[cid] = area;
    compHasPrevScratch[cid] = hasPrev;
    compSumX[cid] = sumX / area;
    compSumY[cid] = sumY / area;
  }

  // Pick largest connected component with mild hysteresis against island flickering
  let bestComp = 1;
  let bestCompScore = -1;
  for (let cid = 1; cid <= compCount; cid++) {
    const score = compAreaScratch[cid] * (compHasPrevScratch[cid] ? 1.15 : 1.0);
    if (score > bestCompScore) {
      bestCompScore = score;
      bestComp = cid;
    }
  }

  // 2. Two-pass distance transform on the winning connected component
  const INF = 16000;
  for (let gy = 0; gy < gh; gy++) {
    const rowOff = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const idx = rowOff + gx;
      if (compGrid[idx] !== bestComp) {
        distGrid[idx] = 0;
        continue;
      }
      // Boundary cell touching outside grid has clearance 1
      if (gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1) {
        distGrid[idx] = 1;
        continue;
      }
      const left = distGrid[idx - 1];
      const up = distGrid[idx - gw];
      const diagUpLeft = distGrid[idx - gw - 1];
      const diagUpRight = distGrid[idx - gw + 1];
      let d = Math.min(left, up) + 1;
      if (diagUpLeft + 1 < d) d = diagUpLeft + 1;
      if (diagUpRight + 1 < d) d = diagUpRight + 1;
      distGrid[idx] = d > INF ? INF : d;
    }
  }

  for (let gy = gh - 1; gy >= 0; gy--) {
    const rowOff = gy * gw;
    for (let gx = gw - 1; gx >= 0; gx--) {
      const idx = rowOff + gx;
      if (compGrid[idx] !== bestComp) continue;
      if (gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1) {
        distGrid[idx] = 1;
        continue;
      }
      let d = distGrid[idx];
      const right = distGrid[idx + 1] + 1;
      const down = distGrid[idx + gw] + 1;
      const diagDownLeft = distGrid[idx + gw - 1] + 1;
      const diagDownRight = distGrid[idx + gw + 1] + 1;
      if (right < d) d = right;
      if (down < d) d = down;
      if (diagDownLeft < d) d = diagDownLeft;
      if (diagDownRight < d) d = diagDownRight;
      distGrid[idx] = d;
    }
  }

  // 3. Pick cell inside winning component maximizing clearance from boundary,
  // with subtle tie-break toward component's visual mean center.
  const meanGx = compSumX[bestComp];
  const meanGy = compSumY[bestComp];
  let bestGx = -1;
  let bestGy = -1;
  let bestCellScore = -Infinity;
  let bestClearance = 0;

  for (let gy = 0; gy < gh; gy++) {
    const rowOff = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const idx = rowOff + gx;
      if (compGrid[idx] !== bestComp) continue;
      const clr = distGrid[idx];
      const dx = gx - meanGx;
      const dy = gy - meanGy;
      const score = clr - 0.005 * Math.hypot(dx, dy);
      if (score > bestCellScore) {
        bestCellScore = score;
        bestGx = gx;
        bestGy = gy;
        bestClearance = clr;
      }
    }
  }

  if (bestGx < 0) return null;

  let anchorX = minX + bestGx * step;
  let anchorY = minY + bestGy * step;
  const worldClearance = bestClearance * step;

  // 4. Local fine refinement when coarse step > 1: guarantee highest clearance
  // within ±step at 1-tile resolution and exact owned-land validity.
  if (step > 1) {
    const refineRadius = Math.min(8, Math.max(2, Math.floor(step / 2) + 1));
    let fineBestX = anchorX;
    let fineBestY = anchorY;
    let fineBestScore = -1;

    for (let oy = -refineRadius; oy <= refineRadius; oy++) {
      const wy = anchorY + oy;
      if (wy < 0 || wy >= map.height()) continue;
      for (let ox = -refineRadius; ox <= refineRadius; ox++) {
        const wx = anchorX + ox;
        if (wx < 0 || wx >= map.width()) continue;
        if (!isOwnedLandAt(map, wx, wy, smallID)) continue;

        // Measure local clearance radius up to refineRadius
        let clr = 1;
        for (let r = 1; r <= refineRadius; r++) {
          if (
            !isOwnedLandAt(map, wx - r, wy, smallID) ||
            !isOwnedLandAt(map, wx + r, wy, smallID) ||
            !isOwnedLandAt(map, wx, wy - r, smallID) ||
            !isOwnedLandAt(map, wx, wy + r, smallID)
          ) {
            break;
          }
          clr = r + 1;
        }
        const tie = 0.01 * Math.hypot(ox, oy);
        const sc = clr - tie;
        if (sc > fineBestScore) {
          fineBestScore = sc;
          fineBestX = wx;
          fineBestY = wy;
        }
      }
    }
    anchorX = fineBestX;
    anchorY = fineBestY;
  }

  // Hysteresis check against prevX/prevY: avoid jumping unnecessarily on minor border changes
  if (
    prevX !== undefined &&
    prevY !== undefined &&
    isOwnedLandAt(map, prevX, prevY, smallID) &&
    compHasPrevScratch[bestComp]
  ) {
    const distMoved = Math.hypot(anchorX - prevX, anchorY - prevY);
    const threshold = Math.max(5, worldClearance * 0.35);
    const prevClearance = distGrid[prevIdx] * step;
    if (distMoved < threshold && prevClearance >= worldClearance * 0.7) {
      anchorX = prevX;
      anchorY = prevY;
    }
  }

  // Expand tight bounds conservatively by step so edge tiles aren't clipped
  const pad = step;
  return {
    x: anchorX,
    y: anchorY,
    tile: map.ref(anchorX, anchorY),
    clearance: Math.max(1, worldClearance),
    componentArea: compAreaScratch[bestComp] * step * step,
    tightBounds: {
      minX: Math.max(0, tMinX - pad),
      minY: Math.max(0, tMinY - pad),
      maxX: Math.min(map.width() - 1, tMaxX + pad),
      maxY: Math.min(map.height() - 1, tMaxY + pad),
    },
  };
}

interface PlayerAnchorCache {
  x: number;
  y: number;
  tile: number;
  lastTilesOwned: number;
  lastVersion: number;
  lastRecomputeTick: number;
  bounds: BoundingBox;
}

/**
 * Caches territory geometry and anchor positions across all human and AI countries.
 * Amortizes non-urgent recomputations and invalidates strictly via tile changes.
 */
export class TerritoryAnchorManager {
  private readonly caches = new Map<number, PlayerAnchorCache>();
  private readonly territoryVersions = new Map<number, number>();
  private readonly incrementalBounds = new Map<number, BoundingBox>();

  public recordTileChange(
    oldSmallID: number,
    newSmallID: number,
    x: number,
    y: number,
  ): void {
    if (oldSmallID === newSmallID) return;
    if (oldSmallID > 0) {
      this.territoryVersions.set(
        oldSmallID,
        (this.territoryVersions.get(oldSmallID) ?? 0) + 1,
      );
    }
    if (newSmallID > 0) {
      this.territoryVersions.set(
        newSmallID,
        (this.territoryVersions.get(newSmallID) ?? 0) + 1,
      );
      let b = this.incrementalBounds.get(newSmallID);
      if (!b) {
        b = { minX: x, minY: y, maxX: x, maxY: y };
        this.incrementalBounds.set(newSmallID, b);
      } else {
        if (x < b.minX) b.minX = x;
        if (y < b.minY) b.minY = y;
        if (x > b.maxX) b.maxX = x;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }

  public removePlayer(smallID: number): void {
    this.caches.delete(smallID);
    this.territoryVersions.delete(smallID);
    this.incrementalBounds.delete(smallID);
  }

  public clear(): void {
    this.caches.clear();
    this.territoryVersions.clear();
    this.incrementalBounds.clear();
  }

  public resolveAnchor(
    map: TerritoryMapView,
    smallID: number,
    tilesOwned: number,
    seedTile: number | undefined,
    tick: number,
    allowNonUrgentScan: boolean,
  ): { x: number; y: number; tile: number; urgentSnap: boolean } | null {
    const version = this.territoryVersions.get(smallID) ?? 0;
    const cached = this.caches.get(smallID);

    const seedX = seedTile !== undefined && map.x ? map.x(seedTile) : undefined;
    const seedY = seedTile !== undefined && map.y ? map.y(seedTile) : undefined;

    if (seedTile !== undefined && seedX !== undefined && seedY !== undefined) {
      let b = this.incrementalBounds.get(smallID);
      if (!b) {
        b = { minX: seedX, minY: seedY, maxX: seedX, maxY: seedY };
        this.incrementalBounds.set(smallID, b);
      }
    }

    const currentAnchorStillValid =
      cached !== undefined && isOwnedLandAt(map, cached.x, cached.y, smallID);

    if (cached && currentAnchorStillValid) {
      const tileDelta = Math.abs(tilesOwned - cached.lastTilesOwned);
      const meaningfulDelta =
        tileDelta >= Math.max(8, cached.lastTilesOwned * 0.12);
      const periodicRefresh =
        version !== cached.lastVersion && tick - cached.lastRecomputeTick >= 18;
      if (!allowNonUrgentScan || (!meaningfulDelta && !periodicRefresh)) {
        return {
          x: cached.x,
          y: cached.y,
          tile: cached.tile,
          urgentSnap: false,
        };
      }
    }

    const trackedBounds = this.incrementalBounds.get(smallID) ?? cached?.bounds;
    const solved = findTerritoryAnchor(map, {
      smallID,
      bounds: trackedBounds,
      prevX: currentAnchorStillValid ? cached?.x : undefined,
      prevY: currentAnchorStillValid ? cached?.y : undefined,
      seedX,
      seedY,
    });

    if (solved) {
      this.incrementalBounds.set(smallID, { ...solved.tightBounds });
      this.caches.set(smallID, {
        x: solved.x,
        y: solved.y,
        tile: solved.tile,
        lastTilesOwned: tilesOwned,
        lastVersion: version,
        lastRecomputeTick: tick,
        bounds: solved.tightBounds,
      });
      return {
        x: solved.x,
        y: solved.y,
        tile: solved.tile,
        urgentSnap: !currentAnchorStillValid,
      };
    }

    if (cached && currentAnchorStillValid) {
      return {
        x: cached.x,
        y: cached.y,
        tile: cached.tile,
        urgentSnap: false,
      };
    }

    if (seedTile !== undefined && seedX !== undefined && seedY !== undefined) {
      return { x: seedX, y: seedY, tile: seedTile, urgentSnap: true };
    }

    return null;
  }
}
