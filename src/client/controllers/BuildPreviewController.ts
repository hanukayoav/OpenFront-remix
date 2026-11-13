/**
 * BuildPreviewController — build-ghost state machine + click-to-build flow.
 *
 * All rendering for the build ghost (outline, range circle, rail snap,
 * crosshair) lives in the WebGL renderer. This controller owns the state:
 * it queries buildables for the cursor tile, tracks whether the placement
 * is valid, and pushes preview data straight to the WebGL view.
 */

import { EventBus } from "../../core/EventBus";
import {
  listNukeBreakAlliance,
  wouldNukeBreakAlliance,
} from "../../core/execution/Util";
import {
  BuildableUnit,
  bulkCost,
  PlayerBuildableUnitType,
  UnitType,
} from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { UserSettings } from "../../core/game/UserSettings";
import { Controller } from "../Controller";
import {
  ConfirmGhostStructureEvent,
  MouseMoveEvent,
  MouseUpEvent,
} from "../InputHandler";
import { buildNukeTrajectory, MapRenderer } from "../render/gl";
import type { SAMInfo } from "../render/gl/utils/NukeTrajectory";
import type { GhostPreviewData } from "../render/types";
import { TransformHandler } from "../TransformHandler";
import {
  BuildUnitIntentEvent,
  SendUpgradeStructureIntentEvent,
} from "../Transport";
import { UIState } from "../UIState";
import { GameView } from "../view";

/** True for nuke types (AtomBomb, HydrogenBomb): ghost is preserved after placement so user can place multiple or keep selection (Enter/key confirm). */
export function shouldPreserveGhostAfterBuild(unitType: UnitType): boolean {
  return unitType === UnitType.AtomBomb || unitType === UnitType.HydrogenBomb;
}

function requiresMissileSilo(unitType: UnitType | null | undefined): boolean {
  return (
    unitType === UnitType.AtomBomb ||
    unitType === UnitType.HydrogenBomb ||
    unitType === UnitType.MIRV
  );
}

// tSamIntercept value used to flag an untargetable (impassable) destination:
// draws the red X marker essentially at the destination while leaving the
// visible line unchanged (1.0 would mean "no marker").
const T_BLOCKED_DST = 0.9999;

/**
 * Whether a SAM belongs in the nuke trajectory preview's threat set.
 * Mirrors SAMLauncherExecution & canPlayerInterceptMissile:
 * 1. A SAM ignores a nuke whose owner it's friendly with (same team OR unbetrayed ally).
 * 2. In addition, only the targeted country, its allies/teammates, or allies betrayed by
 *    this strike can intercept. Third-party countries whose airspace the missile merely passes
 *    over will not intercept and therefore do not threaten the trajectory.
 */
export function samThreatensNukePreview(
  samOwnerSmallId: number,
  teammateSmallIds: ReadonlySet<number>,
  allySmallIds: ReadonlySet<number>,
  betrayedSmallIds: ReadonlySet<number>,
  targetSmallId?: number | null,
  targetFriendlySmallIds?: ReadonlySet<number>,
): boolean {
  if (teammateSmallIds.has(samOwnerSmallId)) return false;
  if (
    allySmallIds.has(samOwnerSmallId) &&
    !betrayedSmallIds.has(samOwnerSmallId)
  ) {
    return false;
  }

  // If a player is targeted, only the target player, their allies/teammates, or betrayed allies can intercept.
  if (
    targetSmallId !== undefined &&
    targetSmallId !== null &&
    targetSmallId > 0
  ) {
    return (
      samOwnerSmallId === targetSmallId ||
      (targetFriendlySmallIds?.has(samOwnerSmallId) ?? false) ||
      betrayedSmallIds.has(samOwnerSmallId)
    );
  }

  // If target is unowned (terra nullius), only betrayed allies can intercept.
  if (targetSmallId === null || targetSmallId === 0) {
    return betrayedSmallIds.has(samOwnerSmallId);
  }

  return true;
}

export class BuildPreviewController implements Controller {
  /** Current ghost (null when no build type is active). */
  private ghostUnit: { buildableUnit: BuildableUnit } | null = null;
  private readonly connectedAllySmallIds: Set<number> = new Set();
  private readonly mousePos = { x: 0, y: 0 };
  private lastGhostQueryAt: number = 0;
  private pendingConfirm: MouseUpEvent | null = null;

  // Buildable validation runs on the snapped tile under the cursor, but the
  // rendered icon follows the cursor at sub-tile precision so motion is
  // continuous instead of stepping tile-to-tile. cursorLoop re-emits each
  // frame with the current cursor world position.
  private lastGhostData: GhostPreviewData | null = null;

  // Static inputs for the nuke trajectory preview (source silo + threatening
  // SAMs). Recomputed in the throttled renderGhost path; cursorLoop rebuilds
  // the Bezier each frame with the live cursor position as the destination so
  // the arc tracks the cursor smoothly instead of snapping tile-to-tile.
  private nukeTrajectoryStatic: {
    srcX: number;
    srcY: number;
    directionUp: boolean;
    sams: SAMInfo[];
  } | null = null;
  private cursorLoopRunning = false;
  private cursorRafId: number | null = null;
  private destroyed = false;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    public uiState: UIState,
    private transformHandler: TransformHandler,
    private view: MapRenderer,
    private userSettings: UserSettings,
  ) {}

  init() {
    this.destroyed = false;
    this.cursorLoopRunning = false;
    this.eventBus.on(MouseMoveEvent, (e) => this.moveGhost(e));
    this.eventBus.on(MouseUpEvent, (e) => this.requestConfirmStructure(e));
    this.eventBus.on(ConfirmGhostStructureEvent, () =>
      this.requestConfirmStructure(
        new MouseUpEvent(this.mousePos.x, this.mousePos.y),
      ),
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.cursorLoopRunning = false;
    if (this.cursorRafId !== null) {
      cancelAnimationFrame(this.cursorRafId);
      this.cursorRafId = null;
    }
    this.lastGhostData = null;
    this.nukeTrajectoryStatic = null;
    this.ghostUnit = null;
  }

  dispose(): void {
    this.destroy();
  }

  private ensureCursorLoop(): void {
    if (this.destroyed || this.cursorLoopRunning) return;
    this.cursorLoopRunning = true;
    this.cursorRafId = requestAnimationFrame(this.cursorLoop);
  }

  private cursorLoop = (): void => {
    if (this.destroyed) {
      this.cursorLoopRunning = false;
      this.cursorRafId = null;
      return;
    }
    const ghost = this.lastGhostData;
    const traj = this.nukeTrajectoryStatic;
    if (ghost === null && traj === null) {
      this.cursorLoopRunning = false;
      this.cursorRafId = null;
      return;
    }
    const w = this.transformHandler.screenToWorldCoordinatesFloat(
      this.mousePos.x,
      this.mousePos.y,
    );
    if (ghost !== null) {
      const radiusFollowsCursor = !(
        ghost.canUpgrade && ghost.upgradeTargetTile !== null
      );
      this.view.updateGhostPreview({
        ...ghost,
        tileX: w.x - 0.5,
        tileY: w.y - 0.5,
        ...(radiusFollowsCursor
          ? { radiusTileX: w.x - 0.5, radiusTileY: w.y - 0.5 }
          : {}),
      });
    }
    if (traj !== null) {
      const data = buildNukeTrajectory(
        traj.srcX,
        traj.srcY,
        w.x - 0.5,
        w.y - 0.5,
        this.game.height(),
        traj.directionUp,
        traj.sams,
      );
      const tx = Math.floor(w.x);
      const ty = Math.floor(w.y);
      if (
        this.game.isValidCoord(tx, ty) &&
        this.game.isImpassable(this.game.ref(tx, ty))
      ) {
        data.tSamIntercept = Math.min(data.tSamIntercept, T_BLOCKED_DST);
      }
      this.view.updateNukeTrajectory(data);
    }
    if (!this.destroyed) {
      this.cursorRafId = requestAnimationFrame(this.cursorLoop);
    } else {
      this.cursorLoopRunning = false;
      this.cursorRafId = null;
    }
  };

  tick() {
    if (this.destroyed) return;
    // Re-query buildables periodically (world state can change — tiles may
    // become buildable as troops/territory move).
    if (this.syncGhostState()) return;
    this.renderGhost();
  }

  /**
   * Reconcile our internal ghost state with uiState.ghostStructure. Other
   * UI bits (build menu, key bindings) toggle uiState; we mirror it here.
   * @returns true when synchronization clears a ghost selection.
   */
  private syncGhostState(): boolean {
    const myPlayer = this.game.myPlayer();
    if (myPlayer?.isAlive() === false) {
      this.removeGhostStructure();
      return true;
    }
    const target = this.uiState.ghostStructure;
    const ghostType = target ?? this.ghostUnit?.buildableUnit.type;
    if (
      myPlayer &&
      requiresMissileSilo(ghostType) &&
      myPlayer.units(UnitType.MissileSilo).length === 0
    ) {
      this.removeGhostStructure();
      return true;
    }
    if (this.ghostUnit) {
      if (target === null) {
        this.removeGhostStructure();
        return true;
      } else if (target !== this.ghostUnit.buildableUnit.type) {
        this.clearGhostStructure();
        this.createGhostStructure(target);
      }
    } else if (target !== null) {
      this.createGhostStructure(target);
    }
    return false;
  }

  renderGhost() {
    if (!this.ghostUnit) return;

    const now = performance.now();
    if (now - this.lastGhostQueryAt < 50) return;
    this.lastGhostQueryAt = now;
    let tileRef: TileRef | undefined;
    let trajectoryTileRef: TileRef | undefined;
    const tile = this.transformHandler.screenToWorldCoordinates(
      this.mousePos.x,
      this.mousePos.y,
    );
    if (this.game.isValidCoord(tile.x, tile.y)) {
      tileRef = this.game.ref(tile.x, tile.y);
      trajectoryTileRef = tileRef;
      // Impassable terrain is a void — treat hovering over it the same as
      // hovering outside the map (no ghost, no blast circle). The nuke
      // trajectory preview is the exception: nukes fly over impassable
      // terrain, so the arc still renders (with a blocked X at the
      // untargetable destination — see cursorLoop).
      if (this.game.isImpassable(tileRef)) {
        tileRef = undefined;
      }
    }

    // Check if targeting an ally (for nuke warning visual)
    let targetingAlly = false;
    const myPlayer = this.game.myPlayer();
    const nukeType = this.ghostUnit.buildableUnit.type;
    if (
      tileRef &&
      myPlayer &&
      (nukeType === UnitType.AtomBomb || nukeType === UnitType.HydrogenBomb)
    ) {
      this.connectedAllySmallIds.clear();
      const allies = myPlayer.allies();
      for (let i = 0; i < allies.length; i++) {
        const ally = allies[i];
        if (!ally.isDisconnected()) {
          this.connectedAllySmallIds.add(ally.smallID());
        }
      }

      if (this.connectedAllySmallIds.size > 0) {
        targetingAlly = wouldNukeBreakAlliance({
          game: this.game,
          targetTile: tileRef,
          magnitude: this.game.config().nukeMagnitudes(nukeType),
          allySmallIds: this.connectedAllySmallIds,
          threshold: this.game.config().nukeAllianceBreakThreshold(),
        });
      }
    }

    this.game
      ?.myPlayer()
      ?.buildables(tileRef, [this.ghostUnit?.buildableUnit.type])
      .then((buildables) => {
        if (this.destroyed) return;
        if (!this.ghostUnit) {
          this.pendingConfirm = null;
          this.emitGhostPreview(tileRef, targetingAlly, trajectoryTileRef);
          return;
        }

        const unit = buildables.find(
          (u) => u.type === this.ghostUnit!.buildableUnit.type,
        );
        if (!unit) {
          Object.assign(this.ghostUnit.buildableUnit, {
            canBuild: false,
            canUpgrade: false,
          });
          this.pendingConfirm = null;
          this.emitGhostPreview(tileRef, targetingAlly, trajectoryTileRef);
          return;
        }

        this.ghostUnit.buildableUnit = unit;

        if (this.pendingConfirm !== null) {
          const ev = this.pendingConfirm;
          this.pendingConfirm = null;
          if (this.isGhostReadyForConfirm()) {
            this.createStructure(ev);
          }
        }

        this.emitGhostPreview(tileRef, targetingAlly, trajectoryTileRef);
      });
  }

  /**
   * Push a GhostPreviewData snapshot to the WebGL view (StructurePass /
   * RangeCirclePass / RailroadPass / CrosshairPass all read it). null when
   * the ghost can't be placed. smoothLoop interpolates displayed position
   * toward the target tile each frame.
   */
  private emitGhostPreview(
    tileRef: TileRef | undefined,
    targetingAlly: boolean,
    trajectoryTileRef: TileRef | undefined,
  ): void {
    const data = this.buildGhostPreviewData(tileRef, targetingAlly);
    if (data === null) {
      this.lastGhostData = null;
      this.view.updateGhostPreview(null);
    } else {
      this.lastGhostData = data;
      this.ensureCursorLoop();
    }
    // The trajectory target is tracked separately from the ghost tile:
    // impassable terrain voids the ghost but still gets a trajectory arc.
    this.updateNukeTrajectoryPreview(trajectoryTileRef);
  }

  /**
   * For AtomBomb / HydrogenBomb ghosts, push the Bezier trajectory preview
   * (closest player-owned silo → target, accounting for non-allied SAMs).
   * Cleared whenever the ghost isn't a nuke, has no target, or the player
   * has no silos. Unlike the ghost icon, the trajectory also renders when
   * hovering impassable terrain (cursorLoop adds the blocked X there).
   */
  private updateNukeTrajectoryPreview(tileRef: TileRef | undefined): void {
    if (!this.ghostUnit || tileRef === undefined) {
      this.clearNukeTrajectory();
      return;
    }
    const type = this.ghostUnit.buildableUnit.type;
    if (type !== UnitType.AtomBomb && type !== UnitType.HydrogenBomb) {
      this.clearNukeTrajectory();
      return;
    }
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) {
      this.clearNukeTrajectory();
      return;
    }

    // Mirror PlayerImpl.nukeSpawn (the source NukeExecution actually fires
    // from): only silos that are active, not reloading, and not under
    // construction are eligible, and the nearest (Manhattan distance) is
    // chosen. Keeping these in sync prevents the preview arc from
    // originating from a silo the game wouldn't use.
    const silos = myPlayer
      .units(UnitType.MissileSilo)
      .filter(
        (u) => u.isActive() && !u.isInCooldown() && !u.isUnderConstruction(),
      );
    if (silos.length === 0) {
      this.clearNukeTrajectory();
      return;
    }

    const dstX = this.game.x(tileRef);
    const dstY = this.game.y(tileRef);
    silos.sort(
      (a, b) =>
        Math.abs(this.game.x(a.tile()) - dstX) +
        Math.abs(this.game.y(a.tile()) - dstY) -
        (Math.abs(this.game.x(b.tile()) - dstX) +
          Math.abs(this.game.y(b.tile()) - dstY)),
    );

    const bestSilo = silos[0];
    const directionUp = this.uiState.rocketDirectionUp;
    const srcX = this.game.x(bestSilo.tile());
    const srcY = this.game.y(bestSilo.tile());

    // Non-friendly SAMs threaten the trajectory; own + teammate + allied SAMs
    // don't — except allies this strike would betray: the alliance breaks at
    // launch (NukeExecution.maybeBreakAlliances), so their SAMs will intercept.
    // Teammates have no such exception (a strike never breaks a team).
    // listNukeBreakAlliance is the same function the sim uses there.
    const teammateIds = new Set<number>();
    for (const p of this.game.players()) {
      if (myPlayer.isOnSameTeam(p)) teammateIds.add(p.smallID());
    }
    const allyIds = new Set<number>();
    for (const a of myPlayer.allies()) allyIds.add(a.smallID());
    const betrayedIds: ReadonlySet<number> =
      allyIds.size > 0
        ? listNukeBreakAlliance({
            game: this.game,
            targetTile: tileRef,
            magnitude: this.game.config().nukeMagnitudes(type),
            threshold: this.game.config().nukeAllianceBreakThreshold(),
          })
        : new Set();
    const targetOwner = this.game.owner(tileRef);
    const targetSmallId =
      targetOwner && targetOwner.isPlayer() ? targetOwner.smallID() : null;
    const targetFriendlySmallIds = new Set<number>();
    if (targetOwner && targetOwner.isPlayer()) {
      targetFriendlySmallIds.add(targetOwner.smallID());
      for (const p of this.game.players()) {
        if (p.isFriendly(targetOwner)) {
          targetFriendlySmallIds.add(p.smallID());
        }
      }
    }

    const sams: SAMInfo[] = [];
    for (const s of this.game.units(UnitType.SAMLauncher)) {
      if (!s.isActive()) continue;
      const owner = s.owner();
      if (owner === myPlayer) continue;
      if (
        !samThreatensNukePreview(
          owner.smallID(),
          teammateIds,
          allyIds,
          betrayedIds,
          targetSmallId,
          targetFriendlySmallIds,
        )
      ) {
        continue;
      }
      const r = this.game.config().samRange(s.level());
      sams.push({
        x: this.game.x(s.tile()),
        y: this.game.y(s.tile()),
        rangeSq: r * r,
      });
    }

    // Stash the static inputs; cursorLoop rebuilds the Bezier each frame with
    // the live cursor as the destination so the arc tracks smoothly.
    this.nukeTrajectoryStatic = {
      srcX,
      srcY,
      directionUp,
      sams,
    };
    this.ensureCursorLoop();
  }

  private clearNukeTrajectory(): void {
    this.nukeTrajectoryStatic = null;
    this.view.updateNukeTrajectory(null);
  }

  private buildGhostPreviewData(
    tileRef: TileRef | undefined,
    targetingAlly: boolean,
  ): GhostPreviewData | null {
    if (!this.ghostUnit) return null;
    if (tileRef === undefined) return null;
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return null;

    const u = this.ghostUnit.buildableUnit;

    // Upgrade-target tile — only when upgrading an existing unit.
    let upgradeTargetTile: number | null = null;
    if (u.canUpgrade !== false) {
      upgradeTargetTile = this.game.unit(u.canUpgrade)?.tile() ?? null;
    }

    // Range circle: SAM placement preview shows targetable radius; nuke
    // previews show the outer blast radius at the target tile.
    let rangeRadius = 0;
    switch (u.type) {
      case UnitType.SAMLauncher: {
        const level = this.resolveGhostRangeLevel(u) ?? 1;
        rangeRadius = this.game.config().samRange(level);
        break;
      }
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
        rangeRadius = this.game.config().nukeMagnitudes(u.type).outer;
        break;
      case UnitType.Factory:
        rangeRadius = this.game.config().trainStationMaxRange();
        break;
      case UnitType.DefensePost:
        rangeRadius = this.game.config().defensePostRange();
        break;
      case UnitType.TankFactory:
        rangeRadius = this.game.config().tankFiringRange();
        break;
    }
    let radiusTileX = this.game.x(tileRef);
    let radiusTileY = this.game.y(tileRef);
    if (
      rangeRadius > 0 &&
      u.canUpgrade !== false &&
      upgradeTargetTile !== null
    ) {
      radiusTileX = this.game.x(upgradeTargetTile);
      radiusTileY = this.game.y(upgradeTargetTile);
    }

    const isNuke = u.type === UnitType.AtomBomb;
    const multiplier =
      u.canUpgrade !== false || isNuke
        ? (this.uiState.upgradeMultiplier ?? 1)
        : 1;
    const cost = bulkCost(u, multiplier);
    // Drives the red cost label: gold short of the bulk total, or (for
    // bombs) fewer loaded silo tubes than the selected amount.
    let canAfford = myPlayer.gold() >= cost;
    if (isNuke) {
      canAfford &&= myPlayer.readyMissileCount() >= multiplier;
    }
    return {
      ghostType: u.type,
      tileX: this.game.x(tileRef),
      tileY: this.game.y(tileRef),
      radiusTileX,
      radiusTileY,
      canBuild: u.canBuild !== false,
      canUpgrade: u.canUpgrade !== false,
      cost: Number(cost),
      multiplier: multiplier,
      showCost: this.userSettings.cursorCostLabel(),
      canAfford,
      ghostRailPaths: u.ghostRailPaths,
      overlappingRailroads: u.overlappingRailroads,
      ownerID: myPlayer.smallID(),
      upgradeTargetTile,
      rangeRadius,
      rangeWarning: targetingAlly,
    };
  }

  private isGhostReadyForConfirm(): boolean {
    if (!this.ghostUnit) return false;
    const bu = this.ghostUnit.buildableUnit;
    return bu.canBuild !== false || bu.canUpgrade !== false;
  }

  private requestConfirmStructure(e: MouseUpEvent): void {
    if (!this.ghostUnit && !this.uiState.ghostStructure) return;
    if (this.isGhostReadyForConfirm()) {
      this.createStructure(e);
    } else {
      this.pendingConfirm = e;
    }
  }

  private createStructure(e: MouseUpEvent) {
    if (!this.ghostUnit) return;
    if (
      this.ghostUnit.buildableUnit.canBuild === false &&
      this.ghostUnit.buildableUnit.canUpgrade === false
    ) {
      this.removeGhostStructure();
      return;
    }
    const tile = this.transformHandler.screenToWorldCoordinates(e.x, e.y);
    if (this.ghostUnit.buildableUnit.canUpgrade !== false) {
      this.eventBus.emit(
        new SendUpgradeStructureIntentEvent(
          this.ghostUnit.buildableUnit.canUpgrade,
          this.ghostUnit.buildableUnit.type,
          this.uiState.upgradeMultiplier || 1,
        ),
      );
      this.removeGhostStructure();
    } else if (this.ghostUnit.buildableUnit.canBuild) {
      const unitType = this.ghostUnit.buildableUnit.type;
      const isNuke = unitType === UnitType.AtomBomb;
      const rocketDirectionUp =
        unitType === UnitType.AtomBomb || unitType === UnitType.HydrogenBomb
          ? this.uiState.rocketDirectionUp
          : undefined;
      this.eventBus.emit(
        new BuildUnitIntentEvent(
          unitType,
          this.game.ref(tile.x, tile.y),
          rocketDirectionUp,
          isNuke ? this.uiState.upgradeMultiplier || 1 : undefined,
        ),
      );
      if (!shouldPreserveGhostAfterBuild(unitType)) {
        this.removeGhostStructure();
      }
    } else {
      this.removeGhostStructure();
    }
  }

  private moveGhost(e: MouseMoveEvent) {
    this.mousePos.x = e.x;
    this.mousePos.y = e.y;
  }

  private createGhostStructure(type: PlayerBuildableUnitType | null) {
    if (type === null) return;
    if (this.game.myPlayer() === null) return;
    this.ghostUnit = {
      buildableUnit: {
        type,
        canBuild: false,
        canUpgrade: false,
        cost: 0n,
        overlappingRailroads: [],
        ghostRailPaths: [],
      },
    };
  }

  private clearGhostStructure() {
    this.pendingConfirm = null;
    this.ghostUnit = null;
    this.lastGhostData = null;
    this.view.updateGhostPreview(null);
    this.clearNukeTrajectory();
  }

  private removeGhostStructure() {
    this.clearGhostStructure();
    this.uiState.ghostStructure = null;
  }

  private resolveGhostRangeLevel(
    buildableUnit: BuildableUnit,
  ): number | undefined {
    if (buildableUnit.type !== UnitType.SAMLauncher) return undefined;
    if (buildableUnit.canUpgrade !== false) {
      const existing = this.game.unit(buildableUnit.canUpgrade);
      if (existing) {
        return existing.level() + 1;
      } else {
        console.error("Failed to find existing SAMLauncher for upgrade");
      }
    }
    return 1;
  }
}
