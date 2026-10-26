import { describe, expect, it, vi } from "vitest";
import { GameEnv } from "../../src/core/configuration/Config";
import { MapPlaylist } from "../../src/server/MapPlaylist";
import { PrivilegeRefresher } from "../../src/server/PrivilegeRefresher";
import { ServerEnv } from "../../src/server/ServerEnv";

describe("MapPlaylist", () => {
  it("generates special configs without ReferenceError", async () => {
    const playlist = new MapPlaylist();
    for (let i = 0; i < 20; i++) {
      const config = await playlist.gameConfig("special");
      expect(config).toBeDefined();
      expect(config.gameMap).toBeDefined();
    }
  });

  it("generates ffa and team configs cleanly", async () => {
    const playlist = new MapPlaylist();
    const ffa = await playlist.gameConfig("ffa");
    expect(ffa).toBeDefined();
    const team = await playlist.gameConfig("team");
    expect(team).toBeDefined();
  });
});

describe("PrivilegeRefresher in dev mode", () => {
  it("falls back gracefully when offline in dev mode without throwing", async () => {
    vi.spyOn(ServerEnv, "env").mockReturnValue(GameEnv.Dev);
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => log,
    } as any;

    const refresher = new PrivilegeRefresher(
      "http://localhost:8787/cosmetics.json",
      "test_key",
      "http://localhost:8787/reserved_clan_tags",
      log,
      60000,
    );

    await expect((refresher as any).loadPrivilegeChecker()).resolves.not.toThrow();

    const checker = refresher.get();
    expect(checker).toBeDefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
