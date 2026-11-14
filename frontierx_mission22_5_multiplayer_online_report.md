# Mission 22.5 Report: FrontierX — Project Multiplayer Online

**Repository:** `hanukayoav/OpenFront-remix`  
**Branch:** `feat/frontierx-mission22-5-multiplayer-online` (branched from PR #18 head `0744804cc`)  
**Prerequisite Dependency:** PR #18 (`fix/frontierx-mission22-4-prod-mp-metadata` -> `main`) remained `OPEN` during this mission and was **not** merged independently, per Mission 22.5 rules. All Mission 22.5 changes were built cleanly on top without modifying PR #18's branch.  
**Production Target:** `https://openfront-2.duckdns.org` (live OCI host **not** modified; pending operator approval)

---

## 1. Initial Root Causes

Mission 22.4 resolved Master/Worker routing and release metadata, leaving public production multiplayer blocked by missing authentication and API backend infrastructure:

1. **No Hosted JWT / JWKS Issuer for FrontierX:**
   In production (`GAME_ENV=prod`), the FrontierX Workers require signed `EdDSA` (`Ed25519`) JWTs matching `JWT_ISSUER` / `JWT_AUDIENCE`, verified against `<jwtIssuer>/.well-known/jwks.json`. The upstream `api.openfront.io` service is unavailable/external to `openfront-2.duckdns.org`, and `ClientEnv.jwtIssuer()` resolves to `https://openfront-2.duckdns.org/api` on `.duckdns.org` hosts.
2. **Missing Required `/api/*` Endpoints:**
   No server in the OCI deployment served `/.well-known/jwks.json`, `/api/auth/*`, `/api/users/@me`, `/api/users/@me/username`, `/api/join_verify`, `/api/cosmetics.json`, `/api/reserved_clan_tags`, `/api/custom_tribes`, `/api/game/:id`, `/api/archive_singleplayer_game`, `/api/news.json`, or `/api/streams.json`.
3. **Browser-Client Guest Session Gap & Redundant Logout Calls:**
   - Unauthenticated players opening `https://openfront-2.duckdns.org` received `401` on `/api/auth/refresh`, and `Auth.ts`'s `doRefreshJwt()` fired redundant `POST /api/auth/logout` requests on non-200 responses.
   - `getPlayToken()` fell back to unsigned client-generated UUIDs (`persistent_id`) on refresh failure, which production Workers rightly reject with HTTP `401` on `/api/create_game` and WebSocket close `1002` (`ClientJoinMessageSchema` / `Unauthorized`).
4. **Live Browser Discovery During QA:**
   - `Cosmetics.ts` fetches `${getApiBase()}/cosmetics.json` unauthenticated on initial page load; gating `/cosmetics.json` behind `x-api-key` caused an unnecessary browser console `401` error. `GET /cosmetics.json` was opened as a public read-only catalog endpoint while mutating/server-to-server endpoints remain behind `x-api-key`.

---

## 2. Selected Authentication Architecture & Alternatives Considered

### Selected Architecture: Self-Hosted `frontierx-auth` Daemon (`src/auth/`)

An independent, zero-external-database Node.js/TypeScript Express daemon (`npm run start:auth` / `src/auth/Server.ts`) running alongside the OpenFront Master/Workers on the Oracle Cloud ARM Ubuntu host, backed by built-in `node:sqlite` (`DatabaseSync` in WAL mode) and `jose` (`Ed25519` / `EdDSA`):

- **Why this fits OCI ARM Ubuntu best:**
  - **Zero new paid infrastructure (\$0/mo):** Runs directly as a `systemd` service (`127.0.0.1:8787`) on the existing OCI instance with zero Docker requirement and zero external DB SaaS dependencies.
  - **Contract-compatible:** Implements exact schemas validated by `TokenPayloadSchema`, `UserMeResponseSchema`, `PutUsernameResponseSchema`, `JwksSchema`, and `ClientEnv.jwtIssuer()`.
  - **Defense in depth:** Keeps private Ed25519 signing keys, `scrypt` password hashes, refresh-token families, recovery codes, bans, and server-to-server `x-api-key` verification isolated in `src/auth/`.
  - **Zero latency internal hops:** `ServerEnv.internalApiBase()` (`AUTH_INTERNAL_URL`) lets Workers call `http://127.0.0.1:8787` directly for JWKS, `/join_verify`, `/users/@me`, and game archival without Cloudflare hairpinning.
  - **Optional Nginx or Master Reverse Proxy:** `deploy/oci-nginx-frontierx-api.conf.example` routes `/api/auth/*`, `/api/.well-known/jwks.json`, `/api/users/*`, etc. cleanly to `:8787`, and `Master.ts` (`AUTH_SERVICE_URL`) also supports proxying them directly for single-port deployments.

### Alternatives Considered

| Option                                                    | Pros                                                                                                                          | Cons / Why Rejected                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream OpenFront API (`api.openfront.io`)**           | Zero custom auth code                                                                                                         | Unavailable/uncontrolled external service for FrontierX; fails independence requirement.                                                                                                                                                                    |
| **Managed Auth Provider (Auth0 / Clerk / Supabase Auth)** | Hosted UI & OAuth                                                                                                             | Vendor lock-in, monthly seat/MAU cost above free tiers, and still requires a custom adapter service to issue FrontierX's exact `Ed25519` JWT claims (`sub = base64url(uuid)`, `publicId`, `entitlements`, `username`) plus `/users/@me` and `/join_verify`. |
| **Containerized Postgres + Redis Auth Stack**             | Scales horizontally                                                                                                           | Overkill for a single OCI ARM Ubuntu VM; violates the non-containerized OCI target architecture and increases operational/RAM overhead.                                                                                                                     |
| **Self-hosted `frontierx-auth` (`node:sqlite` + `jose`)** | **Zero external cost, exact schema compatibility, native ARM/systemd fit, replay-safe refresh rotation, single-use recovery** | Single-node SQLite storage (appropriate for current OCI single-host deployment; can be swapped behind `AuthStore` if multi-region scaling is needed later).                                                                                                 |

---

## 3. Complete List of Required Endpoints

All endpoints are served under both `/` (direct `localhost:8787`) and `/api` (browser same-origin `/api/*` routing):

| Method & Path                                                        | Caller                         | Auth / Protection                                     | Purpose                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/jwks.json` & `/api/.well-known/jwks.json`          | Workers & Clients              | Public                                                | Serves `EdDSA` (`Ed25519`) public JWK(s) with `kid`                                                          |
| `GET /health` & `/api/health`                                        | systemd / Monitoring           | Public                                                | Service liveness check                                                                                       |
| `GET /auth/providers`                                                | Browser                        | Public                                                | Advertises enabled providers (`guest`, `frontierx`, `recovery`, optional OAuth) & `turnstileRequired`        |
| `POST /auth/guest`                                                   | Browser                        | Turnstile + IP rate limit                             | Provisions server-issued guest account (`uuid`/`publicId`), signed access JWT, and `HttpOnly` refresh cookie |
| `POST /auth/register`                                                | Browser                        | Turnstile + Password policy + CSRF/Bearer             | Creates FrontierX email+password account; upgrades active guest session preserving `uuid`/`publicId`         |
| `POST /auth/login`                                                   | Browser                        | Email/account rate limit + `scrypt` verify            | Authenticates email/password account, checks active bans, issues access JWT + refresh cookie                 |
| `POST /auth/refresh` & `POST /auth/revoke`                           | Browser                        | `HttpOnly` refresh cookie + CSRF Origin check         | Rotates refresh token cleanly; detects token reuse and revokes the entire session family                     |
| `POST /auth/logout`                                                  | Browser                        | `HttpOnly` refresh cookie + CSRF Origin check         | Revokes current session family & clears cookie                                                               |
| `POST /auth/recovery-code`                                           | Browser                        | Bearer JWT                                            | Generates single-use `FXREC-...` recovery code (stored as SHA-256 hash) for guest/account recovery           |
| `POST /auth/recover`                                                 | Browser                        | IP rate limit + single-use hash match                 | Consumes `FXREC-...` recovery code, revokes prior sessions, issues fresh JWT + refresh cookie                |
| `GET /users/@me`                                                     | Browser & Workers              | Bearer JWT (supports Worker pass-through)             | Returns `UserMeResponseSchema` payload (user, player `publicId`, username status, entitlements, bans)        |
| `DELETE /users/@me`                                                  | Browser                        | Bearer JWT                                            | Deletes user account and active sessions                                                                     |
| `PUT /users/@me/username`                                            | Browser                        | Bearer JWT                                            | Validates & updates username with discriminator and cooldown enforcement                                     |
| `POST /join_verify`                                                  | Workers                        | Timing-safe `x-api-key`                               | Verifies & optionally censors player `username` / `clanTag` on WebSocket join                                |
| `GET /cosmetics.json`                                                | Browser & Workers              | Public read-only                                      | Supplies `CosmeticsSchema`-valid cosmetics catalog                                                           |
| `GET /reserved_clan_tags`                                            | Workers (`PrivilegeRefresher`) | Timing-safe `x-api-key`                               | Returns reserved clan tag privileges                                                                         |
| `POST /custom_tribes`                                                | Workers (`PrivilegeRefresher`) | Timing-safe `x-api-key`                               | Returns custom tribe definitions                                                                             |
| `POST /game/:id` & `GET /game/:id`                                   | Workers (`Archive`) / Preview  | Timing-safe `x-api-key` (POST) / Public summary (GET) | Persists and retrieves archived multiplayer game records                                                     |
| `POST /archive_singleplayer_game`                                    | Browser                        | Bearer JWT                                            | Archives singleplayer completion record                                                                      |
| `POST /matchmaking/checkin`                                          | Workers                        | Timing-safe `x-api-key`                               | Matchmaking worker heartbeat                                                                                 |
| `GET /news.json` & `GET /streams.json`                               | Browser                        | Public                                                | Serves static fallback `resources/news.json` & `resources/streams.json`                                      |
| `POST /api/create_game`, `POST /api/adminbot/create_game`, `/w<n>/*` | Browser / AdminBot             | JWT Bearer / AdminBot Key (on OpenFront Workers)      | Unchanged Worker endpoints for lobby creation and game WebSocket traffic                                     |

---

## 4. Files Changed & Added (Mission 22.5)

### New Authentication Backend & Deployment Files

- `src/auth/KeyManager.ts` — Ed25519 key generation/loading (`AUTH_PRIVATE_KEY_PEM`, `AUTH_PRIVATE_KEY_FILE`, `0600` JWK persistence), `/.well-known/jwks.json`, JWT signing/verification.
- `src/auth/AuthStore.ts` — `node:sqlite` WAL store (`users`, `sessions`, `recovery_codes`, `games`), `scrypt` password hashing (`timingSafeEqual`), guest provisioning & guest-to-account upgrade, refresh token family rotation & reuse detection, single-use recovery codes, ban enforcement, username cooldowns.
- `src/auth/TurnstileVerifier.ts` — Cloudflare Turnstile `siteverify` client (fail-closed outside explicit dev bypass or injected test verifier).
- `src/auth/RateLimiter.ts` — Sliding-window per-IP/account limiters, timing-safe `x-api-key` middleware, CSRF `Origin`/`Sec-Fetch-Site` check.
- `src/auth/AuthApp.ts` — Complete Express application mounting all auth/user/game-API endpoints at `/` and `/api`.
- `src/auth/Server.ts` — Standalone `frontierx-auth` daemon with periodic expired-session pruning and graceful shutdown (`npm run start:auth`).
- `deploy/frontierx-auth.service.example` — Systemd unit template for OCI ARM Ubuntu.
- `deploy/oci-nginx-frontierx-api.conf.example` — Nginx location routing snippet for `/api/auth/*`, `/api/.well-known/jwks.json`, `/api/users/*`, etc.
- `docs/AuthDeployment.md` — Deployment, env vars, key rotation, and rollback runbook.

### Modified Server, Client & Config Files

- `package.json` — Added `"start:auth": "tsx src/auth/Server.ts"`.
- `.gitignore` — Added `data/frontierx-auth/` so local SQLite/JWK files cannot be committed accidentally.
- `example.env` — Documented `AUTH_*`, `JWT_*`, and `TURNSTILE_SECRET_KEY` placeholders.
- `src/server/ServerEnv.ts` — Added `internalApiBase()` (`AUTH_INTERNAL_URL || jwtIssuer()`) and `jwkPublicKey(forceRefresh)` with 5-second cooldown.
- `src/server/jwt.ts` — Automatic JWKS refresh retry on unknown `kid`/verification error during key rollover; uses `internalApiBase()` for `/users/@me`.
- `src/server/JoinVerify.ts`, `src/server/Archive.ts`, `src/server/CustomTribes.ts`, `src/server/GamePreviewRoute.ts` — Switched internal server-to-server fetches to `ServerEnv.internalApiBase()`.
- `src/server/Worker.ts` — Enforced `claims.bans` check on `/api/create_game`, added `result.response.ban` check on WebSocket join (`1002 "Account Banned"`), and switched `PrivilegeRefresher`/checkin to `internalApiBase()`.
- `src/server/Master.ts` — Added optional `AUTH_SERVICE_URL` reverse proxy forwarding `/api/.well-known/jwks.json`, `/api/auth/*`, `/api/users/*`, `/api/join_verify`, `/api/cosmetics.json`, `/api/reserved_clan_tags`, `/api/custom_tribes`, `/api/game/*`, `/api/archive_singleplayer_game`, `/api/news.json`, and `/api/streams.json` (preserving `404` when unset and leaving `/api/create_game` & `/api/health` on Master/Workers).
- `src/client/Auth.ts` — Added single-flight `ensureGuestSession()`, `forceRefreshSession()`, `applyAccessToken()`, `registerAccount()`, `loginAccount()`, `createRecoveryCode()`, `recoverSession()`, `fetchAuthProviders()`; removed redundant `/auth/logout` call when refresh fails; enforced server-signed tokens in `getPlayToken()` outside `GameEnv.Dev` (no unsigned UUID fallback in `prod`/`staging`).
- `src/client/FrontierAuth.ts` — Client facade module delegating to `Auth.ts`.
- `src/client/Transport.ts` — Added single transparent `forceRefreshSession()` + reconnect retry when WebSocket closes with `1002 Unauthorized*` before surfacing the connection-refused modal.
- `src/client/HostLobbyModal.ts` — Added red error toast notification if `createLobby()` fails.
- `src/client/AccountModal.ts` — Added FrontierX Account sign-in/register-upgrade panel and Guest / Session Recovery code generator & redeemer UI while keeping v1.0.7 branding and existing tabs intact.

### Added Automated Tests & QA Harnesses

- `tests/server/AuthService.test.ts`
- `tests/client/AuthGuestSession.test.ts`
- `tests/server/MultiplayerEndToEndIntegration.test.ts`
- `tests/perf/Mission225ProdMultiplayerQa.cjs`

---

## 5. Security Model

- **Asymmetric Token Verification:** Access tokens (`15m` default TTL) are signed with `Ed25519` (`EdDSA`), include `iss`, `aud`, `exp`, `iat`, `jti`, and base64url `sub` (mapping deterministically to `uuid`), and are strictly verified against JWKS by Workers (`src/server/jwt.ts`).
- **No Unsigned Production Identity:** Outside `GameEnv.Dev`, `getPlayToken()` refuses local unsigned UUIDs and Workers reject non-JWT tokens in `GAME_ENV=prod`.
- **HttpOnly Refresh Rotation & Reuse Detection:** Refresh tokens (`30d` default TTL) are stored hashed (`SHA-256`) in SQLite WAL per session family, set in `HttpOnly; SameSite=Lax; Path=/` cookies (`Secure` when HTTPS), rotated on every refresh, and any replay of an already-rotated token immediately revokes the entire session family.
- **Password & Recovery Protection:** Account passwords use per-user salted `crypto.scryptSync` verified with `crypto.timingSafeEqual`; recovery codes (`FXREC-...`) are single-use and SHA-256 hashed at rest.
- **Anti-Abuse & CSRF:** Turnstile verification fails closed unless explicitly configured or running under local dev bypass; cookie-authenticated POST routes enforce `Origin` / `Sec-Fetch-Site` checks; per-IP and per-account sliding-window limiters guard guest/account/recovery endpoints; server-to-server endpoints require `x-api-key` (`timingSafeEqual`).
- **Ban Enforcement & Privilege Preservation:** Active bans reject login, refresh, `/api/create_game` (`403`), and WebSocket joins (`1002 Account Banned`).

---

## 6. Infrastructure Requirements & Running Cost Estimates

### Target Host: Existing Oracle Cloud Infrastructure (OCI) ARM Ubuntu Server

- **Runtime:** Node.js >= 22 (with built-in `node:sqlite`, already present in runtime used by OpenFront).
- **Processes:**
  - `frontierx-auth` (`npm run start:auth` on `127.0.0.1:8787`, systemd service, `<100 MB` RAM).
  - Existing OpenFront Master (`127.0.0.1:3000`) + Workers (`3001+N`).
  - Existing Nginx TLS reverse proxy routing `/api/auth/*`, `/api/.well-known/jwks.json`, `/api/users/*`, etc. to `127.0.0.1:8787` and `/api/create_game`, `/w<n>/*` to Workers.
- **Persistent Disk Directory:** `/var/lib/frontierx-auth` (`0700` dir) storing `auth.sqlite` (WAL) and `ed25519-jwk.json` (`0600`).

### Running Cost Estimate

- **Additional Monthly SaaS / DB / Auth Spend:** **\$0.00 / month** — runs co-located on the existing OCI ARM Ubuntu VM using embedded `node:sqlite` + existing Cloudflare Turnstile (Free tier: 10,000+ verifications/month / standard free plan) + existing DuckDNS TLS setup.
- _(Resource footnote: exact OCI instance billing depends on whether the existing VM runs within OCI Always Free A1 Flex limits; Mission 22.5 adds zero new paid services or external cloud resources.)_

---

## 7. Automated Test Results

All checks below were executed cleanly **after the final code edit**:

1. **Formatting (`npx prettier --check .`):** Passed (`All matched files use Prettier code style!`).
2. **Linters (`npm run lint` -> `oxlint` + `eslint`):** Passed (`Found 0 warnings and 0 errors` across `883` files in `oxlint`; `eslint` exited `0`).
3. **TypeScript & Production Bundle (`npm run build-prod`):**
   - `tsc --noEmit` exited `0`.
   - `vite build` exited `0` (`static/index.html`, `1208 modules transformed` in `1.16s`).
4. **Full Unit & Integration Suites (`npm test`):**
   - `vitest run`: **291 / 291 test files passed, 3206 / 3206 tests passed**.
   - `vitest run tests/server`: **40 / 40 test files passed, 341 / 341 tests passed**.
   - Key Mission 22.5 suites verified inside these runs:
     - `tests/server/AuthService.test.ts` (5/5): Ed25519 JWKS verification, guest provisioning, refresh rotation, replay-reuse family revocation, guest-to-account upgrade preserving `publicId`/`sub`, login/logout/username/delete, single-use recovery codes, bans, CSRF Origin, forged JWTs, and API key enforcement.
     - `tests/client/AuthGuestSession.test.ts` (4/4): 401 refresh without spurious logout POSTs, single-flight `/auth/guest` deduplication, refusal of unsigned UUIDs in `GAME_ENV=prod` vs dev allowance, register/login/recover session installation.
     - `tests/server/MultiplayerEndToEndIntegration.test.ts` (3/3): Real `frontierx-auth` + Master + Worker multi-process lobby creation, two-client WebSocket join, public listing gating, duplicate connection handling, JWT-rotated reconnection, unauthorized WS rejection (`1002`), wrong-audience JWT rejection, banned user rejection, and server-side `/join_verify` rate-limiting/protection.
     - `tests/client/ProjectIroncladRegressions.test.ts` (18/18), `tests/server/ProdAuthSecurity.test.ts` (3/3), `tests/SupplyDropExecution.test.ts`, `tests/SupplyDropMultiplayerParity.test.ts`.

---

## 8. Two-Browser Production-Equivalent E2E QA Results

Executed locally on the **home desktop** (the Dell laptop was never accessed or benchmarked) via `node tests/perf/Mission225ProdMultiplayerQa.cjs` (exit `0`, `failures: []`) and `node tests/perf/ProdMultiplayerMetadataQa.cjs` (exit `0`, `failures: []`):

- **Production Topology Reproduced:** Live `frontierx-auth` daemon on `:8787` + Master & 2 Workers in `GAME_ENV=prod` (`JWT_AUDIENCE=localhost`) behind a single HTTP/WS gateway proxy + two independent headless Chrome D3D11 WebGL2 instances (`Browser A` and `Browser B`).
- **Observed Results (`Mission225ProdMultiplayerQa.cjs` final run after latest build):**
  - `account_modal_and_branding_v107`: `ok: true` (`accountPanelOk: true`, `gameEnv: "prod"`, `hasV107: true`, `hasV105: false`).
  - **Lobby Create & Join:** Browser A auto-provisioned a server-signed guest session and created lobby `JCUUsPUR`; Browser B auto-provisioned an independent signed guest session and joined via invite URL.
  - **Synchronized Simulation & Territory/Unit Parity:** Both browsers entered match and ticked cleanly (`startTicks: { a: 10, b: 14 }`), exited spawn phase, Browser A constructed a `Tank Factory` (`factoriesA: 1`, `factoriesB: 1`), and produced a deterministic `Tank` visible identically by matching unit ID on both clients (`browserA: 1`, `browserB: 1`).
  - **Supply Drop & WebGL Rendering:** `supplyDropFrequency: "extreme"` synced cleanly on both clients (`glFrames: 58546` on Browser A; deterministic single-claim behavior verified by `SupplyDropExecution.test.ts` & `SupplyDropMultiplayerParity.test.ts`).
  - **Mid-Match Network Loss & Reconnect Recovery:** Forced WebSocket drop (`wsDropped: true` at tick `508`) triggered transparent client reconnect & catch-up without restarting the match (`tickA: 526`, `tickB: 526`).
  - **Clean Exit & Singleplayer Check:** Both browsers navigated cleanly back to the main menu and Singleplayer launched and ticked cleanly (`spTicking: true`), with **0 console/page errors** (`errorsA: []`, `errorsB: []`).
- **Regression QA (`ProdMultiplayerMetadataQa.cjs`):** 5/5 checks passed (`prod_health_and_commit_metadata`, `prod_create_game_auth_enforcement_and_routing`, `prod_ws_rejects_unsigned_persistent_id`, `ui_version_and_bootstrap_metadata`, `prod_two_browser_mp_webgl_mutators_and_reconnect`) with `hostErrors: []`, `joinerErrors: []`.

---

## 9. Deployment & Rollback Procedures (Requires Explicit Operator Approval)

**Note:** Live OCI deployment was **not** executed automatically per Mission 22.5 safety rules.

### Deployment Steps (Upon Approval)

1. Ensure PR #18 (`fix/frontierx-mission22-4-prod-mp-metadata`) and the Mission 22.5 PR are reviewed and merged into `main`.
2. On the OCI ARM Ubuntu server, pull `main`, install dependencies (`npm ci`), and build (`npm run build-prod`).
3. Create `/var/lib/frontierx-auth` (`chmod 700`) and `/etc/frontierx/auth.env` (`chmod 600`) with production values matching `docs/AuthDeployment.md`:
   - `GAME_ENV=prod`, `DOMAIN=openfront-2.duckdns.org`, `JWT_AUDIENCE=openfront-2.duckdns.org`, `JWT_ISSUER=https://openfront-2.duckdns.org/api`
   - Real `API_KEY` (shared between `frontierx-auth` and OpenFront workers), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
4. Install `deploy/frontierx-auth.service.example` as `/etc/systemd/system/frontierx-auth.service`, enable and start it (`systemctl enable --now frontierx-auth`). Verify `curl http://127.0.0.1:8787/.well-known/jwks.json`.
5. Configure Master/Workers with `AUTH_INTERNAL_URL=http://127.0.0.1:8787`, apply `deploy/oci-nginx-frontierx-api.conf.example` inside the Nginx `server {}` block, run `nginx -t && systemctl reload nginx`, and restart the OpenFront cluster.
6. Verify live multiplayer on `https://openfront-2.duckdns.org` with two real browsers.

### Rollback Procedure

1. Remove the `frontierx-auth` location blocks from Nginx (`nginx -t && systemctl reload nginx`).
2. `systemctl stop frontierx-auth` and revert Master/Workers to previous commit/env.
3. `/var/lib/frontierx-auth/auth.sqlite` and `ed25519-jwk.json` remain preserved cleanly on disk.

---

## 10. Remaining Limitations & Required Operator Approvals / Credentials

- **Live OCI Cutover Pending:** Public multiplayer at `https://openfront-2.duckdns.org` will **not** function end-to-end until approved and deployed on OCI (live Turnstile secret key, shared `API_KEY`, systemd unit, and Nginx auth routing update). We do not claim live production multiplayer is active until verified post-cutover on OCI.
- **Single-Host SQLite Storage:** `AuthStore` uses local SQLite WAL, ideal for the single OCI ARM VM; horizontal multi-region scaling in the future would require moving `AuthStore` to a shared PostgreSQL store.
- **No Email Delivery Provider Configured:** Account recovery uses built-in cryptographic single-use `FXREC-...` recovery codes rather than SMTP/email magic links, avoiding external email provider costs/secrets.
- **Discord / Google OAuth:** Supported only if `DISCORD_CLIENT_ID` / `GOOGLE_CLIENT_ID` + secrets are later provisioned; currently `guest`, FrontierX email/password accounts, and recovery codes are enabled by default.
- **Open Prerequisite PR #18:** PR #18 (`fix/frontierx-mission22-4-prod-mp-metadata`) remains `OPEN`; either merge PR #18 first or review commit history before merging this Mission 22.5 PR.

---

## 11. Pull Request URL

Pending GitHub PR creation (updated immediately after `gh pr create`).
