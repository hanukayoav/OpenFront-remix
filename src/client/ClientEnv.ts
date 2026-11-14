import { createLocalJWKSet, JWK } from "jose";
import { z } from "zod";
import { GameID } from "../core/Schemas";
import { simpleHash } from "../core/Util";
import {
  GameEnv,
  JwksSchema,
  parseGameEnv,
} from "../core/configuration/Config";

type LocalJwkSet = ReturnType<typeof createLocalJWKSet>;

export class ClientEnv {
  private static values: ClientEnvValues | null = null;
  private static jwksKeys: JWK[] | null = null;
  private static jwksVerifier: LocalJwkSet | null = null;
  private static jwksLastFetchMs = 0;

  /** Test-only. */
  static reset(): void {
    ClientEnv.values = null;
    ClientEnv.jwksKeys = null;
    ClientEnv.jwksVerifier = null;
    ClientEnv.jwksLastFetchMs = 0;
  }

  private static get(): ClientEnvValues {
    if (ClientEnv.values) return ClientEnv.values;
    if (typeof window === "undefined") {
      throw new Error("ClientEnv is only available on the browser main thread");
    }
    const bc = window.BOOTSTRAP_CONFIG;
    if (
      !bc ||
      bc.gameEnv === undefined ||
      bc.numWorkers === undefined ||
      bc.turnstileSiteKey === undefined ||
      bc.jwtAudience === undefined ||
      bc.instanceId === undefined ||
      bc.gitCommit === undefined
    ) {
      throw new Error("Missing BOOTSTRAP_CONFIG");
    }
    ClientEnv.values = {
      gameEnv: parseGameEnv(bc.gameEnv),
      numWorkers: bc.numWorkers,
      turnstileSiteKey: bc.turnstileSiteKey,
      jwtAudience: bc.jwtAudience,
      instanceId: bc.instanceId,
      gitCommit: bc.gitCommit,
      // Optional: only the desktop app injects an explicit game-server host.
      // Absent on the web build (falls back to same-origin window.location).
      serverHost: bc.serverHost,
    };
    return ClientEnv.values;
  }

  // TODO: the following methods are duplicated on ServerEnv. The two classes
  // read from different sources (window.BOOTSTRAP_CONFIG vs process.env) but
  // the derived logic is identical. Consolidate into a shared helper that
  // takes a source so we don't have to keep them in sync by hand.
  static env(): GameEnv {
    return ClientEnv.get().gameEnv;
  }
  static numWorkers(): number {
    return ClientEnv.get().numWorkers;
  }
  static turnstileSiteKey(): string {
    return ClientEnv.get().turnstileSiteKey;
  }
  static jwtAudience(): string {
    return ClientEnv.get().jwtAudience;
  }
  static instanceId(): string {
    return ClientEnv.get().instanceId;
  }
  static gitCommit(): string {
    return ClientEnv.get().gitCommit;
  }
  static jwtIssuer(): string {
    const audience = ClientEnv.jwtAudience();
    if (audience === "localhost") {
      return "http://localhost:8787";
    }
    if (
      audience.endsWith(".duckdns.org") ||
      audience.endsWith(".onrender.com") ||
      (typeof window !== "undefined" &&
        (window.location.hostname.endsWith(".duckdns.org") ||
          window.location.hostname.endsWith(".onrender.com")))
    ) {
      return `${typeof window !== "undefined" ? window.location.origin : `https://${audience}`}/api`;
    }
    return `https://api.${audience}`;
  }
  private static async fetchJwks(forceRefresh = false): Promise<{
    keys: JWK[];
    verifier: LocalJwkSet;
  }> {
    const now = Date.now();
    if (
      ClientEnv.jwksKeys &&
      ClientEnv.jwksVerifier &&
      (!forceRefresh || now - ClientEnv.jwksLastFetchMs < 5000)
    ) {
      return {
        keys: ClientEnv.jwksKeys,
        verifier: ClientEnv.jwksVerifier,
      };
    }
    const jwksUrl = ClientEnv.jwtIssuer() + "/.well-known/jwks.json";
    console.log(`Fetching JWKS from ${jwksUrl}`);
    const response = await fetch(jwksUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`JWKS fetch failed: ${response.status} ${body}`);
    }
    const result = JwksSchema.safeParse(await response.json());
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Error parsing JWKS", error);
      throw new Error("Invalid JWKS");
    }
    ClientEnv.jwksLastFetchMs = now;
    ClientEnv.jwksKeys = result.data.keys;
    ClientEnv.jwksVerifier = createLocalJWKSet({ keys: result.data.keys });
    return {
      keys: ClientEnv.jwksKeys,
      verifier: ClientEnv.jwksVerifier,
    };
  }
  static async jwkSet(forceRefresh = false): Promise<LocalJwkSet> {
    const { verifier } = await ClientEnv.fetchJwks(forceRefresh);
    return verifier;
  }
  static async jwkPublicKey(forceRefresh = false): Promise<JWK> {
    const { keys } = await ClientEnv.fetchJwks(forceRefresh);
    return keys[0];
  }
  static turnIntervalMs(): number {
    return 100;
  }
  static gameCreationRate(): number {
    return ClientEnv.env() === GameEnv.Dev ? 5 * 1000 : 2 * 60 * 1000;
  }
  static workerIndex(gameID: GameID): number {
    return simpleHash(gameID) % ClientEnv.numWorkers();
  }
  static workerPath(gameID: GameID): string {
    return `w${ClientEnv.workerIndex(gameID)}`;
  }
  // Explicit game-server host, injected by the desktop app (absent on web).
  static serverHost(): string | undefined {
    return ClientEnv.get().serverHost;
  }
  // Origin (scheme + host, no trailing slash) of the game server that hosts the
  // public-lobby and in-game WebSockets. The lobby-list and game sockets append
  // their own worker path (e.g. `/w0/lobbies`, `/w0`).
  static serverWsBase(): string {
    return deriveServerWsBase(
      ClientEnv.serverHost(),
      window.location.protocol,
      window.location.host,
    );
  }
}

/**
 * Resolve the game-server WebSocket origin.
 *
 * When an explicit `serverHost` is configured, target it over TLS (wss). Only
 * the desktop app sets this: it loads the renderer from `app://openfront`,
 * where `window.location.host` is just "openfront" (not a real server), and the
 * game-server host is NOT derivable from the API audience — it is the bare
 * audience host in prod (`openfront.io`) but a branch-variable subdomain on
 * dev/staging (default `main.openfront.dev`, or `<branch>.openfront.dev`). So
 * the host is injected explicitly rather than derived.
 *
 * When no `serverHost` is configured — the normal web build — the game server
 * is same-origin as the document, so we keep the historical behaviour exactly:
 * derive scheme + host from `window.location`. This leaves the web build
 * byte-for-byte unchanged.
 */
export function deriveServerWsBase(
  serverHost: string | undefined,
  locationProtocol: string,
  locationHost: string,
): string {
  if (serverHost) {
    return `wss://${serverHost}`;
  }
  const wsProtocol = locationProtocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${locationHost}`;
}
/**
 * Values that flow from server → client via index.html. Set on the server from
 * process.env, then re-hydrated on the client from window.BOOTSTRAP_CONFIG.
 */

export interface ClientEnvValues {
  gameEnv: GameEnv;
  numWorkers: number;
  turnstileSiteKey: string;
  jwtAudience: string;
  instanceId: string;
  gitCommit: string;
  serverHost?: string;
}
