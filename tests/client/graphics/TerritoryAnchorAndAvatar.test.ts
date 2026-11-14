import { describe, expect, it, vi } from "vitest";
import {
  AVATAR_MAX_SCALE,
  AVATAR_MIN_SCALE,
  AvatarSystem,
  applyCameraZoomToAvatarScale,
} from "../../../src/client/graphics/engine/AvatarSystem";
import {
  TerritoryAnchorManager,
  TerritoryMapView,
  computeAvatarScale,
  deriveCountryAvatarConfig,
  findTerritoryAnchor,
} from "../../../src/client/graphics/engine/TerritoryAnchor";

function createTestMap(
  width: number,
  height: number,
): TerritoryMapView & {
  setOwner(x: number, y: number, id: number): void;
  setWater(x: number, y: number): void;
  paintRect(x0: number, y0: number, x1: number, y1: number, id: number): void;
} {
  const owners = new Int32Array(width * height);
  const land = new Uint8Array(width * height).fill(1);
  return {
    width: () => width,
    height: () => height,
    ref: (x, y) => y * width + x,
    x: (t) => t % width,
    y: (t) => Math.floor(t / width),
    isLand: (t) => land[t] === 1,
    ownerID: (t) => owners[t],
    setOwner: (x, y, id) => {
      if (x >= 0 && y >= 0 && x < width && y < height) {
        owners[y * width + x] = id;
      }
    },
    setWater: (x, y) => {
      if (x >= 0 && y >= 0 && x < width && y < height) {
        const ref = y * width + x;
        land[ref] = 0;
        owners[ref] = 0;
      }
    },
    paintRect: (x0, y0, x1, y1, id) => {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x >= 0 && y >= 0 && x < width && y < height) {
            const ref = y * width + x;
            if (land[ref] === 1) {
              owners[ref] = id;
            }
          }
        }
      }
    },
  };
}

describe("Fix 1: Dynamic Territory Avatars & TerritoryAnchor", () => {
  it("scales nonlinearly, monotonically, remains readable for tiny countries, and obeys max cap", () => {
    const tiny = computeAvatarScale(4);
    const small = computeAvatarScale(40);
    const medium = computeAvatarScale(600);
    const large = computeAvatarScale(5000);
    const huge = computeAvatarScale(100000);
    const extreme = computeAvatarScale(10_000_000);

    expect(tiny).toBeGreaterThanOrEqual(AVATAR_MIN_SCALE);
    expect(small).toBeGreaterThan(tiny);
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
    expect(huge).toBeGreaterThanOrEqual(large);
    expect(extreme).toBeLessThanOrEqual(AVATAR_MAX_SCALE);

    // Smooth diminishing marginal gain (nonlinear sublinear growth)
    const earlyGainPerTile = (medium - tiny) / (600 - 4);
    const lateGainPerTile = (huge - large) / (100000 - 5000);
    expect(earlyGainPerTile).toBeGreaterThan(lateGainPerTile * 10);
  });

  it("adapts avatar scale reasonably across camera zoom levels", () => {
    const zoomedOutSmall = applyCameraZoomToAvatarScale(1.0, 0.25);
    const normalSmall = applyCameraZoomToAvatarScale(1.0, 1.0);
    const zoomedInLarge = applyCameraZoomToAvatarScale(3.6, 5.0);

    // Zoomed-out keeps small avatars legible instead of disappearing
    expect(zoomedOutSmall).toBeGreaterThan(normalSmall);
    // Deep zoom dampens large avatars slightly so they don't flood the viewport
    expect(zoomedInLarge).toBeLessThan(3.6);
    expect(zoomedInLarge).toBeGreaterThan(0.5);
  });

  it("places anchor strictly inside concave C-shaped territory rather than arithmetic centroid hole", () => {
    const map = createTestMap(120, 120);
    // C-shape enclosing a hole centered around (35, 50)
    map.paintRect(10, 10, 70, 22, 1); // Top arm
    map.paintRect(10, 10, 24, 90, 1); // Vertical spine
    map.paintRect(10, 78, 70, 90, 1); // Bottom arm
    // Put water & enemy inside the bay hole around (35..65, 30..70)
    for (let y = 30; y <= 70; y++) {
      for (let x = 35; x <= 65; x++) {
        if (x > 50) map.setWater(x, y);
        else map.setOwner(x, y, 2);
      }
    }

    const anchor = findTerritoryAnchor(map, {
      smallID: 1,
      bounds: { minX: 0, minY: 0, maxX: 119, maxY: 119 },
    });

    expect(anchor).not.toBeNull();
    expect(map.isLand(anchor!.tile)).toBe(true);
    expect(map.ownerID(anchor!.tile)).toBe(1);
    // Deepest interior core of C-shape is on the spine (x around 17, y around 50) or thick arm
    expect(anchor!.x).toBeLessThanOrEqual(24);
  });

  it("places anchor cleanly inside thin corridor territory without landing in water or enemy", () => {
    const map = createTestMap(100, 60);
    for (let y = 10; y < 50; y++) {
      for (let x = 10; x < 90; x++) {
        map.setWater(x, y);
      }
    }
    // Thin land corridor at y = 29..31, x = 20..80 (3 tiles thick)
    for (let x = 20; x <= 80; x++) {
      for (let y = 29; y <= 31; y++) {
        // Restore land and assign to player 3
        const freshMap = map as unknown as {
          setOwner(x: number, y: number, id: number): void;
        };
        freshMap.setOwner(x, y, 3);
      }
    }
    // Build fresh map without water on the corridor
    const corridorMap = createTestMap(100, 60);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 100; x++) {
        if (y < 29 || y > 31 || x < 20 || x > 80) {
          corridorMap.setWater(x, y);
        } else {
          corridorMap.setOwner(x, y, 3);
        }
      }
    }

    const anchor = findTerritoryAnchor(corridorMap, { smallID: 3 });
    expect(anchor).not.toBeNull();
    expect(corridorMap.isLand(anchor!.tile)).toBe(true);
    expect(corridorMap.ownerID(anchor!.tile)).toBe(3);
    expect(anchor!.y).toBe(30);
  });

  it("prefers largest connected landmass over tiny disconnected islands and snaps urgently on capital loss", () => {
    const map = createTestMap(160, 100);
    // Mainland island: 30x30 around x=100..130, y=40..70
    map.paintRect(100, 40, 130, 70, 5);
    // Tiny separated fragment across map: 3x3 at x=10..12, y=10..12
    map.paintRect(10, 10, 12, 12, 5);
    // Water separator
    for (let y = 0; y < 100; y++) {
      for (let x = 30; x < 80; x++) {
        map.setWater(x, y);
      }
    }

    const mgr = new TerritoryAnchorManager();
    for (let y = 40; y <= 70; y++) {
      for (let x = 100; x <= 130; x++) {
        mgr.recordTileChange(0, 5, x, y);
      }
    }
    for (let y = 10; y <= 12; y++) {
      for (let x = 10; x <= 12; x++) {
        mgr.recordTileChange(0, 5, x, y);
      }
    }

    const initial = mgr.resolveAnchor(
      map,
      5,
      31 * 31 + 9,
      map.ref(105, 45),
      1,
      true,
    );
    expect(initial).not.toBeNull();
    // Should lock onto mainland (100..130), not tiny fragment (10..12)
    expect(initial!.x).toBeGreaterThanOrEqual(100);
    expect(map.ownerID(initial!.tile)).toBe(5);

    // Enemy captures the mainland capital + old anchor tile! Keep a remaining island at 10..20
    map.paintRect(100, 40, 130, 70, 9);
    map.paintRect(10, 10, 22, 22, 5);
    for (let y = 10; y <= 22; y++) {
      for (let x = 10; x <= 22; x++) {
        mgr.recordTileChange(0, 5, x, y);
      }
    }

    const recovered = mgr.resolveAnchor(
      map,
      5,
      13 * 13,
      map.ref(105, 45), // Old capital is now enemy-owned
      2,
      false, // Even with non-urgent budget disabled, current anchor lost -> urgent snap!
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.urgentSnap).toBe(true);
    expect(map.ownerID(recovered!.tile)).toBe(5);
    expect(recovered!.x).toBeLessThanOrEqual(22);
  });

  it("handles rapid expansion, contraction, AI country avatar config, and smooth AvatarSystem interpolation", () => {
    const map = createTestMap(120, 120);
    map.paintRect(20, 20, 30, 30, 4);
    const mgr = new TerritoryAnchorManager();
    for (let y = 20; y <= 30; y++) {
      for (let x = 20; x <= 30; x++) mgr.recordTileChange(0, 4, x, y);
    }

    const a1 = mgr.resolveAnchor(map, 4, 121, map.ref(25, 25), 1, true)!;
    // Cached hit without recompute on tick 2 when no meaningful change occurred
    const a1Cached = mgr.resolveAnchor(map, 4, 121, map.ref(25, 25), 2, true)!;
    expect(a1Cached.tile).toBe(a1.tile);

    // Rapid expansion to x=20..90, y=20..90
    map.paintRect(20, 20, 90, 90, 4);
    for (let y = 20; y <= 90; y++) {
      for (let x = 20; x <= 90; x++) mgr.recordTileChange(0, 4, x, y);
    }
    const expanded = mgr.resolveAnchor(
      map,
      4,
      71 * 71,
      map.ref(25, 25),
      25,
      true,
    )!;
    expect(expanded.x).toBeGreaterThan(40);
    expect(expanded.y).toBeGreaterThan(40);

    // Contraction back to right half (x=65..90, y=65..90)
    map.paintRect(20, 20, 90, 90, 8);
    map.paintRect(65, 65, 90, 90, 4);
    const contracted = mgr.resolveAnchor(
      map,
      4,
      26 * 26,
      map.ref(25, 25),
      50,
      true,
    )!;
    expect(map.ownerID(contracted.tile)).toBe(4);
    expect(contracted.x).toBeGreaterThanOrEqual(65);

    // AvatarSystem interpolation + distinct AI country colors + UI portrait identity scale
    const avatars = new AvatarSystem();
    const aiCfg = deriveCountryAvatarConfig("bot_alpha", "#ef4444");
    const aiAvatar = avatars.registerAvatar(
      "bot_alpha",
      4,
      25,
      25,
      aiCfg,
      false,
    );
    avatars.setTerritoryState("bot_alpha", 75, 75, 2.8, false);
    // Smooth partial step after 100ms (not instant jump)
    avatars.update(100);
    expect(aiAvatar.capitalX).toBeGreaterThan(25);
    expect(aiAvatar.capitalX).toBeLessThan(75);
    expect(aiAvatar.territoryScale).toBeGreaterThan(1);
    expect(aiAvatar.territoryScale).toBeLessThan(2.8);

    // Render with zoomed camera transforms & verify scale call occurs cleanly
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
    } as unknown as CanvasRenderingContext2D;

    avatars.render(mockCtx, 10, undefined, 0.5);
    expect(mockCtx.scale).toHaveBeenCalled();

    // Standalone portrait without territoryScale keeps identity (no extra ctx.scale)
    (mockCtx.scale as ReturnType<typeof vi.fn>).mockClear();
    avatars.drawAvatar(
      mockCtx,
      {
        id: "portrait",
        playerId: 0,
        capitalX: 36,
        capitalY: 46,
        state: "idle",
        stateTimerMs: 0,
        targetX: 36,
        targetY: 46,
        config: aiCfg,
      },
      1,
    );
    expect(mockCtx.scale).not.toHaveBeenCalled();
  });
});
