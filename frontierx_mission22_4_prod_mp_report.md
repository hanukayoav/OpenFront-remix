# Mission 22.4 Engineering Report — Production Multiplayer Routing, Auth Dependency & Release Metadata Repair

**Branch:** `fix/frontierx-mission22-4-prod-mp-metadata` (branched from `origin/main` @ `139da335ef5fe8c68be9d048ad71cf2f3f3e9760`)  
**Target Version:** `v1.0.7`  
**Hardware:** Desktop (`AMD Ryzen 7 9800X3D`, `NVIDIA RTX 5070 Ti`, `32 GB RAM`, `Windows 11 Home`; Dell laptop not accessed)

---

## 1. Phase 1 Root-Cause Diagnosis

### 1.1 Reverse-Proxy & `Master.ts` Routing Mismatch

- Live production (`https://openfront-2.duckdns.org`) serves behind host `nginx/1.24.0 (Ubuntu)` proxying directly to PM2 `openfront-server` (`src/server/Master.ts` on port `9001`), rather than the containerized `nginx.conf` + `supervisord.conf` multi-upstream topology.
- `Master.ts` only proxied `/w(\d+)(.*)` and had no routes for prefix-less `POST /api/create_game`, `POST /api/adminbot/create_game`, or `GET /commit.txt`.
  - Live probes prior to fix:
    - `POST /api/create_game` -> `404 Cannot POST /api/create_game`
    - `POST /w0/api/create_game` -> `400 {"error":"Authorization header required to create a game"}` (proving workers run cleanly)
    - `GET /commit.txt` -> `200 text/html` (SPA fallback)
- `Master.ts` also mounted `app.use(express.json())` ahead of `http-proxy`, consuming incoming JSON request streams before downstream `proxy.web(...)` forwarding.

### 1.2 External Auth/API Dependency (Approval Required for Live OCI Cutover)

- Both `ServerEnv.jwtIssuer()` (`src/server/ServerEnv.ts`) and `ClientEnv.jwtIssuer()` / `getApiBase()` (`src/client/ClientEnv.ts`, `src/client/Api.ts`) resolve `.duckdns.org` domains to `https://openfront-2.duckdns.org/api`.
- Live probes confirmed no external `openfront-api` auth service is deployed or routed on OCI:
  - `GET /api/.well-known/jwks.json` -> `404 Not Found`
  - `POST /api/auth/refresh` -> `404 Cannot POST /api/auth/refresh`
- `OpenFront-remix` intentionally contains **no** auth issuer, OAuth handler, JWK signer, session store, `/users/@me` backend, or Turnstile verifier. Under `GAME_ENV=prod`, `verifyClientToken()` (`src/server/jwt.ts`) strictly rejects unsigned UUID persistent-ID tokens and enforces EdDSA JWT verification against `${jwtIssuer()}/.well-known/jwks.json`, plus server-side `/users/@me` and `/join_verify` validation.
- **Explicit Approval Gate (Live OCI Infrastructure Not Modified Automatically):**
  To enable live authenticated multiplayer on `https://openfront-2.duckdns.org` without weakening security, operator approval is required to:
  1. Deploy or wire an `openfront-api` backend service (JWKS, `/auth/*`, `/users/@me`, `/join_verify`) with valid `API_KEY` and Turnstile secrets on OCI (or configure an approved external API service).
  2. Route `/api/auth/*`, `/api/.well-known/jwks.json`, `/api/users/*`, and `/api/join_verify` on OCI host `nginx` to that API backend, while keeping `/api/create_game`, `/api/adminbot/create_game`, `/api/health`, `/commit.txt`, and `/w(\d+)/*` routed to `127.0.0.1:9001` (`Master.ts`).

### 1.3 Stale Release Metadata (`gitCommit` and `v1.0.5` Display)

- `.github/workflows/deploy-oci.yml` ran `BUILD_OUT_DIR=static_staging npm run build-prod` without resolving/passing `GIT_COMMIT`, and `pm2 restart openfront-server --update-env` preserved stale `GIT_COMMIT` (`6731269a`) in PM2's environment.
- `resources/version.txt` still held `1.0.5`, while `src/client/GameStartingModal.ts` and `resources/images/FrontierXLogo.svg` each duplicated hardcoded `v1.0.5` strings.

---

## 2. Phase 2 & 3 Changes Implemented

- **Routing & Multi-Worker Proxy (`src/server/MasterLobbyService.ts`, `src/server/Master.ts`):**
  - Added `MasterLobbyService.getReadyWorkerIds()` and `pickReadyWorkerId()` to track live ready cluster workers.
  - Extracted testable `createMasterApp(...)` and `handleUpgrade` in `src/server/Master.ts`.
  - Removed global `app.use(express.json())` from `Master.ts` so `http-proxy` streams JSON POST bodies intact.
  - Added `POST /api/create_game` and `POST /api/adminbot/create_game` proxying across ready workers (returning `503` when no ready workers exist) under existing `rateLimit(...)` and `no-store` headers.
  - Added explicit `GET /commit.txt` handler (`text/plain; charset=utf-8`, `no-store`) and excluded `/api` + `/api/*` from returning SPA `index.html`.
- **Automated Build & Runtime Commit Metadata (`src/server/BuildMetadata.ts`, `vite.config.ts`, `src/server/ServerEnv.ts`, `.github/workflows/deploy-oci.yml`):**
  - Added non-secret build metadata emission (`static/build-metadata.json` and `static/commit.txt`) during `vite build` using `GIT_COMMIT` -> `GITHUB_SHA` -> `git rev-parse HEAD`.
  - Updated `ServerEnv.gitCommit()` via `resolveRuntimeGitCommit()` so non-Dev (`prod`/`staging`) builds prefer emitted `static/` metadata over stale PM2 environment variables, while `GameEnv.Dev` preserves `process.env.GIT_COMMIT` overrides for local dev/tests.
  - Updated `.github/workflows/deploy-oci.yml` (executes only after merge/approval) to propagate `GIT_COMMIT=$(git rev-parse HEAD)` through build, PM2 reload, and `/commit.txt` post-deploy verification.
- **Unified `v1.0.7` Version Display (`resources/version.txt`, `src/client/AppVersion.ts`, `src/client/GameStartingModal.ts`, `src/client/Main.ts`, `src/client/components/NavNotificationsController.ts`, `resources/images/FrontierXLogo.svg`):**
  - Updated `resources/version.txt` to `1.0.7` and `FrontierXLogo.svg` badge to `v1.0.7`.
  - Consolidated duplicated version formatting into `src/client/AppVersion.ts` (`DISPLAY_APP_VERSION`) and removed hardcoded `v1.0.5` from `GameStartingModal.ts`.

---

## 3. Security Preservation

- `PersistentIdSchema` unsigned tokens remain strictly `GameEnv.Dev`-only (`src/server/jwt.ts`); `GAME_ENV=prod` rejects them (`401` / WS `1002`).
- EdDSA signature verification, issuer (`jwtIssuer()`), audience (`jwtAudience()`), expiration, `/users/@me` (`x-api-key`), `/join_verify` Turnstile enforcement, and IP rate limiting remain intact.
- Zero private keys, secrets, or credentials exist in commits, logs, `build-metadata.json`, or browser bundles.

---

## 4. Verification Coverage

- **Unit & Integration Suites:**
  - `tests/server/MasterRouting.test.ts` — prefix-less `/api/create_game` & `/api/adminbot/create_game` JSON body streaming, `/w0` body streaming, `503` unready cluster, `404` out-of-range worker & unbacked `/api/*`, `no-store` `/commit.txt`, `429` rate limit, WS upgrade proxy & invalid worker disconnect.
  - `tests/server/BuildMetadataAndVersion.test.ts` — `writeBuildMetadata`, `resolveRuntimeGitCommit` ignoring stale `GIT_COMMIT` in prod, `1.0.7` consistency across `version.txt`, SVG, and modal.
  - `tests/server/ProdAuthSecurity.test.ts` — real Ed25519 JWKS verification in `GAME_ENV=prod`, rejection of unsigned UUIDs / forged / expired / wrong-issuer / wrong-audience JWTs, fail-closed `/users/@me` with `x-api-key`.
  - `tests/server/MasterLobbyServiceHealth.test.ts` — ready worker selection assertions.
- **Two-Browser Production-Equivalent E2E (`tests/perf/ProdMultiplayerMetadataQa.cjs`):**
  - Runs `Master` + `2 Workers` in `GAME_ENV=prod` against ephemeral Ed25519 JWKS + `/auth/refresh` + `/users/@me` + `/join_verify` mock API server on `localhost:8787`, deliberately passing stale `GIT_COMMIT=stale6731`.
  - Verifies `/api/health`, `/commit.txt` === built SHA, unauth/unsigned/forged rejection on `/api/create_game` and WS join, `v1.0.7` + built SHA in UI, authenticated lobby creation through `Master`, two-browser join on assigned worker (`/w1`), `extreme` supply-drop mutator parity, WebGL2 rendering frames, synchronized ticks, and WS disconnect + `rejoin` recovery.

---

## 5. Rollback Procedure

1. If reverting code on `main`: `git revert <merge-commit-sha>` and re-run `npm run build-prod`.
2. On OCI (`deploy-oci.yml` already creates `.deploy_backups` pre-deploy snapshots): restore previous `static/` & git revision and `pm2 restart openfront-server --update-env`.
