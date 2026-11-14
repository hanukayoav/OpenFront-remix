import cluster from "cluster";
import cors from "cors";
import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import httpProxy from "http-proxy";
import path from "path";
import type { Duplex } from "stream";
import type winston from "winston";
import { GameEnv } from "../core/configuration/Config";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { MasterLobbyService } from "./MasterLobbyService";
import { setNoStoreHeaders } from "./NoStoreHeaders";
import { renderAppShell } from "./RenderHtml";
import { ServerEnv } from "./ServerEnv";
import { applyStaticAssetCacheControl } from "./StaticAssetCache";

export interface MasterAppOptions {
  isDev?: boolean;
  staticPath?: string;
  indexPath?: string;
  authServiceUrl?: string;
  numWorkers?: () => number;
  getReadyWorkerIds?: () => number[];
  isClusterHealthy?: () => boolean;
  getWorkerTarget?: (workerId: number) => string;
  getGitCommit?: () => string;
  random?: () => number;
  rateLimitMax?: number;
  log?: winston.Logger;
}

const defaultLog = logger.child({ comp: "m" });

function pickWorkerFromIds(
  readyIds: number[],
  random: () => number,
): number | null {
  if (readyIds.length === 0) {
    return null;
  }
  const index = Math.min(
    Math.floor(random() * readyIds.length),
    readyIds.length - 1,
  );
  return readyIds[Math.max(0, index)];
}

export function createMasterApp(options: MasterAppOptions = {}) {
  const isDev = options.isDev ?? ServerEnv.env() === GameEnv.Dev;
  const log = options.log ?? defaultLog;
  const staticPath =
    options.staticPath ??
    (isDev
      ? path.join(process.cwd(), "resources")
      : path.join(process.cwd(), "static"));
  const indexPath =
    options.indexPath ??
    (isDev
      ? path.join(process.cwd(), "index.html")
      : path.join(process.cwd(), "static/index.html"));
  const numWorkers = options.numWorkers ?? (() => ServerEnv.numWorkers());
  const getReadyWorkerIds = options.getReadyWorkerIds ?? (() => []);
  const isClusterHealthy = options.isClusterHealthy ?? (() => false);
  const getWorkerTarget =
    options.getWorkerTarget ??
    ((workerId: number) =>
      `http://localhost:${ServerEnv.workerPortByIndex(workerId)}`);
  const getGitCommit = options.getGitCommit ?? (() => ServerEnv.gitCommit());
  const random = options.random ?? Math.random;
  const rawEnvAuthServiceUrl = process.env.AUTH_SERVICE_URL?.trim() ?? "";
  const authServiceUrl =
    options.authServiceUrl ??
    (rawEnvAuthServiceUrl.length > 0 ? rawEnvAuthServiceUrl : undefined);

  const app = express();
  const proxy = httpProxy.createProxyServer({});

  // Handle proxy errors cleanly for both HTTP responses and WebSocket sockets.
  proxy.on("error", (err, _req, res) => {
    log.error("Proxy error:", err);
    if (res instanceof http.ServerResponse) {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end("Bad Gateway");
    } else if (res && typeof (res as Duplex).destroy === "function") {
      (res as Duplex).destroy();
    }
  });

  app.use(
    cors({
      origin: isDev ? "*" : ["http://localhost:5173", "http://localhost:9000"],
    }),
  );

  // NOTE: Do NOT mount body parsers (like express.json()) globally on Master.
  // Master acts as a reverse proxy for workers; consuming the request stream
  // here breaks downstream http-proxy POST forwarding.

  // Serve the shared app shell for the root document.
  app.use(async (req, res, next) => {
    if (req.path === "/") {
      try {
        await renderAppShell(res, indexPath);
      } catch (error) {
        log.error("Error rendering index.html:", error);
        res.status(500).send("Internal Server Error");
      }
    } else {
      next();
    }
  });

  // Expose live runtime build commit explicitly so verification checks do not
  // fall through to the SPA fallback when static/commit.txt is absent.
  app.get("/commit.txt", (_req, res) => {
    setNoStoreHeaders(res);
    try {
      res.type("text/plain; charset=utf-8").send(getGitCommit());
    } catch (error) {
      log.error("Failed to resolve git commit metadata:", error);
      res.status(500).type("text/plain; charset=utf-8").send("unavailable");
    }
  });

  if (isDev) {
    // In development, serve the project root as well to allow access to source files if needed,
    // but prioritize the resources directory for static assets.
    app.use(express.static(process.cwd()));
  }

  app.use(
    express.static(staticPath, {
      maxAge: "1y", // Set max-age to 1 year for all static assets
      setHeaders: (res) => {
        applyStaticAssetCacheControl(
          res.setHeader.bind(res),
          res.req.originalUrl,
        );
      },
    }),
  );

  // Ensure maps are always accessible via relative path, even in production
  app.use(
    "/maps",
    express.static(path.join(process.cwd(), "resources/maps"), {
      maxAge: "1y",
    }),
  );

  app.set("trust proxy", 3);
  app.use(
    rateLimit({
      windowMs: 1000, // 1 second
      max: options.rateLimitMax ?? 20, // 20 requests per IP per second
    }),
  );

  app.use("/api", (_req, res, next) => {
    setNoStoreHeaders(res);
    next();
  });

  // Mirror nginx's prefix-less creation routing directly on Master so bare-metal
  // or host-nginx deployments (which proxy :80/:443 -> Master:9001) route
  // POST /api/create_game and POST /api/adminbot/create_game to ready workers.
  app.post(["/api/create_game", "/api/adminbot/create_game"], (req, res) => {
    const workerId = pickWorkerFromIds(getReadyWorkerIds(), random);
    if (workerId === null) {
      return res.status(503).json({ error: "No ready workers available" });
    }
    proxy.web(req, res, { target: getWorkerTarget(workerId) });
  });

  // Proxy worker HTTP requests
  app.all(/^\/w(\d+)(.*)/, (req, res) => {
    const workerId = parseInt(req.params[0], 10);
    if (isNaN(workerId) || workerId < 0 || workerId >= numWorkers()) {
      return res.status(404).send("Worker not found");
    }
    proxy.web(req, res, { target: getWorkerTarget(workerId) });
  });

  app.get("/api/health", (_req, res) => {
    const ready = isClusterHealthy();
    if (ready) {
      res.json({ status: "ok" });
    } else {
      res.status(503).json({ status: "unavailable" });
    }
  });

  if (authServiceUrl) {
    app.all(
      [
        "/api/.well-known/jwks.json",
        "/api/ready",
        "/api/auth/{*splat}",
        "/api/users/{*splat}",
        "/api/join_verify",
        "/api/cosmetics.json",
        "/api/reserved_clan_tags",
        "/api/custom_tribes",
        "/api/game/{*splat}",
        "/api/archive_singleplayer_game",
        "/api/news.json",
        "/api/streams.json",
      ],
      (req, res) => {
        proxy.web(req, res, { target: authServiceUrl });
      },
    );
  }

  // SPA fallback route
  app.get("/{*splat}", async function (req, res) {
    // Exclude API routes, JSON files, and /maps/ directory from SPA fallback
    if (
      req.path === "/api" ||
      req.path.startsWith("/api/") ||
      req.path.endsWith(".json") ||
      req.path.includes("/maps/")
    ) {
      return res.status(404).send("Not Found");
    }

    try {
      await renderAppShell(res, indexPath);
    } catch (error) {
      log.error("Error rendering SPA fallback:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = req.url ?? "";
    const match = pathname.match(/^\/w(\d+)/);
    if (match) {
      const workerId = parseInt(match[1], 10);
      if (!isNaN(workerId) && workerId >= 0 && workerId < numWorkers()) {
        proxy.ws(req, socket, head, { target: getWorkerTarget(workerId) });
        return;
      }
    }
    socket.destroy();
  };

  return { app, proxy, handleUpgrade };
}

// Start the master process
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error(
      "startMaster() should only be called in the primary process",
    );
  }

  defaultLog.info(`Primary ${process.pid} is running`);
  defaultLog.info(`Setting up ${ServerEnv.numWorkers()} workers...`);

  const playlist = new MapPlaylist();
  const lobbyService = new MasterLobbyService(playlist, defaultLog);

  const INSTANCE_ID =
    ServerEnv.env() === GameEnv.Dev
      ? "DEV_ID"
      : crypto.randomBytes(4).toString("hex");
  process.env.INSTANCE_ID = INSTANCE_ID;

  defaultLog.info(`Instance ID: ${INSTANCE_ID}`);

  // Fork workers
  for (let i = 0; i < ServerEnv.numWorkers(); i++) {
    const worker = cluster.fork({
      WORKER_ID: i,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(i, worker);
    defaultLog.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  // Handle worker crashes
  cluster.on("exit", (worker, code, signal) => {
    const workerId = (worker as { process?: { env?: { WORKER_ID?: string } } })
      .process?.env?.WORKER_ID;
    if (workerId === undefined) {
      defaultLog.error(`worker crashed could not find id`);
      return;
    }

    const workerIdNum = parseInt(workerId, 10);
    lobbyService.removeWorker(workerIdNum);

    defaultLog.warn(
      `Worker ${workerId} (PID: ${worker.process.pid}) died with code: ${code} and signal: ${signal}`,
    );
    defaultLog.info(`Restarting worker ${workerId}...`);

    // Restart the worker with the same ID
    const newWorker = cluster.fork({
      WORKER_ID: workerId,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(workerIdNum, newWorker);
    defaultLog.info(
      `Restarted worker ${workerId} (New PID: ${newWorker.process.pid})`,
    );
  });

  const { app, handleUpgrade } = createMasterApp({
    getReadyWorkerIds: () => lobbyService.getReadyWorkerIds(),
    isClusterHealthy: () => lobbyService.isHealthy(),
  });
  const server = http.createServer(app);
  server.on("upgrade", handleUpgrade);

  const PORT = process.env.PORT ?? 9001;
  server.listen(PORT, () => {
    defaultLog.info(`Master HTTP server listening on port ${PORT}`);
  });
}
