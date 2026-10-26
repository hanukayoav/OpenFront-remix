/**
 * TacticalOverlayPass — renders real-time tactical map overlays:
 *   Mode 1: Troop Density Heatmap
 *   Mode 2: SAM Air Defense Coverage Dome
 *   Mode 3: Trade & Logistics Efficiency
 *   Mode 4: Naval Threat Zones
 */

import type { UnitState } from "../../types";
import {
  UT_CITY,
  UT_FACTORY,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_WARSHIP,
} from "../../types";
import type { RenderSettings } from "../RenderSettings";
import { createProgram, createTexture2D, shaderSrc } from "../utils/GlUtils";
import { TILE_DEFINES } from "../utils/TileCodec";
import { samRange } from "../utils/NukeTrajectory";

import overlayFragSrc from "../shaders/tactical-overlay/tactical-overlay.frag.glsl?raw";
import overlayVertSrc from "../shaders/tactical-overlay/tactical-overlay.vert.glsl?raw";

export enum TacticalOverlayMode {
  Off = 0,
  TroopDensity = 1,
  SAMCoverage = 2,
  TradeEfficiency = 3,
  NavalThreat = 4,
}

const MAX_SAMS = 64;
const MAX_NAVAL = 64;
const MAX_TRADE_NODES = 64;

export class TacticalOverlayPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private mapW: number;
  private mapH: number;
  private tileTex: WebGLTexture;
  private terrainTex: WebGLTexture;

  private mode: TacticalOverlayMode = TacticalOverlayMode.Off;
  private localPlayerID: number = 0;
  private friendlyPlayerIDs: Set<number> = new Set();

  private program: WebGLProgram;
  private uCamera: WebGLUniformLocation;
  private uMapSize: WebGLUniformLocation;
  private uMode: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uLocalPlayerID: WebGLUniformLocation;
  private uTileTex: WebGLUniformLocation;
  private uDensityTex: WebGLUniformLocation;
  private uTerrainTex: WebGLUniformLocation;

  private uSAMs: WebGLUniformLocation;
  private uSAMCount: WebGLUniformLocation;
  private uNavalThreats: WebGLUniformLocation;
  private uNavalThreatCount: WebGLUniformLocation;
  private uTradeNodes: WebGLUniformLocation;
  private uTradeNodeCount: WebGLUniformLocation;

  private quadVao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;

  private densityTex: WebGLTexture;
  private densityBuffer: Uint8Array;
  private densityDirty = false;
  // Live tile-state reference; density is only computed while the
  // TroopDensity overlay is visible (it was previously a full-map scan on
  // every tick even with the overlay off, which tanked the frame rate).
  private liveTileState: Uint16Array | null = null;
  // True when densityBuffer no longer reflects liveTileState and needs a
  // full recompute before it can be patched incrementally.
  private densityStale = true;

  // Latest units map; entity uniforms are rebuilt lazily in draw().
  private unitsRef: ReadonlyMap<number, UnitState> | null = null;
  private entitiesDirty = false;

  private samData = new Float32Array(MAX_SAMS * 4);
  private samCount = 0;

  private navalData = new Float32Array(MAX_NAVAL * 4);
  private navalCount = 0;

  private tradeNodeData = new Float32Array(MAX_TRADE_NODES * 4);
  private tradeNodeCount = 0;

  constructor(
    gl: WebGL2RenderingContext,
    mapW: number,
    mapH: number,
    tileTex: WebGLTexture,
    terrainTex: WebGLTexture,
    settings: RenderSettings,
  ) {
    this.gl = gl;
    this.mapW = mapW;
    this.mapH = mapH;
    this.tileTex = tileTex;
    this.terrainTex = terrainTex;
    this.settings = settings;
    this.densityBuffer = new Uint8Array(mapW * mapH);

    const fragDef = shaderSrc(overlayFragSrc, TILE_DEFINES);
    this.program = createProgram(gl, overlayVertSrc, fragDef);

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uMapSize = gl.getUniformLocation(this.program, "uMapSize")!;
    this.uMode = gl.getUniformLocation(this.program, "uMode")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;
    this.uLocalPlayerID = gl.getUniformLocation(this.program, "uLocalPlayerID")!;
    this.uTileTex = gl.getUniformLocation(this.program, "uTileTex")!;
    this.uDensityTex = gl.getUniformLocation(this.program, "uDensityTex")!;
    this.uTerrainTex = gl.getUniformLocation(this.program, "uTerrainTex")!;

    this.uSAMs = gl.getUniformLocation(this.program, "uSAMs")!;
    this.uSAMCount = gl.getUniformLocation(this.program, "uSAMCount")!;
    this.uNavalThreats = gl.getUniformLocation(this.program, "uNavalThreats")!;
    this.uNavalThreatCount = gl.getUniformLocation(this.program, "uNavalThreatCount")!;
    this.uTradeNodes = gl.getUniformLocation(this.program, "uTradeNodes")!;
    this.uTradeNodeCount = gl.getUniformLocation(this.program, "uTradeNodeCount")!;

    // Create fullscreen map quad
    this.quadVao = gl.createVertexArray()!;
    this.quadVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    const quad = new Float32Array([
      0, 0,
      mapW, 0,
      0, mapH,
      mapW, 0,
      mapW, mapH,
      0, mapH,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Create Troop Density Texture (R8)
    this.densityTex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
      data: this.densityBuffer,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
  }

  public setMode(mode: TacticalOverlayMode): void {
    this.mode = mode;
    // Density/entity data is only maintained while an overlay is visible, so
    // catch up once on activation instead of paying for it every tick.
    if (mode === TacticalOverlayMode.TroopDensity && this.densityStale) {
      this.recomputeFullDensity();
    }
    if (mode !== TacticalOverlayMode.Off && this.unitsRef !== null) {
      this.entitiesDirty = true;
    }
  }

  public getMode(): TacticalOverlayMode {
    return this.mode;
  }

  public setLocalPlayer(id: number): void {
    this.localPlayerID = id;
    this.entitiesDirty = true;
  }

  public setAllies(allies: Set<number>): void {
    this.friendlyPlayerIDs = allies;
    this.entitiesDirty = true;
  }

  /**
   * Full-state upload (first tick / resync). Only does real work while the
   * TroopDensity overlay is visible; otherwise just remembers the state so a
   * later activation can catch up once.
   */
  public updateDensityFromTiles(
    tileState: Uint16Array,
    _mapW: number = this.mapW,
    _mapH: number = this.mapH,
  ): void {
    this.liveTileState = tileState;
    this.densityStale = true;
    if (this.mode === TacticalOverlayMode.TroopDensity) {
      this.recomputeFullDensity();
    }
  }

  /**
   * Per-tick delta upload. Recomputes only the density cells whose 3x3
   * kernel touches a changed tile, instead of rescanning the whole map.
   */
  public updateDensityFromDelta(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    this.liveTileState = tileState;
    if (this.mode !== TacticalOverlayMode.TroopDensity) {
      this.densityStale = true;
      return;
    }
    if (this.densityStale || changedTiles.length * 4 >= this.densityBuffer.length / 4) {
      // Either we have no valid baseline or the delta is so large a full pass
      // is cheaper than patching.
      this.recomputeFullDensity();
      return;
    }

    const mapW = this.mapW;
    const maxX = mapW - 2;
    const maxY = this.mapH - 2;
    for (let i = 0; i < changedTiles.length; i++) {
      const tile = changedTiles[i];
      const tx = tile % mapW;
      const ty = (tile - tx) / mapW;
      // Density samples sit on odd coordinates; a tile affects every sample
      // within distance 1 on each axis.
      const x0 = tx & 1 ? tx : tx - 1;
      const x1 = tx & 1 ? tx : tx + 1;
      const y0 = ty & 1 ? ty : ty - 1;
      const y1 = ty & 1 ? ty : ty + 1;
      for (let cy = y0; cy <= y1; cy += 2) {
        if (cy < 1 || cy > maxY) continue;
        for (let cx = x0; cx <= x1; cx += 2) {
          if (cx < 1 || cx > maxX) continue;
          this.computeDensitySample(tileState, cx, cy);
        }
      }
    }
    this.densityDirty = true;
  }

  private recomputeFullDensity(): void {
    const tileState = this.liveTileState;
    if (tileState === null) return;
    const mapW = this.mapW;
    const mapH = this.mapH;
    for (let y = 1; y < mapH - 1; y += 2) {
      for (let x = 1; x < mapW - 1; x += 2) {
        this.computeDensitySample(tileState, x, y);
      }
    }
    this.densityStale = false;
    this.densityDirty = true;
  }

  /** Writes the 2x2 density block anchored at the odd sample (x, y). */
  private computeDensitySample(
    tileState: Uint16Array,
    x: number,
    y: number,
  ): void {
    const mapW = this.mapW;
    const idx = y * mapW + x;
    const owner = tileState[idx] & 0xfff;
    let val = 0;
    if (owner !== 0) {
      let count = 0;
      for (let row = idx - mapW; row <= idx + mapW; row += mapW) {
        if ((tileState[row - 1] & 0xfff) === owner) count++;
        if ((tileState[row] & 0xfff) === owner) count++;
        if ((tileState[row + 1] & 0xfff) === owner) count++;
      }
      val = Math.min(255, Math.floor((count / 9) * 255));
    }
    // Unowned samples are written as 0 so lost territory doesn't keep a
    // stale heat value.
    const buf = this.densityBuffer;
    buf[idx] = val;
    buf[idx + 1] = val;
    buf[idx + mapW] = val;
    buf[idx + mapW + 1] = val;
  }

  /**
   * Records the latest units map. The uniform arrays are rebuilt lazily in
   * draw() only when an overlay is visible.
   */
  public updateStructuresAndUnits(
    units: ReadonlyMap<number, UnitState>,
  ): void {
    this.unitsRef = units;
    this.entitiesDirty = true;
  }

  /**
   * Called every tick with the live units map. Warships move, so the naval
   * overlay needs a refresh even when no structure changed.
   */
  public notifyUnitsTick(units: ReadonlyMap<number, UnitState>): void {
    this.unitsRef = units;
    if (this.mode === TacticalOverlayMode.NavalThreat) {
      this.entitiesDirty = true;
    }
  }

  private rebuildEntities(units: ReadonlyMap<number, UnitState>): void {
    // 1. Collect SAM Launchers
    let samIdx = 0;
    // 2. Collect Naval Vessels (Warships)
    let navalIdx = 0;
    // 3. Collect Trade Nodes (Cities, Factories, Ports, Train Stations)
    let tradeIdx = 0;

    const w = this.mapW;

    for (const u of units.values()) {
      if (!u.isActive) continue;
      const x = u.pos % w;
      const y = Math.floor(u.pos / w);
      const isHostile =
        u.ownerID !== this.localPlayerID && !this.friendlyPlayerIDs.has(u.ownerID);

      // SAM
      if (u.unitType === UT_SAM_LAUNCHER && samIdx < MAX_SAMS) {
        const off = samIdx * 4;
        const radius = samRange(u.level ?? 1);
        this.samData[off] = x;
        this.samData[off + 1] = y;
        this.samData[off + 2] = radius;
        this.samData[off + 3] = isHostile ? 1.0 : 0.0;
        samIdx++;
      }

      // Naval Warships
      if (u.unitType === UT_WARSHIP && navalIdx < MAX_NAVAL) {
        const off = navalIdx * 4;
        const range = 24.0; // warship engagement / threat radius
        this.navalData[off] = x;
        this.navalData[off + 1] = y;
        this.navalData[off + 2] = range;
        this.navalData[off + 3] = isHostile ? 1.0 : 0.0;
        navalIdx++;
      }

      // Trade Nodes
      if (
        (u.unitType === UT_CITY ||
          u.unitType === UT_FACTORY ||
          u.unitType === UT_PORT) &&
        tradeIdx < MAX_TRADE_NODES
      ) {
        const off = tradeIdx * 4;
        let nodeType = 0;
        if (u.unitType === UT_FACTORY) nodeType = 1;
        if (u.unitType === UT_PORT) nodeType = 2;

        this.tradeNodeData[off] = x;
        this.tradeNodeData[off + 1] = y;
        this.tradeNodeData[off + 2] = nodeType;
        this.tradeNodeData[off + 3] = 1.0; // active
        tradeIdx++;
      }
    }

    this.samCount = samIdx;
    this.navalCount = navalIdx;
    this.tradeNodeCount = tradeIdx;
  }

  public draw(cameraMatrix: Float32Array): void {
    if (this.mode === TacticalOverlayMode.Off) {
      return;
    }

    const gl = this.gl;

    if (this.entitiesDirty && this.unitsRef !== null) {
      this.rebuildEntities(this.unitsRef);
      this.entitiesDirty = false;
    }

    // Upload density buffer if dirty
    if (this.densityDirty && this.mode === TacticalOverlayMode.TroopDensity) {
      gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.mapW,
        this.mapH,
        gl.RED,
        gl.UNSIGNED_BYTE,
        this.densityBuffer,
      );
      this.densityDirty = false;
    }

    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform2f(this.uMapSize, this.mapW, this.mapH);
    gl.uniform1i(this.uMode, this.mode);
    gl.uniform1f(this.uTime, performance.now() / 1000.0);
    gl.uniform1i(this.uLocalPlayerID, this.localPlayerID);

    // Bind Textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.uniform1i(this.uTileTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
    gl.uniform1i(this.uDensityTex, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.uniform1i(this.uTerrainTex, 2);

    // Upload Tactical Entities
    if (this.mode === TacticalOverlayMode.SAMCoverage) {
      gl.uniform1i(this.uSAMCount, this.samCount);
      if (this.samCount > 0) {
        gl.uniform4fv(this.uSAMs, this.samData);
      }
    } else if (this.mode === TacticalOverlayMode.TradeEfficiency) {
      gl.uniform1i(this.uTradeNodeCount, this.tradeNodeCount);
      if (this.tradeNodeCount > 0) {
        gl.uniform4fv(this.uTradeNodes, this.tradeNodeData);
      }
    } else if (this.mode === TacticalOverlayMode.NavalThreat) {
      gl.uniform1i(this.uNavalThreatCount, this.navalCount);
      if (this.navalCount > 0) {
        gl.uniform4fv(this.uNavalThreats, this.navalData);
      }
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  public dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteBuffer(this.quadVbo);
    gl.deleteTexture(this.densityTex);
  }
}
