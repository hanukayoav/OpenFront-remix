import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalSession } from "../../src/client/Auth";
import { ClientEnv } from "../../src/client/ClientEnv";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import { Transport } from "../../src/client/Transport";
import { EventBus } from "../../src/core/EventBus";
import { GameMode, GameType } from "../../src/core/game/Game";

function setProdBootstrap() {
  (
    window as unknown as { BOOTSTRAP_CONFIG?: Record<string, unknown> }
  ).BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 2,
    turnstileSiteKey: "1x00000000000000000000AA",
    jwtAudience: "openfront-2.duckdns.org",
    instanceId: "web-prod",
    gitCommit: "test",
  };
  ClientEnv.reset();
}

function makeLobbyConfig(gameType: GameType): LobbyConfig {
  return {
    gameID: "sp-resilience-01",
    playerName: "SingleplayerPilot",
    playerClanTag: null,
    playerRole: null,
    turnstileToken: null,
    gameStartInfo: {
      gameID: "sp-resilience-01",
      lobbyCreatedAt: Date.now(),
      players: [],
      config: {
        gameType,
        gameMode: GameMode.FFA,
      } as unknown as NonNullable<LobbyConfig["gameStartInfo"]>["config"],
    },
  } as unknown as LobbyConfig;
}

describe("Transport singleplayer outage immunity vs multiplayer strict auth", () => {
  beforeEach(() => {
    setProdBootstrap();
    clearLocalSession();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ClientEnv.reset();
  });

  it("allows local singleplayer joinGame() and rejoinGame() in GAME_ENV=prod even when remote auth returns 503", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Auth Down", { status: 503 }));

    const bus = new EventBus();
    const transport = new Transport(
      makeLobbyConfig(GameType.Singleplayer),
      bus,
    );
    expect(transport.isLocal).toBe(true);

    const localServer = transport as unknown as {
      localServer: {
        onMessage: (msg: Record<string, unknown>) => void;
      };
    };
    const messages: Record<string, unknown>[] = [];
    localServer.localServer = {
      onMessage: (msg) => {
        messages.push(msg);
      },
    };

    await transport.joinGame();
    await transport.rejoinGame(12);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "join",
      gameID: "sp-resilience-01",
    });
    expect(typeof messages[0].token).toBe("string");
    expect((messages[0].token as string).length).toBeGreaterThan(10);
    expect(messages[1]).toMatchObject({
      type: "rejoin",
      lastTurn: 12,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps multiplayer joinGame() failing closed in GAME_ENV=prod when remote auth is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Auth Down", { status: 503 }),
    );
    window.turnstile = {
      render: () => "w1",
      execute: (_id, opts) => opts.callback("valid-turnstile"),
      remove: () => {},
    };

    const bus = new EventBus();
    const transport = new Transport(makeLobbyConfig(GameType.Private), bus);
    expect(transport.isLocal).toBe(false);

    await expect(transport.joinGame()).rejects.toThrow(
      /Authentication required/,
    );
  });
});
