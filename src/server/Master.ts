import cluster from "cluster";
import cors from "cors";
import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import httpProxy from "http-proxy";
import path from "path";
import { fileURLToPath } from "url";
import { GameEnv } from "../core/configuration/Config";
import { getServerConfigFromServer } from "../core/configuration/ConfigLoader";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { MasterLobbyService } from "./MasterLobbyService";
import { setNoStoreHeaders } from "./NoStoreHeaders";
import { renderAppShell } from "./RenderHtml";
import { applyStaticAssetCacheControl } from "./StaticAssetCache";

const config = getServerConfigFromServer();
const playlist = new MapPlaylist();
let lobbyService: MasterLobbyService;

const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({});

const log = logger.child({ comp: "m" });

// Handle proxy errors to prevent master from crashing
proxy.on("error", (err, _req, res) => {
  log.error("Proxy error:", err);
  if (res instanceof http.ServerResponse) {
    res.status(502).send("Bad Gateway");
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = config.env() === GameEnv.Dev;
const staticPath = isDev
  ? path.join(__dirname, "../../resources")
  : path.join(__dirname, "../../static");
const indexPath = isDev
  ? path.join(__dirname, "../../index.html")
  : path.join(__dirname, "../../static/index.html");

app.use(cors({ origin: ["http://localhost:5173", "http://localhost:9000"] }));
app.use(express.json());

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

if (isDev) {
  // In development, serve the project root as well to allow access to source files if needed,
  // but prioritize the resources directory for static assets.
  app.use(express.static(path.join(__dirname, "../../")));
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
  express.static(path.join(__dirname, "../../resources/maps"), {
    maxAge: "1y",
  }),
);

app.set("trust proxy", 3);
app.use(
  rateLimit({
    windowMs: 1000, // 1 second
    max: 20, // 20 requests per IP per second
  }),
);

// Proxy worker requests (both HTTP and WebSocket upgrades)
app.all("/w:workerId*", (req, res) => {
  const workerId = parseInt(req.params.workerId);
  if (isNaN(workerId) || workerId < 0 || workerId >= config.numWorkers()) {
    return res.status(404).send("Worker not found");
  }
  const targetPort = config.workerPortByIndex(workerId);
  proxy.web(req, res, { target: `http://localhost:${targetPort}` });
});

// Handle WebSocket upgrades for workers
server.on("upgrade", (req, socket, head) => {
  const pathname = req.url ?? "";
  const match = pathname.match(/^\/w(\d+)/);
  if (match) {
    const workerId = parseInt(match[1]);
    if (!isNaN(workerId) && workerId >= 0 && workerId < config.numWorkers()) {
      const targetPort = config.workerPortByIndex(workerId);
      proxy.ws(req, socket, head, { target: `http://localhost:${targetPort}` });
      return;
    }
  }
  // If no worker match, just destroy the socket
  socket.destroy();
});

app.use("/api", (_req, res, next) => {
  setNoStoreHeaders(res);
  next();
});

// Start the master process
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error(
      "startMaster() should only be called in the primary process",
    );
  }

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${config.numWorkers()} workers...`);

  lobbyService = new MasterLobbyService(config, playlist, log);

  // Generate admin token for worker authentication
  const ADMIN_TOKEN = crypto.randomBytes(16).toString("hex");
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const INSTANCE_ID =
    config.env() === GameEnv.Dev
      ? "DEV_ID"
      : crypto.randomBytes(4).toString("hex");
  process.env.INSTANCE_ID = INSTANCE_ID;

  log.info(`Instance ID: ${INSTANCE_ID}`);

  // Fork workers
  for (let i = 0; i < config.numWorkers(); i++) {
    const worker = cluster.fork({
      WORKER_ID: i,
      ADMIN_TOKEN,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(i, worker);
    log.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  // Handle worker crashes
  cluster.on("exit", (worker, code, signal) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (workerId === undefined) {
      log.error(`worker crashed could not find id`);
      return;
    }

    const workerIdNum = parseInt(workerId);
    lobbyService.removeWorker(workerIdNum);

    log.warn(
      `Worker ${workerId} (PID: ${worker.process.pid}) died with code: ${code} and signal: ${signal}`,
    );
    log.info(`Restarting worker ${workerId}...`);

    // Restart the worker with the same ID
    const newWorker = cluster.fork({
      WORKER_ID: workerId,
      ADMIN_TOKEN,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(workerIdNum, newWorker);
    log.info(
      `Restarted worker ${workerId} (New PID: ${newWorker.process.pid})`,
    );
  });

  const PORT = process.env.PORT ?? 9001;
  server.listen(PORT, () => {
    log.info(`Master HTTP server listening on port ${PORT}`);
  });
}

app.get("/api/health", (_req, res) => {
  const ready = lobbyService?.isHealthy() ?? false;
  if (ready) {
    res.json({ status: "ok" });
  } else {
    res.status(503).json({ status: "unavailable" });
  }
});

app.get("/api/instance", (_req, res) => {
  res.json({
    instanceId: process.env.INSTANCE_ID ?? "undefined",
  });
});

// SPA fallback route
app.get("/{*splat}", async function (req, res) {
  // Exclude JSON files and /maps/ directory from SPA fallback
  if (req.path.endsWith(".json") || req.path.includes("/maps/")) {
    return res.status(404).send("Not Found");
  }

  try {
    await renderAppShell(res, indexPath);
  } catch (error) {
    log.error("Error rendering SPA fallback:", error);
    res.status(500).send("Internal Server Error");
  }
});
