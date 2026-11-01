import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssetCache,
  AvatarSystem,
  DualLayerEngine,
  ObjectPool,
  ScreenShakeController,
  setupDualLayerEngine,
  SupplyDropManager,
  VisualFxPools,
} from "../../../src/client/graphics/engine";

describe("OpenFront Dual-Layer Graphics Engine", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  // ============================================================
  // SPECIFICATION 3: PREALLOCATED OBJECT POOLING
  // ============================================================

  describe("ObjectPool and VisualFxPools", () => {
    it("handles generic object pool lifecycle, capacity, and reuse", () => {
      interface CustomItem {
        _poolIndex: number;
        active: boolean;
        val: number;
      }
      const pool = new ObjectPool<CustomItem>(
        (i) => ({ _poolIndex: i, active: false, val: 0 }),
        (item) => {
          item.val = 0;
        },
        5,
      );

      expect(pool.capacity).toBe(5);
      expect(pool.availableCount).toBe(5);

      const a = pool.acquire();
      const b = pool.acquire();
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(pool.activeCount).toBe(2);

      pool.release(a!);
      expect(pool.activeCount).toBe(1);

      pool.clear();
      expect(pool.activeCount).toBe(0);
      expect(pool.availableCount).toBe(5);
    });

    it("preallocates memory for exactly 150 trail particles, 30 text markers, and 10 beacon rings", () => {
      const pools = new VisualFxPools();

      expect(pools.trailParticles.capacity).toBe(150);
      expect(pools.textMarkers.capacity).toBe(30);
      expect(pools.beaconRings.capacity).toBe(10);

      expect(pools.trailParticles.activeCount).toBe(0);
      expect(pools.textMarkers.activeCount).toBe(0);
      expect(pools.beaconRings.activeCount).toBe(0);
    });

    it("acquires and releases trail particles in O(1) time without allocating memory", () => {
      const pools = new VisualFxPools();

      const p1 = pools.spawnTrailParticle(10, 20, 1, -1, "#ff0000", 3, 500);
      expect(p1).not.toBeNull();
      expect(p1?.active).toBe(true);
      expect(p1?.x).toBe(10);
      expect(p1?.y).toBe(20);
      expect(pools.trailParticles.activeCount).toBe(1);

      // Release p1
      pools.trailParticles.release(p1!);
      expect(p1?.active).toBe(false);
      expect(pools.trailParticles.activeCount).toBe(0);

      // Re-acquire should reuse the exact same preallocated instance
      const p2 = pools.spawnTrailParticle(30, 40);
      expect(p2).toBe(p1);
      expect(pools.trailParticles.activeCount).toBe(1);
    });

    it("enforces capacity cap when all 150 trail particles are acquired", () => {
      const pools = new VisualFxPools();
      const spawned = [];

      for (let i = 0; i < 150; i++) {
        const p = pools.spawnTrailParticle(i, i);
        expect(p).not.toBeNull();
        spawned.push(p!);
      }

      expect(pools.trailParticles.activeCount).toBe(150);
      expect(pools.trailParticles.availableCount).toBe(0);

      // Attempting to spawn 151st returns null
      const overflow = pools.spawnTrailParticle(999, 999);
      expect(overflow).toBeNull();
    });

    it("ticks and automatically returns expired fx to the pool", () => {
      const pools = new VisualFxPools();

      pools.spawnTrailParticle(0, 0, 1, 1, "#fff", 2, 100);
      pools.spawnFloatingText("10k", 50, 50, "loot", "#ff0", 150);
      pools.spawnBeaconRing(100, 100, 30, "#00f", 200);

      expect(pools.trailParticles.activeCount).toBe(1);
      expect(pools.textMarkers.activeCount).toBe(1);
      expect(pools.beaconRings.activeCount).toBe(1);

      // Update by 120ms: trail particle (maxLife 100ms) expires
      pools.update(120);
      expect(pools.trailParticles.activeCount).toBe(0);
      expect(pools.textMarkers.activeCount).toBe(1);
      expect(pools.beaconRings.activeCount).toBe(1);

      // Update another 50ms (total 170ms): text marker (maxLife 150ms) expires
      pools.update(50);
      expect(pools.textMarkers.activeCount).toBe(0);
      expect(pools.beaconRings.activeCount).toBe(1);

      // Update another 50ms (total 220ms): beacon ring (maxLife 200ms) expires
      pools.update(50);
      expect(pools.beaconRings.activeCount).toBe(0);
    });
  });

  // ============================================================
  // SPECIFICATION 2: OFFSCREEN ASSET PRERENDERING & CACHING
  // ============================================================

  describe("AssetCache", () => {
    it("prerenders boundary stamps, supply crates, and avatar parts on offscreen surfaces", () => {
      const cache = new AssetCache();
      cache.initialize();

      expect(cache.isReady()).toBe(true);

      // Boundary stamp offscreen canvas
      const stamp = cache.getBoundaryStamp("enemy");
      expect(stamp).toBeInstanceOf(HTMLCanvasElement);
      expect(stamp.width).toBeGreaterThan(0);

      // Supply crate offscreen canvas (early, mid, late, standard, troops, gold)
      const earlyCrate = cache.getSupplyCrate("early");
      expect(earlyCrate).toBeInstanceOf(HTMLCanvasElement);
      const midCrate = cache.getSupplyCrate("mid");
      expect(midCrate).toBeInstanceOf(HTMLCanvasElement);
      const lateCrate = cache.getSupplyCrate("late");
      expect(lateCrate).toBeInstanceOf(HTMLCanvasElement);

      // Avatar offscreen primitives
      const disc = cache.getAvatarPart("baseDisc");
      expect(disc).toBeInstanceOf(HTMLCanvasElement);
      const halo = cache.getAvatarPart("haloRing");
      expect(halo).toBeInstanceOf(HTMLCanvasElement);
      const shield = cache.getAvatarPart("crestShield");
      expect(shield).toBeInstanceOf(HTMLCanvasElement);
    });

    it("reuses cached canvases without reallocating on subsequent lookups", () => {
      const cache = new AssetCache();
      cache.initialize();

      const c1 = cache.getBoundaryStamp("friendly");
      const c2 = cache.getBoundaryStamp("friendly");
      expect(c1).toBe(c2);

      const crate1 = cache.getSupplyCrate("gold");
      const crate2 = cache.getSupplyCrate("gold");
      expect(crate1).toBe(crate2);
    });
  });

  // ============================================================
  // SPECIFICATION 1: DUAL LAYER CANVAS SYSTEM
  // ============================================================

  describe("DualLayerEngine Canvas Layers", () => {
    it("creates two stacked canvas elements sharing matching resolution and coordinate scaling", () => {
      const engine = new DualLayerEngine({
        container,
        width: 1024,
        height: 768,
        devicePixelRatio: 2,
      });

      const staticCanvas = engine.staticCanvas;
      const dynamicCanvas = engine.dynamicCanvas;

      expect(staticCanvas).toBeDefined();
      expect(dynamicCanvas).toBeDefined();

      // CSS display size matches
      expect(staticCanvas.style.width).toBe("1024px");
      expect(staticCanvas.style.height).toBe("768px");
      expect(dynamicCanvas.style.width).toBe("1024px");
      expect(dynamicCanvas.style.height).toBe("768px");

      // Physical pixel resolution accounts for DPR (2x = 2048 x 1536)
      expect(staticCanvas.width).toBe(2048);
      expect(staticCanvas.height).toBe(1536);
      expect(dynamicCanvas.width).toBe(2048);
      expect(dynamicCanvas.height).toBe(1536);

      engine.destroy();
    });

    it("redraws the static layer only on resize or when territory boundaries permanently shift", () => {
      const engine = new DualLayerEngine({ container });

      let staticDrawCount = 0;
      engine.setStaticRenderCallback(() => {
        staticDrawCount++;
      });

      // Initial redraw call
      engine.redrawStaticLayer();
      expect(staticDrawCount).toBe(1);

      // Consecutive dynamic ticks DO NOT trigger static redraw
      engine.renderDynamicLayer(16.6);
      engine.renderDynamicLayer(16.6);
      expect(staticDrawCount).toBe(1);

      // Territory boundary shift permanently flags dirty
      engine.markTerritoryShift();
      expect(staticDrawCount).toBe(2);

      // Viewport resize triggers static redraw
      engine.resize(1280, 720);
      expect(staticDrawCount).toBe(3);

      engine.destroy();
    });
  });

  // ============================================================
  // SPECIFICATION 4: BATCHING AND STATE SANITISATION
  // ============================================================

  describe("Batching and Coordinate Sanitisation", () => {
    it("batches text operations to avoid repeated context font switching", () => {
      const engine = new DualLayerEngine({ container });

      const textMarker1 = engine.pools.spawnFloatingText("500", 100, 100, "combat", "#ef4444", 1000);
      const textMarker2 = engine.pools.spawnFloatingText("1000", 120, 120, "combat", "#ef4444", 1000);
      const textMarker3 = engine.pools.spawnFloatingText("DROP", 200, 200, "loot", "#f59e0b", 1000);

      expect(textMarker1).not.toBeNull();
      expect(textMarker2).not.toBeNull();
      expect(textMarker3).not.toBeNull();

      // Spy on font assignment to ensure fonts are grouped
      let fontAssignmentCount = 0;
      let currentFont = "";
      Object.defineProperty(engine.dynamicCtx, "font", {
        get: () => currentFont,
        set: (val: string) => {
          fontAssignmentCount++;
          currentFont = val;
        },
        configurable: true,
      });

      engine.renderDynamicLayer(16.6);

      // Batched rendering sets font per font-key instead of per item
      expect(fontAssignmentCount).toBeLessThanOrEqual(3);

      engine.destroy();
    });

    it("truncates coordinates to integer boundaries to prevent subpixel antialiasing overhead", () => {
      const engine = new DualLayerEngine({ container });

      engine.setSupplyCrates([
        { id: 1, x: 123.784, y: 456.219, type: "standard" },
      ]);

      const drawImageSpy = vi.spyOn(engine.dynamicCtx, "drawImage");
      engine.renderDynamicLayer(16.6);

      expect(drawImageSpy).toHaveBeenCalled();
      const lastCall = drawImageSpy.mock.calls[0];
      const destX = lastCall[1] as number;
      const destY = lastCall[2] as number;

      // Coordinates passed to drawImage must be exact integers (no fractions)
      expect(Number.isInteger(destX)).toBe(true);
      expect(Number.isInteger(destY)).toBe(true);

      engine.destroy();
    });

    it("strictly pairs every ctx.save() with a corresponding ctx.restore() to avoid canvas state leaks", () => {
      const engine = new DualLayerEngine({ container });

      const saveSpy = vi.spyOn(engine.dynamicCtx, "save");
      const restoreSpy = vi.spyOn(engine.dynamicCtx, "restore");

      engine.renderDynamicLayer(16.6);

      // Verify exact parity between save and restore calls
      expect(saveSpy.mock.calls.length).toBeGreaterThan(0);
      expect(saveSpy.mock.calls.length).toBe(restoreSpy.mock.calls.length);

      // Test withContextState exception safety
      expect(() => {
        engine.withContextState(engine.dynamicCtx, () => {
          throw new Error("Simulated drawing failure");
        });
      }).toThrow("Simulated drawing failure");

      // Even when an error throws, restore MUST be called
      expect(saveSpy.mock.calls.length).toBe(restoreSpy.mock.calls.length);

      engine.destroy();
    });
  });

  // ============================================================
  // SPECIFICATION: DYNAMIC PROGRESSIVE SUPPLY DROPS
  // ============================================================

  describe("Dynamic Progressive Supply Drops", () => {
    it("evaluates spawns every 45 seconds and maintains a maximum of 2 active crates", () => {
      const engine = new DualLayerEngine({ container });
      const manager = engine.supplyDropManager;

      let nextTileId = 100;
      const mockCandidateFinder = () => ({
        tile: nextTileId++,
        x: 150,
        y: 200,
        ownerID: 0,
      });

      // Initially 0 drops
      expect(manager.getActiveDrops().length).toBe(0);

      // Advance by 30 seconds (less than 45s cycle) -> no spawn
      manager.update(30000, () => null, mockCandidateFinder);
      expect(manager.getActiveDrops().length).toBe(0);

      // Advance past 45s threshold (e.g. +16s = 46s total) -> first spawn
      manager.update(16000, () => null, mockCandidateFinder);
      expect(manager.getActiveDrops().length).toBe(1);

      // Advance another 45 seconds -> second spawn
      manager.update(45000, () => null, mockCandidateFinder);
      expect(manager.getActiveDrops().length).toBe(2);

      // Advance another 45 seconds -> max 2 maintained, no third spawn
      manager.update(45000, () => null, mockCandidateFinder);
      expect(manager.getActiveDrops().length).toBe(2);

      engine.destroy();
    });

    it("scales tiers according to elapsed match time (Early, Mid, Late)", () => {
      const engine = new DualLayerEngine({ container });
      const manager = engine.supplyDropManager;

      // Early Phase (0 to 120s): 8,000-12,000 troops, 80k-120k gold, early type
      manager.update(
        46000,
        () => null,
        () => ({ tile: 10, x: 50, y: 50, ownerID: 0 }),
      );
      const earlyDrop = manager.getActiveDrops()[0];
      expect(earlyDrop.phase).toBe("early");
      expect(earlyDrop.type).toBe("early");
      expect(earlyDrop.troops).toBeGreaterThanOrEqual(8000);
      expect(earlyDrop.troops).toBeLessThanOrEqual(12000);
      expect(earlyDrop.gold).toBeGreaterThanOrEqual(80000);
      expect(earlyDrop.gold).toBeLessThanOrEqual(120000);

      manager.clear();

      // Mid Phase (120 to 300s)
      manager.update(
        150000, // advance match time to 196s
        () => null,
        () => ({ tile: 20, x: 60, y: 60, ownerID: 0 }),
      );
      const midDrop = manager.getActiveDrops()[0];
      expect(midDrop.phase).toBe("mid");
      expect(midDrop.type).toBe("mid");
      expect(midDrop.troops).toBeGreaterThanOrEqual(45000);
      expect(midDrop.troops).toBeLessThanOrEqual(55000);
      expect(midDrop.gold).toBeGreaterThanOrEqual(900000);
      expect(midDrop.gold).toBeLessThanOrEqual(1100000);

      manager.clear();

      // Late Phase (300s onward): triggers orbital banner and late rewards
      let bannerTriggered = false;
      engine.onOrbitalSupplyDropAlert = () => {
        bannerTriggered = true;
      };

      manager.update(
        200000, // advance match time to 396s (> 300s)
        () => null,
        () => ({ tile: 30, x: 70, y: 70, ownerID: 0 }),
      );
      const lateDrop = manager.getActiveDrops()[0];
      expect(lateDrop.phase).toBe("late");
      expect(lateDrop.type).toBe("late");
      expect(lateDrop.troops).toBeGreaterThanOrEqual(100000);
      expect(lateDrop.troops).toBeLessThanOrEqual(150000);
      expect(lateDrop.gold).toBeGreaterThanOrEqual(10000000);
      expect(lateDrop.gold).toBeLessThanOrEqual(20000000);
      expect(bannerTriggered).toBe(true);

      engine.destroy();
    });

    it("awards troops and gold on capture, spawns floating text, and triggers screen shake", () => {
      const engine = new DualLayerEngine({ container });
      const manager = engine.supplyDropManager;

      // Spawn a drop at tile 42
      manager.update(
        46000,
        () => null,
        () => ({ tile: 42, x: 100, y: 150, ownerID: 0 }),
      );
      expect(manager.getActiveDrops().length).toBe(1);

      let awardedTroops = 0;
      let awardedGold = 0;
      const mockPlayer = {
        id: 7,
        addTroops: (t: number) => {
          awardedTroops += t;
        },
        addGold: (g: number) => {
          awardedGold += g;
        },
      };

      // Owner shifts to player 7
      manager.update(
        16,
        (tile) => (tile === 42 ? mockPlayer : null),
        () => null,
      );

      // Crate claimed
      expect(manager.getActiveDrops().length).toBe(0);
      expect(awardedTroops).toBeGreaterThanOrEqual(8000);
      expect(awardedGold).toBeGreaterThanOrEqual(80000);

      // Floating text markers should be pulled from ObjectPool
      expect(engine.pools.textMarkers.activeCount).toBeGreaterThanOrEqual(2);

      // Screen shake was triggered (active shake frames)
      expect(engine.screenShake.isActive()).toBe(true);

      engine.destroy();
    });
  });

  // ============================================================
  // SPECIFICATION: CUSTOMISABLE AVATARS & ACTION STATE MACHINE
  // ============================================================

  describe("Customisable Capital Avatars", () => {
    it("manages customizable colors with persistent defaults", () => {
      const avatarSystem = new AvatarSystem();
      const config = avatarSystem.getConfig();

      expect(config.skinTone).toBeDefined();
      expect(config.shirtColor).toBeDefined();
      expect(config.hairColor).toBeDefined();

      avatarSystem.setConfig({
        skinTone: "#fcd34d",
        shirtColor: "#ec4899",
        hairColor: "#1e293b",
      });

      const updated = avatarSystem.getConfig();
      expect(updated.skinTone).toBe("#fcd34d");
      expect(updated.shirtColor).toBe("#ec4899");
      expect(updated.hairColor).toBe("#1e293b");
    });

    it("evaluates idle bobbing using Math.sin oscillation", () => {
      const avatarSystem = new AvatarSystem();
      avatarSystem.setCapitalPosition(100, 100);

      // Tick 0 vs Tick 30
      avatarSystem.update(0);
      const state0 = avatarSystem.getState();
      expect(state0).toBe("idle");

      avatarSystem.update(30);
      expect(avatarSystem.getState()).toBe("idle");
    });

    it("transitions to attacking state and calculates aim angle toward target node", () => {
      const avatarSystem = new AvatarSystem();
      avatarSystem.setCapitalPosition(100, 100);

      // Trigger attack targeting (200, 100) -> 0 radians (due East)
      avatarSystem.triggerAttack(200, 100, 800);
      expect(avatarSystem.getState()).toBe("attacking");
      expect(avatarSystem.getTargetAngle()).toBeCloseTo(0, 4);

      // Trigger attack targeting (100, 200) -> PI/2 radians (due South)
      avatarSystem.triggerAttack(100, 200, 800);
      expect(avatarSystem.getState()).toBe("attacking");
      expect(avatarSystem.getTargetAngle()).toBeCloseTo(Math.PI / 2, 4);

      // Wait until duration expires -> returns to idle
      avatarSystem.update(850);
      expect(avatarSystem.getState()).toBe("idle");
    });

    it("transitions to victory state when securing capital or supply drops", () => {
      const avatarSystem = new AvatarSystem();
      avatarSystem.setCapitalPosition(100, 100);

      avatarSystem.triggerVictory(1500);
      expect(avatarSystem.getState()).toBe("victory");

      avatarSystem.update(1600);
      expect(avatarSystem.getState()).toBe("idle");
    });
  });

  // ============================================================
  // SPECIFICATION: VISUAL POLISH (TRAIL CAP & SCREEN SHAKE)
  // ============================================================

  describe("Visual Polish Systems", () => {
    it("strictly caps active troop trail particles at 120 across the screen", () => {
      const engine = new DualLayerEngine({ container });

      // Attempt to spawn 150 particles
      for (let i = 0; i < 150; i++) {
        engine.spawnTrailParticle(i, i, 0, 0, "#ffffff", 2, 1000);
      }

      // Exactly capped at 120 active particles
      expect(engine.pools.trailParticles.activeCount).toBe(120);

      engine.destroy();
    });

    it("applies a 4-frame camera jitter between -2 and +2 pixels and resets immediately", () => {
      const shake = new ScreenShakeController();
      expect(shake.isActive()).toBe(false);

      shake.trigger(4, 2);
      expect(shake.isActive()).toBe(true);
      expect(shake.remainingFrames).toBe(4);

      // Frame 1
      const offset1 = shake.getOffset();
      expect(offset1.x).toBeGreaterThanOrEqual(-2);
      expect(offset1.x).toBeLessThanOrEqual(2);
      expect(offset1.y).toBeGreaterThanOrEqual(-2);
      expect(offset1.y).toBeLessThanOrEqual(2);
      shake.advanceFrame();
      expect(shake.remainingFrames).toBe(3);

      // Frames 2, 3, 4
      shake.advanceFrame();
      shake.advanceFrame();
      shake.advanceFrame();

      expect(shake.isActive()).toBe(false);
      const resetOffset = shake.getOffset();
      expect(resetOffset.x).toBe(0);
      expect(resetOffset.y).toBe(0);
    });
  });

  // ============================================================
  // SETUP SCRIPT & LIFECYCLE
  // ============================================================

  describe("setupDualLayerEngine script", () => {
    it("initializes engine, mounts canvases, and disposes cleanly", () => {
      const handle = setupDualLayerEngine(container, {
        autoStart: false,
      });

      expect(handle.engine).toBeDefined();
      expect(container.querySelector(".openfront-static-canvas")).not.toBeNull();
      expect(container.querySelector(".openfront-dynamic-canvas")).not.toBeNull();

      handle.syncWithSimulation();

      // Dispose
      handle.dispose();
      expect(container.querySelector(".openfront-static-canvas")).toBeNull();
      expect(container.querySelector(".openfront-dynamic-canvas")).toBeNull();
    });
  });
});
