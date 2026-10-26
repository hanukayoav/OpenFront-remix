import type { Config } from "../../../../../core/configuration/Config";
import type {
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  RendererConfig,
} from "../../../types";
import {
  UT_HYDROGEN_BOMB,
  UT_SHELL,
  UT_WARSHIP,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";
import { FxAttackRingPass } from "./FxAttackRingPass";
import { FxParticlePass } from "./FxParticlePass";
import { FxShockwavePass } from "./FxShockwavePass";
import { FxSpritePass, NUKE_EXPLOSION_RADII } from "./FxSpritePass";
import { FxWaterRipplePass } from "./FxWaterRipplePass";

export type { AttackRingInput } from "../../../types";

export class FxPass {
  private spritePass: FxSpritePass;
  private shockwavePass: FxShockwavePass;
  private attackRingPass: FxAttackRingPass;
  private particlePass: FxParticlePass;
  private waterRipplePass: FxWaterRipplePass;
  private mapW: number;
  private timeFn: () => number = () => performance.now();
  private terrainBytes: Uint8Array | null = null;

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.mapW = header.mapWidth;
    this.spritePass = new FxSpritePass(gl, header, settings, config);
    this.shockwavePass = new FxShockwavePass(gl, settings);
    this.attackRingPass = new FxAttackRingPass(gl, settings);
    this.particlePass = new FxParticlePass(gl, settings);
    this.waterRipplePass = new FxWaterRipplePass(gl, settings);
  }

  public setTerrainBytes(bytes: Uint8Array): void {
    this.terrainBytes = bytes;
  }

  // -------------------------------------------------------------------------
  // Spawning — coordinated across sub-passes
  // -------------------------------------------------------------------------

  applyDeadUnits(deadUnits: DeadUnitFx[]): void {
    const now = this.timeFn();
    for (const unit of deadUnits) {
      const startMs = now - (unit.tickAge ?? 0) * this.config.msPerTick();
      this.spawnUnit(unit, startMs);
    }
  }

  private isWaterTile(pos: number): boolean {
    if (!this.terrainBytes || pos < 0 || pos >= this.terrainBytes.length) return false;
    const b = this.terrainBytes[pos];
    return (b & 128) !== 0 || b === 0; // ocean bit or water
  }

  private spawnUnit(unit: DeadUnitFx, now: number): void {
    const typeName = unit.unitType;
    const x = unit.pos % this.mapW;
    const y = (unit.pos - x) / this.mapW;
    const onWater = this.isWaterTile(unit.pos) || typeName === UT_WARSHIP;

    const nukeRadius = NUKE_EXPLOSION_RADII[typeName];
    if (nukeRadius !== undefined) {
      if (unit.reachedTarget) {
        this.spritePass.spawnFxForUnit(unit, now);
        this.shockwavePass.pushNukeShockwave(x, y, nukeRadius, unit.explosion);
        
        // Cinematic Nuke Particle Plumes & Embers
        const isHydrogen = typeName === UT_HYDROGEN_BOMB;
        this.particlePass.spawnNukePlume(x, y, nukeRadius, false, isHydrogen);

        // Water Splash Plume & Sea Ripples if detonation on water
        if (onWater) {
          this.particlePass.spawnWaterSpout(x, y, nukeRadius);
          this.waterRipplePass.pushRipple(x, y, nukeRadius * 1.8, 1800);
        }
      } else {
        // SAM interception: sprite pass handles the SAM explosion sprite
        this.spritePass.spawnFxForUnit(unit, now);
        this.shockwavePass.pushSAMShockwave(x, y);
        this.particlePass.spawnNukePlume(x, y, 6.0, true, false); // electric interception burst
      }
      return;
    }

    if (onWater && (typeName === UT_WARSHIP || typeName === UT_SHELL)) {
      this.waterRipplePass.pushRipple(x, y, 14.0, 1400);
      if (typeName === UT_WARSHIP) {
        this.particlePass.spawnWaterSpout(x, y, 8.0);
      }
    }

    // All other units: sprite-only effects
    this.spritePass.spawnFxForUnit(unit, now);
  }

  applyRailroadDust(tileRefs: number[]): void {
    this.spritePass.applyRailroadDust(tileRefs);
  }

  applyConquestEvents(events: ConquestFx[]): void {
    this.spritePass.applyConquestEvents(events);
  }

  updateAttackRings(rings: AttackRingInput[]): void {
    this.attackRingPass.update(rings);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  tick(): void {
    this.spritePass.tick();
    this.shockwavePass.tick();
    this.attackRingPass.tick();
    this.particlePass.tick();
    this.waterRipplePass.tick();
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    this.waterRipplePass.draw(cameraMatrix);
    this.spritePass.draw(cameraMatrix);
    this.shockwavePass.draw(cameraMatrix);
    this.particlePass.draw(cameraMatrix);
    this.attackRingPass.draw(cameraMatrix, zoom);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
    this.spritePass.setTimeFn(fn);
    this.shockwavePass.setTimeFn(fn);
  }

  clear(): void {
    this.spritePass.clear();
    this.shockwavePass.clear();
    this.attackRingPass.clear();
    this.particlePass.clear();
    this.waterRipplePass.clear();
  }

  dispose(): void {
    this.spritePass.dispose();
    this.shockwavePass.dispose();
    this.attackRingPass.dispose();
    this.particlePass.dispose();
    this.waterRipplePass.dispose();
  }
}

