/**
 * OpenFront Dual-Layer Graphics Engine - Object Pooling Architecture
 *
 * Generic, fixed-size object pool designed for zero-allocation dynamic rendering loops.
 * Preallocates memory for trail particles, floating combat/loot text markers,
 * and animated beacon rings to prevent garbage collection pauses on school laptops.
 */

export interface IPoolable {
  _poolIndex: number;
  active: boolean;
}

export class ObjectPool<T extends IPoolable> {
  private readonly pool: T[];
  private readonly freeIndices: Int32Array;
  private freeHead = 0;
  private readonly _capacity: number;
  private readonly resetFn: (item: T) => void;

  constructor(
    factory: (index: number) => T,
    resetFn: (item: T) => void,
    capacity: number,
  ) {
    if (capacity <= 0) {
      throw new Error(`ObjectPool capacity must be greater than 0, got ${capacity}`);
    }
    this._capacity = capacity;
    this.resetFn = resetFn;
    this.pool = new Array<T>(capacity);
    this.freeIndices = new Int32Array(capacity);

    for (let i = 0; i < capacity; i++) {
      const item = factory(i);
      item._poolIndex = i;
      item.active = false;
      this.resetFn(item);
      this.pool[i] = item;
      this.freeIndices[i] = i;
    }
    this.freeHead = capacity;
  }

  public get capacity(): number {
    return this._capacity;
  }

  public get activeCount(): number {
    return this._capacity - this.freeHead;
  }

  public get availableCount(): number {
    return this.freeHead;
  }

  /**
   * Acquire an inactive object from the pool in O(1) time without heap allocations.
   * Returns null if pool capacity is exhausted.
   */
  public acquire(): T | null {
    if (this.freeHead <= 0) {
      return null;
    }
    this.freeHead--;
    const index = this.freeIndices[this.freeHead];
    const item = this.pool[index];
    item.active = true;
    this.resetFn(item);
    return item;
  }

  /**
   * Deactivate and return an object back to the pool in O(1) time.
   */
  public release(item: T): void {
    if (!item.active) {
      return;
    }
    item.active = false;
    this.resetFn(item);
    this.freeIndices[this.freeHead] = item._poolIndex;
    this.freeHead++;
  }

  /**
   * Iterate over all currently active items in the pool without allocating an array.
   */
  public forEachActive(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this._capacity; i++) {
      const item = this.pool[i];
      if (item.active) {
        callback(item, i);
      }
    }
  }

  /**
   * Get raw underlying array for high-performance direct loop iterations.
   */
  public getRawPool(): readonly T[] {
    return this.pool;
  }

  /**
   * Return all active items back to the pool.
   */
  public clear(): void {
    for (let i = 0; i < this._capacity; i++) {
      const item = this.pool[i];
      if (item.active) {
        item.active = false;
        this.resetFn(item);
      }
      this.freeIndices[i] = i;
    }
    this.freeHead = this._capacity;
  }
}

// ==========================================
// POOLED TYPES AND SPECIFICATIONS
// ==========================================

export interface TrailParticle extends IPoolable {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export type TextMarkerType = "combat" | "loot" | "info";

export interface FloatingTextMarker extends IPoolable {
  x: number;
  y: number;
  startY: number;
  riseDistance: number;
  text: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  life: number;
  maxLife: number;
  alpha: number;
  type: TextMarkerType;
}

export interface BeaconRing extends IPoolable {
  x: number;
  y: number;
  startRadius: number;
  maxRadius: number;
  currentRadius: number;
  lineWidth: number;
  color: string;
  life: number;
  maxLife: number;
  pulseSpeed: number;
  alpha: number;
}

/**
 * VisualFxPools manages the fixed preallocated pools required by OpenFront:
 * - 150 unit trail particles
 * - 30 floating combat and loot text markers
 * - 10 animated beacon rings
 */
export class VisualFxPools {
  public static readonly TRAIL_PARTICLE_CAPACITY = 150;
  public static readonly FLOATING_TEXT_CAPACITY = 30;
  public static readonly BEACON_RING_CAPACITY = 10;

  public readonly trailParticles: ObjectPool<TrailParticle>;
  public readonly textMarkers: ObjectPool<FloatingTextMarker>;
  public readonly beaconRings: ObjectPool<BeaconRing>;

  constructor() {
    // 150 unit trail particles
    this.trailParticles = new ObjectPool<TrailParticle>(
      (i) => ({
        _poolIndex: i,
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        alpha: 1,
        life: 0,
        maxLife: 600,
        size: 2,
        color: "#ffffff",
      }),
      (p) => {
        p.x = 0;
        p.y = 0;
        p.vx = 0;
        p.vy = 0;
        p.alpha = 1;
        p.life = 0;
        p.maxLife = 600;
        p.size = 2;
        p.color = "#ffffff";
      },
      VisualFxPools.TRAIL_PARTICLE_CAPACITY,
    );

    // 30 floating combat and loot text markers
    this.textMarkers = new ObjectPool<FloatingTextMarker>(
      (i) => ({
        _poolIndex: i,
        active: false,
        x: 0,
        y: 0,
        startY: 0,
        riseDistance: 18,
        text: "",
        color: "#ffffff",
        fontSize: 12,
        fontFamily: "Overpass, sans-serif",
        life: 0,
        maxLife: 1000,
        alpha: 1,
        type: "info",
      }),
      (t) => {
        t.x = 0;
        t.y = 0;
        t.startY = 0;
        t.riseDistance = 18;
        t.text = "";
        t.color = "#ffffff";
        t.fontSize = 12;
        t.fontFamily = "Overpass, sans-serif";
        t.life = 0;
        t.maxLife = 1000;
        t.alpha = 1;
        t.type = "info";
      },
      VisualFxPools.FLOATING_TEXT_CAPACITY,
    );

    // 10 animated beacon rings
    this.beaconRings = new ObjectPool<BeaconRing>(
      (i) => ({
        _poolIndex: i,
        active: false,
        x: 0,
        y: 0,
        startRadius: 4,
        maxRadius: 28,
        currentRadius: 4,
        lineWidth: 2,
        color: "#38bdf8",
        life: 0,
        maxLife: 1200,
        pulseSpeed: 1,
        alpha: 1,
      }),
      (b) => {
        b.x = 0;
        b.y = 0;
        b.startRadius = 4;
        b.maxRadius = 28;
        b.currentRadius = 4;
        b.lineWidth = 2;
        b.color = "#38bdf8";
        b.life = 0;
        b.maxLife = 1200;
        b.pulseSpeed = 1;
        b.alpha = 1;
      },
      VisualFxPools.BEACON_RING_CAPACITY,
    );
  }

  /**
   * Spawn a unit trail particle from the preallocated pool.
   */
  public spawnTrailParticle(
    x: number,
    y: number,
    vx = 0,
    vy = 0,
    color = "#ffffff",
    size = 2,
    durationMs = 600,
  ): TrailParticle | null {
    const p = this.trailParticles.acquire();
    if (!p) return null;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.color = color;
    p.size = size;
    p.maxLife = durationMs;
    p.life = 0;
    p.alpha = 1;
    return p;
  }

  /**
   * Spawn a floating combat or loot text marker from the preallocated pool.
   */
  public spawnFloatingText(
    text: string,
    x: number,
    y: number,
    type: TextMarkerType = "info",
    color = "#ffffff",
    durationMs = 1200,
    riseDistance = 18,
    fontSize = 12,
  ): FloatingTextMarker | null {
    const m = this.textMarkers.acquire();
    if (!m) return null;
    m.text = text;
    m.x = x;
    m.y = y;
    m.startY = y;
    m.type = type;
    m.color = color;
    m.maxLife = durationMs;
    m.life = 0;
    m.riseDistance = riseDistance;
    m.fontSize = fontSize;
    m.alpha = 1;
    return m;
  }

  /**
   * Spawn an animated beacon ring from the preallocated pool.
   */
  public spawnBeaconRing(
    x: number,
    y: number,
    colorOrRadius: string | number = "#38bdf8",
    startRadiusOrColor: number | string = 4,
    maxRadiusOrDuration = 28,
    durationMs = 1200,
    lineWidth = 2,
  ): BeaconRing | null {
    const b = this.beaconRings.acquire();
    if (!b) return null;
    b.x = x;
    b.y = y;

    let color = "#38bdf8";
    let startRadius = 4;
    let maxRadius = 28;
    let dur: number;

    if (typeof colorOrRadius === "number") {
      startRadius = colorOrRadius;
      if (typeof startRadiusOrColor === "string") {
        color = startRadiusOrColor;
      }
      dur = maxRadiusOrDuration;
    } else {
      color = colorOrRadius;
      if (typeof startRadiusOrColor === "number") {
        startRadius = startRadiusOrColor;
      }
      maxRadius = maxRadiusOrDuration;
      dur = durationMs;
    }

    b.color = color;
    b.startRadius = startRadius;
    b.maxRadius = maxRadius;
    b.currentRadius = startRadius;
    b.maxLife = dur;
    b.life = 0;
    b.lineWidth = lineWidth;
    b.alpha = 1;
    return b;
  }

  /**
   * Advance simulation time and update active pooled objects in-place.
   * Deactivates and returns objects to their pool when duration expires.
   */
  public update(deltaMs: number): void {
    // 1. Update trail particles
    const particles = this.trailParticles.getRawPool();
    for (let i = 0; i < VisualFxPools.TRAIL_PARTICLE_CAPACITY; i++) {
      const p = particles[i];
      if (!p.active) continue;

      p.life += deltaMs;
      if (p.life >= p.maxLife) {
        this.trailParticles.release(p);
      } else {
        const progress = p.life / p.maxLife;
        p.x += p.vx * (deltaMs / 1000);
        p.y += p.vy * (deltaMs / 1000);
        p.alpha = Math.max(0, 1 - progress);
      }
    }

    // 2. Update floating text markers
    const markers = this.textMarkers.getRawPool();
    for (let i = 0; i < VisualFxPools.FLOATING_TEXT_CAPACITY; i++) {
      const m = markers[i];
      if (!m.active) continue;

      m.life += deltaMs;
      if (m.life >= m.maxLife) {
        this.textMarkers.release(m);
      } else {
        const progress = m.life / m.maxLife;
        // Ease-out upward motion
        const easeOut = 1 - Math.pow(1 - progress, 2);
        m.y = m.startY - m.riseDistance * easeOut;
        m.alpha = progress > 0.7 ? Math.max(0, (1 - progress) / 0.3) : 1;
      }
    }

    // 3. Update animated beacon rings
    const beacons = this.beaconRings.getRawPool();
    for (let i = 0; i < VisualFxPools.BEACON_RING_CAPACITY; i++) {
      const b = beacons[i];
      if (!b.active) continue;

      b.life += deltaMs;
      if (b.life >= b.maxLife) {
        this.beaconRings.release(b);
      } else {
        const progress = b.life / b.maxLife;
        b.currentRadius = b.startRadius + (b.maxRadius - b.startRadius) * progress;
        b.alpha = Math.max(0, 1 - progress);
      }
    }
  }

  public clearAll(): void {
    this.trailParticles.clear();
    this.textMarkers.clear();
    this.beaconRings.clear();
  }
}
