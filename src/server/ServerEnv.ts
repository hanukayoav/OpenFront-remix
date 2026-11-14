import { JWK } from "jose";
import { z } from "zod";
import { GameEnv, parseGameEnv } from "../core/configuration/Config";
import { GameID } from "../core/Schemas";
import { generateID, simpleHash } from "../core/Util";
import { resolveRuntimeGitCommit } from "./BuildMetadata";

const JwksSchema = z.object({
  keys: z
    .object({
      alg: z.literal("EdDSA"),
      crv: z.literal("Ed25519"),
      kty: z.literal("OKP"),
      x: z.string(),
    })
    .array()
    .min(1),
});

export class ServerEnv {
  private static readonly gameEnv: GameEnv = parseGameEnv(process.env.GAME_ENV);
  private static publicKey: JWK | null = null;
  private static jwksLastFetchMs = 0;

  // Values that also flow to the client via index.html, but on the server
  // are read from process.env directly. Server code never reaches into
  // ClientEnv — that's reserved for the browser/worker hydrated path.
  //
  // TODO: the following methods are duplicated on ClientEnv. The two classes
  // read from different sources (process.env vs window.BOOTSTRAP_CONFIG) but
  // the derived logic is identical. Consolidate into a shared helper that
  // takes a source so we don't have to keep them in sync by hand.
  static env(): GameEnv {
    return ServerEnv.gameEnv;
  }
  static gameEnvName(): string {
    switch (ServerEnv.gameEnv) {
      case GameEnv.Dev:
        return "dev";
      case GameEnv.Preprod:
        return "staging";
      case GameEnv.Prod:
        return "prod";
    }
  }
  static numWorkers(): number {
    const raw = process.env.NUM_WORKERS;
    if (!raw) {
      throw new Error("NUM_WORKERS not set");
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid NUM_WORKERS: ${raw}`);
    }
    return n;
  }
  static turnstileSiteKey(): string {
    const v = process.env.TURNSTILE_SITE_KEY;
    if (!v) {
      throw new Error("TURNSTILE_SITE_KEY not set");
    }
    return v;
  }
  static jwtAudience(): string {
    const v = process.env.DOMAIN;
    if (!v) {
      throw new Error("DOMAIN not set");
    }
    return v;
  }
  static instanceId(): string {
    return process.env.INSTANCE_ID ?? "";
  }
  static workerId(): number | undefined {
    const raw = process.env.WORKER_ID;
    if (raw === undefined) return undefined;
    return parseInt(raw, 10);
  }
  static hostname(): string {
    return process.env.HOSTNAME ?? "";
  }
  static host(): string {
    return process.env.HOST ?? "";
  }
  static cdnBase(): string {
    return process.env.CDN_BASE ?? "";
  }
  static jwtIssuer(): string {
    const audience = ServerEnv.jwtAudience();
    if (audience === "localhost") {
      return "http://localhost:8787";
    }
    if (
      audience.endsWith(".duckdns.org") ||
      audience.endsWith(".onrender.com")
    ) {
      return `https://${audience}/api`;
    }
    return `https://api.${audience}`;
  }
  static internalApiBase(): string {
    const override = process.env.AUTH_INTERNAL_URL?.trim();
    if (override) {
      return override.replace(/\/+$/, "");
    }
    return ServerEnv.jwtIssuer();
  }
  static async jwkPublicKey(forceRefresh = false): Promise<JWK> {
    const now = Date.now();
    if (
      ServerEnv.publicKey &&
      (!forceRefresh || now - ServerEnv.jwksLastFetchMs < 5000)
    ) {
      return ServerEnv.publicKey;
    }
    const jwksUrl = ServerEnv.internalApiBase() + "/.well-known/jwks.json";
    console.log(`Fetching JWKS from ${jwksUrl}`);
    const response = await fetch(jwksUrl, {
      signal: AbortSignal.timeout(5000),
    });
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
    ServerEnv.jwksLastFetchMs = now;
    ServerEnv.publicKey = result.data.keys[0];
    return ServerEnv.publicKey;
  }
  static turnIntervalMs(): number {
    return 100;
  }
  static gameCreationRate(): number {
    return ServerEnv.gameEnv === GameEnv.Dev ? 5 * 1000 : 2 * 60 * 1000;
  }
  static workerIndex(gameID: GameID): number {
    return simpleHash(gameID) % ServerEnv.numWorkers();
  }
  static workerPath(gameID: GameID): string {
    return `w${ServerEnv.workerIndex(gameID)}`;
  }
  static workerPort(gameID: GameID): number {
    return ServerEnv.workerPortByIndex(ServerEnv.workerIndex(gameID));
  }
  static workerPortByIndex(index: number): number {
    return 3001 + index;
  }
  // Generate a game id that hashes to `workerId`, so requests for the game route
  // back to this worker. Rejection sampling: each id lands on a uniformly-random
  // worker, so the expected number of tries is numWorkers; the cap scales with
  // the worker count to keep the failure chance negligible (~e^-100). Returns
  // null if none was found (effectively never).
  static generateGameIdForWorker(workerId: number): GameID | null {
    const maxAttempts = ServerEnv.numWorkers() * 100;
    for (let i = 0; i < maxAttempts; i++) {
      const id = generateID();
      if (ServerEnv.workerIndex(id) === workerId) return id;
    }
    return null;
  }

  // Server-only env values
  static domain(): string {
    return process.env.DOMAIN ?? "";
  }
  static subdomain(): string {
    return process.env.SUBDOMAIN ?? "";
  }
  static otelEnabled(): boolean {
    return (
      ServerEnv.gameEnv !== GameEnv.Dev &&
      Boolean(ServerEnv.otelEndpoint()) &&
      Boolean(ServerEnv.otelAuthHeader())
    );
  }
  static otelEndpoint(): string {
    return process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
  }
  static otelAuthHeader(): string {
    return process.env.OTEL_AUTH_HEADER ?? "";
  }
  static gitCommit(): string {
    return resolveRuntimeGitCommit({
      isDev: ServerEnv.gameEnv === GameEnv.Dev,
      envCommit: process.env.GIT_COMMIT,
    });
  }
  static apiKey(): string {
    return process.env.API_KEY ?? "";
  }
  // Long-lived shared secret for the trusted admin bot HTTP API.
  // Undefined when unset, which disables the admin bot API entirely.
  static adminBotKey(): string | undefined {
    const v = process.env.ADMIN_BOT_API_KEY;
    return v && v.length > 0 ? v : undefined;
  }
  static adminBotHeader(): string {
    return "x-admin-bot-key";
  }
  static allowedFlares(): string[] | undefined {
    const raw = process.env.ALLOWED_FLARES;
    if (!raw) return undefined;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
