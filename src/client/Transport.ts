import { ClientEnv } from "src/client/ClientEnv";
import { z } from "zod";
import { EventBus, GameEvent } from "../core/EventBus";
import {
  AllPlayers,
  GameType,
  Gold,
  PlayerID,
  Tick,
  UnitType,
} from "../core/game/Game";
import { TileRef } from "../core/game/GameMap";
import {
  AllPlayersStats,
  ClientHashMessage,
  ClientIntentMessage,
  ClientJoinMessage,
  ClientMessage,
  ClientPingMessage,
  ClientRejoinMessage,
  ClientSendLiveStatsMessage,
  ClientSendWinnerMessage,
  GameConfig,
  Intent,
  LiveStats,
  ServerMessage,
  ServerMessageSchema,
  Winner,
} from "../core/Schemas";
import { replacer } from "../core/Util";
import { forceRefreshSession, getPlayToken } from "./Auth";
import { LobbyConfig } from "./ClientGameRunner";
import { showInGameAlert } from "./InGameModal";
import { LocalServer } from "./LocalServer";
import { translateText } from "./Utils";
import { PlayerView } from "./view";

export class PauseGameIntentEvent implements GameEvent {
  constructor(public readonly paused: boolean) {}
}

export class SendAllianceRequestIntentEvent implements GameEvent {
  constructor(
    public readonly requestor: PlayerView,
    public readonly recipient: PlayerView,
  ) {}
}

export class SendBreakAllianceIntentEvent implements GameEvent {
  constructor(
    public readonly requestor: PlayerView,
    public readonly recipient: PlayerView,
  ) {}
}

export class SendUpgradeStructureIntentEvent implements GameEvent {
  constructor(
    public readonly unitId: number,
    public readonly unitType: UnitType,
    public readonly amount: number = 1,
  ) {}
}

export class SendAllianceRejectIntentEvent implements GameEvent {
  constructor(public readonly requestor: PlayerView) {}
}

export class SendAllianceExtensionIntentEvent implements GameEvent {
  constructor(public readonly recipient: PlayerView) {}
}

export class SendSpawnIntentEvent implements GameEvent {
  constructor(public readonly tile: TileRef) {}
}

export class SendAttackIntentEvent implements GameEvent {
  constructor(
    public readonly targetID: PlayerID | null,
    public readonly troops: number,
    public readonly targetTile: TileRef | null = null,
  ) {}
}

export class SendBoatAttackIntentEvent implements GameEvent {
  constructor(
    public readonly dst: TileRef,
    public readonly troops: number,
  ) {}
}

export class BuildUnitIntentEvent implements GameEvent {
  constructor(
    public readonly unit: UnitType,
    public readonly tile: TileRef,
    public readonly rocketDirectionUp?: boolean,
    public readonly amount?: number,
  ) {}
}

export class SendTargetPlayerIntentEvent implements GameEvent {
  constructor(public readonly targetID: PlayerID) {}
}

export class SendEmojiIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView | typeof AllPlayers,
    public readonly emoji: number,
  ) {}
}

export class SendDonateGoldIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly gold: Gold | null,
  ) {}
}

export class SendDonateTroopsIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly troops: number | null,
  ) {}
}

export class SendQuickChatEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly quickChatKey: string,
    public readonly target?: PlayerID,
  ) {}
}

export class SendEmbargoIntentEvent implements GameEvent {
  constructor(
    public readonly target: PlayerView,
    public readonly action: "start" | "stop",
  ) {}
}

export class SendEmbargoAllIntentEvent implements GameEvent {
  constructor(public readonly action: "start" | "stop") {}
}

export class SendDeleteUnitIntentEvent implements GameEvent {
  constructor(public readonly unitId: number) {}
}

export class SendTankStrikeIntentEvent implements GameEvent {
  constructor(
    public readonly targetTile: TileRef,
    public readonly targetUnitId?: string,
  ) {}
}

export class SendSetTankRallyPointIntentEvent implements GameEvent {
  constructor(
    public readonly rallyTile?: TileRef,
    public readonly factoryUnitId?: number,
  ) {}
}

export class SendClaimSupplyDropIntentEvent implements GameEvent {
  constructor(
    public readonly dropId: number,
    public readonly tile?: TileRef,
  ) {}
}

export class CancelAttackIntentEvent implements GameEvent {
  constructor(public readonly attackID: string) {}
}

export class CancelBoatIntentEvent implements GameEvent {
  constructor(public readonly unitID: number) {}
}

export class SendWinnerEvent implements GameEvent {
  constructor(
    public readonly winner: Winner,
    public readonly allPlayersStats: AllPlayersStats,
  ) {}
}
export class SendLiveStatsEvent implements GameEvent {
  constructor(public readonly stats: LiveStats) {}
}
export class SendHashEvent implements GameEvent {
  constructor(
    public readonly tick: Tick,
    public readonly hash: number,
  ) {}
}

// Emitted when the server tells us the host started a successor lobby, carrying
// the new game id to move the group to.
export class NewLobbyEvent implements GameEvent {
  constructor(public readonly gameID: string) {}
}

export class MoveWarshipIntentEvent implements GameEvent {
  constructor(
    public readonly unitIds: number[],
    public readonly tile: number,
  ) {}
}

export class SendKickPlayerIntentEvent implements GameEvent {
  constructor(public readonly target: string) {}
}

export class SendUpdateGameConfigIntentEvent implements GameEvent {
  constructor(public readonly config: Partial<GameConfig>) {}
}

export class SendToggleGameStartTimer implements GameEvent {
  constructor() {}
}

interface BufferedMessage {
  type: ClientMessage["type"];
  json: string;
  enqueuedAt: number;
}

const EPHEMERAL_INTENT_TYPES = new Set<Intent["type"]>([
  "emoji",
  "quick_chat",
  "targetPlayer",
]);

export class Transport {
  private socket: WebSocket | null = null;

  private localServer: LocalServer;

  private buffer: BufferedMessage[] = [];

  private onconnect: () => void;
  private onmessage: (msg: ServerMessage) => void;

  private pingInterval: number | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isStopped = false;
  private isSessionSynced = false;
  private hasRetriedAuthRefresh = false;
  private connectionGeneration = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_DELAY_MS = 500;
  private static readonly MAX_RECONNECT_DELAY_MS = 15000;
  private static readonly MAX_BUFFERED_MESSAGES = 64;
  private static readonly MAX_BUFFERED_INTENT_AGE_MS = 5000;
  public readonly isLocal: boolean;

  constructor(
    private lobbyConfig: LobbyConfig,
    private eventBus: EventBus,
  ) {
    // If gameRecord is not null, we are replaying an archived game.
    // For multiplayer games, GameConfig is not known until game starts.
    this.isLocal =
      lobbyConfig.gameRecord !== undefined ||
      lobbyConfig.gameStartInfo?.config.gameType === GameType.Singleplayer;

    this.eventBus.on(SendAllianceRequestIntentEvent, (e) =>
      this.onSendAllianceRequest(e),
    );
    this.eventBus.on(SendAllianceRejectIntentEvent, (e) =>
      this.onAllianceRejectUIEvent(e),
    );
    this.eventBus.on(SendAllianceExtensionIntentEvent, (e) =>
      this.onSendAllianceExtensionIntent(e),
    );
    this.eventBus.on(SendBreakAllianceIntentEvent, (e) =>
      this.onBreakAllianceRequestUIEvent(e),
    );
    this.eventBus.on(SendSpawnIntentEvent, (e) =>
      this.onSendSpawnIntentEvent(e),
    );
    this.eventBus.on(SendAttackIntentEvent, (e) => this.onSendAttackIntent(e));
    this.eventBus.on(SendUpgradeStructureIntentEvent, (e) =>
      this.onSendUpgradeStructureIntent(e),
    );
    this.eventBus.on(SendBoatAttackIntentEvent, (e) =>
      this.onSendBoatAttackIntent(e),
    );
    this.eventBus.on(SendTargetPlayerIntentEvent, (e) =>
      this.onSendTargetPlayerIntent(e),
    );
    this.eventBus.on(SendEmojiIntentEvent, (e) => this.onSendEmojiIntent(e));
    this.eventBus.on(SendDonateGoldIntentEvent, (e) =>
      this.onSendDonateGoldIntent(e),
    );
    this.eventBus.on(SendDonateTroopsIntentEvent, (e) =>
      this.onSendDonateTroopIntent(e),
    );
    this.eventBus.on(SendQuickChatEvent, (e) => this.onSendQuickChatIntent(e));
    this.eventBus.on(SendEmbargoIntentEvent, (e) =>
      this.onSendEmbargoIntent(e),
    );
    this.eventBus.on(SendEmbargoAllIntentEvent, (e) =>
      this.onSendEmbargoAllIntent(e),
    );
    this.eventBus.on(BuildUnitIntentEvent, (e) => this.onBuildUnitIntent(e));

    this.eventBus.on(PauseGameIntentEvent, (e) => this.onPauseGameIntent(e));
    this.eventBus.on(SendWinnerEvent, (e) => this.onSendWinnerEvent(e));
    this.eventBus.on(SendLiveStatsEvent, (e) => this.onSendLiveStatsEvent(e));
    this.eventBus.on(SendHashEvent, (e) => this.onSendHashEvent(e));
    this.eventBus.on(CancelAttackIntentEvent, (e) =>
      this.onCancelAttackIntentEvent(e),
    );
    this.eventBus.on(CancelBoatIntentEvent, (e) =>
      this.onCancelBoatIntentEvent(e),
    );

    this.eventBus.on(MoveWarshipIntentEvent, (e) => {
      this.onMoveWarshipEvent(e);
    });

    this.eventBus.on(SendDeleteUnitIntentEvent, (e) =>
      this.onSendDeleteUnitIntent(e),
    );

    this.eventBus.on(SendTankStrikeIntentEvent, (e) =>
      this.onSendTankStrikeIntent(e),
    );

    this.eventBus.on(SendSetTankRallyPointIntentEvent, (e) =>
      this.onSendSetTankRallyPointIntent(e),
    );

    this.eventBus.on(SendClaimSupplyDropIntentEvent, (e) =>
      this.onSendClaimSupplyDropIntent(e),
    );

    this.eventBus.on(SendKickPlayerIntentEvent, (e) =>
      this.onSendKickPlayerIntent(e),
    );

    this.eventBus.on(SendUpdateGameConfigIntentEvent, (e) =>
      this.onSendUpdateGameConfigIntent(e),
    );

    this.eventBus.on(SendToggleGameStartTimer, (e) =>
      this.onSendToggleGameStartTimer(e),
    );
  }

  private startPing() {
    if (this.isLocal) return;
    this.pingInterval ??= window.setInterval(() => {
      if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
        this.sendMsg({
          type: "ping",
        } satisfies ClientPingMessage);
      }
    }, 5 * 1000);
  }

  private stopPing() {
    if (this.pingInterval) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  public connect(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    this.isStopped = false;
    this.reconnectAttempts = 0;
    this.hasRetriedAuthRefresh = false;
    this.clearReconnectTimeout();
    if (this.isLocal) {
      this.connectLocal(onconnect, onmessage);
    } else {
      this.connectRemote(onconnect, onmessage);
    }
  }

  public updateCallback(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    if (this.isLocal) {
      this.localServer.updateCallback(onconnect, onmessage);
    } else {
      this.onconnect = onconnect;
      this.onmessage = onmessage;
    }
  }

  private connectLocal(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    this.localServer = new LocalServer(
      this.lobbyConfig,
      this.lobbyConfig.gameRecord !== undefined,
      this.eventBus,
    );
    this.localServer.updateCallback(onconnect, onmessage);
    this.localServer.start();
  }

  private connectRemote(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    this.clearReconnectTimeout();
    this.startPing();
    this.killExistingSocket();
    this.isSessionSynced = false;
    const generation = ++this.connectionGeneration;
    // WS origin comes from ClientEnv (same-origin on web, audience-derived on
    // the desktop app://openfront origin), not window.location.host.
    const workerPath = ClientEnv.workerPath(this.lobbyConfig.gameID);
    const socket = new WebSocket(`${ClientEnv.serverWsBase()}/${workerPath}`);
    this.socket = socket;
    this.onconnect = onconnect;
    this.onmessage = onmessage;
    socket.onopen = () => {
      console.log("Connected to game server!");
      if (
        this.isStopped ||
        this.socket !== socket ||
        generation !== this.connectionGeneration
      ) {
        return;
      }
      this.reconnectAttempts = 0;
      // Authenticate and join/rejoin BEFORE flushing any queued messages so
      // queued actions wait for server verification and state catchup.
      onconnect();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (
        this.isStopped ||
        this.socket !== socket ||
        generation !== this.connectionGeneration
      ) {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        const result = ServerMessageSchema.safeParse(parsed);
        if (!result.success) {
          const error = z.prettifyError(result.error);
          console.error("Error parsing server message", error);
          return;
        }
        this.onmessage(result.data);
        if (
          !this.isStopped &&
          this.socket === socket &&
          generation === this.connectionGeneration &&
          (result.data.type === "lobby_info" || result.data.type === "start")
        ) {
          this.isSessionSynced = true;
          this.flushBuffer();
        }
      } catch (e) {
        console.error("Error in onmessage handler:", e, event.data);
        return;
      }
    };
    socket.onerror = (err) => {
      console.error("Socket encountered error: ", err, "Closing socket");
      if (this.socket !== socket || generation !== this.connectionGeneration) {
        return;
      }
      socket.close();
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket || generation !== this.connectionGeneration) {
        return;
      }
      this.isSessionSynced = false;
      console.log(
        `WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`,
      );
      if (event.code === 1002) {
        if (
          event.reason?.startsWith("Unauthorized") &&
          !this.hasRetriedAuthRefresh &&
          !this.isStopped
        ) {
          this.hasRetriedAuthRefresh = true;
          console.warn(
            "WebSocket closed due to token auth error; forcing session refresh and retrying",
          );
          void forceRefreshSession().then((refreshed) => {
            if (this.isStopped || generation !== this.connectionGeneration) {
              return;
            }
            if (refreshed !== false) {
              this.scheduleReconnect();
            } else {
              this.isStopped = true;
              this.buffer = [];
              this.stopPing();
              this.clearReconnectTimeout();
              showInGameAlert(
                translateText("error_modal.connection_refused", {
                  reason: event.reason,
                }),
              );
            }
          });
          return;
        }
        this.isStopped = true;
        this.buffer = [];
        this.stopPing();
        this.clearReconnectTimeout();
        showInGameAlert(
          translateText("error_modal.connection_refused", {
            reason: event.reason,
          }),
        );
      } else if (event.code !== 1000 && !this.isStopped) {
        console.log(`received error code ${event.code}, scheduling reconnect`);
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect() {
    if (
      this.isStopped ||
      this.reconnectTimeout !== null ||
      !this.onconnect ||
      !this.onmessage
    ) {
      return;
    }
    if (this.reconnectAttempts >= Transport.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `Max reconnect attempts (${Transport.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      this.isStopped = true;
      this.buffer = [];
      this.stopPing();
      showInGameAlert(
        translateText("error_modal.connection_refused", {
          reason: "Connection lost",
        }),
      );
      return;
    }
    const delayMs = Math.min(
      Transport.MAX_RECONNECT_DELAY_MS,
      Transport.BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts++;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.isStopped) return;
      this.reconnect();
    }, delayMs);
  }

  public reconnect() {
    this.clearReconnectTimeout();
    if (this.isStopped) return;
    if (this.isLocal) {
      this.connectLocal(this.onconnect, this.onmessage);
    } else {
      this.connectRemote(this.onconnect, this.onmessage);
    }
  }

  public turnComplete() {
    if (this.isLocal) {
      this.localServer.turnComplete();
    }
  }

  async joinGame() {
    const token = await getPlayToken();
    if (this.isStopped) return;
    this.sendMsg({
      type: "join",
      gameID: this.lobbyConfig.gameID,
      // Note: clientID is not sent - server assigns it based on persistentID
      username: this.lobbyConfig.playerName,
      clanTag: this.lobbyConfig.playerClanTag ?? null,
      cosmetics: this.lobbyConfig.cosmetics,
      turnstileToken: this.lobbyConfig.turnstileToken,
      token,
    } satisfies ClientJoinMessage);
  }

  async rejoinGame(lastTurn: number) {
    if (!this.isLocal) {
      this.isSessionSynced = false;
    }
    const token = await getPlayToken();
    if (this.isStopped) return;
    this.sendMsg({
      type: "rejoin",
      gameID: this.lobbyConfig.gameID,
      // Note: clientID is not sent - server looks it up from persistentID in token
      lastTurn: lastTurn,
      token,
    } satisfies ClientRejoinMessage);
  }

  leaveGame() {
    this.isStopped = true;
    this.isSessionSynced = false;
    this.connectionGeneration++;
    this.clearReconnectTimeout();
    this.buffer = [];
    if (this.isLocal) {
      this.localServer.endGame();
      return;
    }
    this.stopPing();
    if (this.socket === null) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      console.log("on stop: leaving game");
      this.killExistingSocket();
    } else {
      console.log(
        "WebSocket is not open. Current state:",
        this.socket.readyState,
      );
      this.killExistingSocket();
    }
  }

  private onSendAllianceRequest(event: SendAllianceRequestIntentEvent) {
    this.sendIntent({
      type: "allianceRequest",
      recipient: event.recipient.id(),
    });
  }

  private onAllianceRejectUIEvent(event: SendAllianceRejectIntentEvent) {
    this.sendIntent({
      type: "allianceReject",
      requestor: event.requestor.id(),
    });
  }

  private onBreakAllianceRequestUIEvent(event: SendBreakAllianceIntentEvent) {
    this.sendIntent({
      type: "breakAlliance",
      recipient: event.recipient.id(),
    });
  }

  private onSendAllianceExtensionIntent(
    event: SendAllianceExtensionIntentEvent,
  ) {
    this.sendIntent({
      type: "allianceExtension",
      recipient: event.recipient.id(),
    });
  }

  private onSendSpawnIntentEvent(event: SendSpawnIntentEvent) {
    this.sendIntent({
      type: "spawn",
      tile: event.tile,
    });
  }

  private onSendAttackIntent(event: SendAttackIntentEvent) {
    this.sendIntent({
      type: "attack",
      targetID: event.targetID,
      troops: event.troops,
      targetTile: event.targetTile ?? undefined,
    });
  }

  private onSendBoatAttackIntent(event: SendBoatAttackIntentEvent) {
    this.sendIntent({
      type: "boat",
      troops: event.troops,
      dst: event.dst,
    });
  }

  private onSendUpgradeStructureIntent(event: SendUpgradeStructureIntentEvent) {
    this.sendIntent({
      type: "upgrade_structure",
      unit: event.unitType,
      unitId: event.unitId,
      amount: event.amount,
    });
  }

  private onSendTargetPlayerIntent(event: SendTargetPlayerIntentEvent) {
    this.sendIntent({
      type: "targetPlayer",
      target: event.targetID,
    });
  }

  private onSendEmojiIntent(event: SendEmojiIntentEvent) {
    this.sendIntent({
      type: "emoji",
      recipient:
        event.recipient === AllPlayers ? AllPlayers : event.recipient.id(),
      emoji: event.emoji,
    });
  }

  private onSendDonateGoldIntent(event: SendDonateGoldIntentEvent) {
    this.sendIntent({
      type: "donate_gold",
      recipient: event.recipient.id(),
      gold: event.gold ? Number(event.gold) : null,
    });
  }

  private onSendDonateTroopIntent(event: SendDonateTroopsIntentEvent) {
    this.sendIntent({
      type: "donate_troops",
      recipient: event.recipient.id(),
      troops: event.troops,
    });
  }

  private onSendQuickChatIntent(event: SendQuickChatEvent) {
    this.sendIntent({
      type: "quick_chat",
      recipient: event.recipient.id(),
      quickChatKey: event.quickChatKey,
      target: event.target,
    });
  }

  private onSendEmbargoIntent(event: SendEmbargoIntentEvent) {
    this.sendIntent({
      type: "embargo",
      targetID: event.target.id(),
      action: event.action,
    });
  }

  private onSendEmbargoAllIntent(event: SendEmbargoAllIntentEvent) {
    this.sendIntent({
      type: "embargo_all",
      action: event.action,
    });
  }

  private onBuildUnitIntent(event: BuildUnitIntentEvent) {
    this.sendIntent({
      type: "build_unit",
      unit: event.unit,
      tile: event.tile,
      rocketDirectionUp: event.rocketDirectionUp,
      amount: event.amount,
    });
  }

  private onPauseGameIntent(event: PauseGameIntentEvent) {
    this.sendIntent({
      type: "toggle_pause",
      paused: event.paused,
    });
  }

  private onSendWinnerEvent(event: SendWinnerEvent) {
    this.sendMsg({
      type: "winner",
      winner: event.winner,
      allPlayersStats: event.allPlayersStats,
    } satisfies ClientSendWinnerMessage);
  }

  private onSendLiveStatsEvent(event: SendLiveStatsEvent) {
    if (
      this.isLocal ||
      (this.socket?.readyState === WebSocket.OPEN && this.isSessionSynced)
    ) {
      this.sendMsg({
        type: "live_stats",
        stats: event.stats,
      } satisfies ClientSendLiveStatsMessage);
    }
  }

  private onSendHashEvent(event: SendHashEvent) {
    this.sendMsg({
      type: "hash",
      turnNumber: event.tick,
      hash: event.hash,
    } satisfies ClientHashMessage);
  }

  private onCancelAttackIntentEvent(event: CancelAttackIntentEvent) {
    this.sendIntent({
      type: "cancel_attack",
      attackID: event.attackID,
    });
  }

  private onCancelBoatIntentEvent(event: CancelBoatIntentEvent) {
    this.sendIntent({
      type: "cancel_boat",
      unitID: event.unitID,
    });
  }

  private onMoveWarshipEvent(event: MoveWarshipIntentEvent) {
    this.sendIntent({
      type: "move_warship",
      unitIds: event.unitIds,
      tile: event.tile,
    });
  }

  private onSendDeleteUnitIntent(event: SendDeleteUnitIntentEvent) {
    this.sendIntent({
      type: "delete_unit",
      unitId: event.unitId,
    });
  }

  private onSendTankStrikeIntent(event: SendTankStrikeIntentEvent) {
    this.sendIntent({
      type: "tank_strike",
      targetTile: event.targetTile,
      targetUnitId: event.targetUnitId,
    });
  }

  private onSendSetTankRallyPointIntent(
    event: SendSetTankRallyPointIntentEvent,
  ) {
    this.sendIntent({
      type: "set_tank_rally_point",
      rallyTile: event.rallyTile,
      factoryUnitId: event.factoryUnitId,
    });
  }

  private onSendClaimSupplyDropIntent(event: SendClaimSupplyDropIntentEvent) {
    this.sendIntent({
      type: "claim_supply_drop",
      dropId: event.dropId,
      tile: event.tile,
    });
  }

  private onSendKickPlayerIntent(event: SendKickPlayerIntentEvent) {
    this.sendIntent({
      type: "kick_player",
      targetClientID: event.target,
    });
  }

  private onSendUpdateGameConfigIntent(event: SendUpdateGameConfigIntentEvent) {
    this.sendIntent({
      type: "update_game_config",
      config: event.config,
    });
  }

  private onSendToggleGameStartTimer(event: SendToggleGameStartTimer) {
    this.sendIntent({ type: "toggle_game_start_timer" });
  }

  private sendIntent(intent: Intent) {
    const canSendImmediately =
      this.isLocal ||
      (this.socket?.readyState === WebSocket.OPEN && this.isSessionSynced);
    if (!canSendImmediately && EPHEMERAL_INTENT_TYPES.has(intent.type)) {
      return;
    }
    this.sendMsg({
      type: "intent",
      intent,
    } satisfies ClientIntentMessage);
  }

  private enqueueBufferedMessage(msg: ClientMessage, json: string) {
    // Discard stale entries before enforcing queue capacity so fresh actions survive.
    const now = Date.now();
    this.buffer = this.buffer.filter(
      (entry) => now - entry.enqueuedAt <= Transport.MAX_BUFFERED_INTENT_AGE_MS,
    );
    if (this.buffer.length >= Transport.MAX_BUFFERED_MESSAGES) {
      this.buffer.shift();
    }
    this.buffer.push({
      type: msg.type,
      json,
      enqueuedAt: now,
    });
  }

  private flushBuffer() {
    if (
      this.isStopped ||
      this.socket === null ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.isSessionSynced
    ) {
      return;
    }
    const now = Date.now();
    while (this.buffer.length > 0) {
      if (
        this.socket === null ||
        this.socket.readyState !== WebSocket.OPEN ||
        this.isStopped ||
        !this.isSessionSynced
      ) {
        break;
      }
      const entry = this.buffer.shift();
      if (entry === undefined) {
        continue;
      }
      if (now - entry.enqueuedAt > Transport.MAX_BUFFERED_INTENT_AGE_MS) {
        console.log(`Dropping stale queued ${entry.type} message`);
        continue;
      }
      console.log("sending dropped message");
      this.socket.send(entry.json);
    }
  }

  private sendMsg(msg: ClientMessage) {
    if (this.isLocal) {
      // Forward message to local server
      this.localServer.onMessage(msg);
      return;
    }
    if (this.isStopped) {
      return;
    }
    const str = JSON.stringify(msg, replacer);
    const isHandshake = msg.type === "join" || msg.type === "rejoin";
    if (isHandshake) {
      if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(str);
      } else if (
        this.socket === null ||
        this.socket.readyState === WebSocket.CLOSING ||
        this.socket.readyState === WebSocket.CLOSED
      ) {
        // Fresh handshake will run via onconnect() once reconnect opens.
        this.scheduleReconnect();
      }
      return;
    }
    // Live heartbeats and ephemeral telemetry must never be replayed offline.
    if (msg.type === "ping") {
      if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(str);
      }
      return;
    }
    if (msg.type === "live_stats") {
      if (
        this.socket !== null &&
        this.socket.readyState === WebSocket.OPEN &&
        this.isSessionSynced
      ) {
        this.socket.send(str);
      }
      return;
    }
    if (
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN &&
      this.isSessionSynced
    ) {
      this.socket.send(str);
      return;
    }
    // Never send gameplay/state messages before socket is OPEN + joined/synced.
    this.enqueueBufferedMessage(msg, str);
    if (
      this.socket === null ||
      this.socket.readyState === WebSocket.CLOSING ||
      this.socket.readyState === WebSocket.CLOSED
    ) {
      console.warn(
        "WebSocket is not open, queuing action and scheduling reconnect:",
        this.socket?.readyState,
      );
      this.scheduleReconnect();
    }
  }

  private killExistingSocket(): void {
    if (this.socket === null) {
      return;
    }
    // Remove all event listeners
    this.socket.onmessage = null;
    this.socket.onopen = null;
    this.socket.onclose = null;
    this.socket.onerror = null;

    // Close the connection if it's still open or still connecting
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    } catch (e) {
      console.warn("Error while closing WebSocket:", e);
    }

    this.socket = null;
  }
}
