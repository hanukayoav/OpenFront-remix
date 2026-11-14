# FrontierX Self-Hosted Authentication & API Deployment Guide

Mission 22.5 / 22.7 introduces `frontierx-auth` (`src/auth/Server.ts`), an independent, zero-external-database Node.js (`node:sqlite` + `jose` Ed25519) authentication and game-API daemon designed for the Oracle Cloud ARM64 Ubuntu host (`/home/ubuntu/openfront`).

## Architecture & Security Controls

- **Key Management (`src/auth/KeyManager.ts`)**: Signs access JWTs (`EdDSA` / `Ed25519`) and exposes `/.well-known/jwks.json` + `/api/.well-known/jwks.json`. Supports controlled multi-key rotation (`previousPublicJwks` in `ed25519-jwk.json` via `KeyManager.rotateKeyFile()`) so workers/clients verify both current and previously issued valid tokens across rotation windows. Key directory is enforced `0700` and key files `0600`.
- **Identity & Session Store (`src/auth/AuthStore.ts`)**: Stores accounts, async salted `scrypt` password hashes (`scrypt$N$r$p$salt$hash`), single-use recovery code hashes (at most 1 active code per user; redemption revokes all prior refresh sessions), refresh token families (with atomic replay-reuse family revocation), bans, username cooldowns, and archived game records in SQLite WAL mode (`${AUTH_DATA_DIR}/auth.sqlite`, directory `0700`, files `0600`).
- **Anti-Abuse (`src/auth/TurnstileVerifier.ts`, `src/auth/RateLimiter.ts`)**:
  - Production (`GAME_ENV=prod`) strictly forbids `AUTH_ALLOW_TURNSTILE_DEV_BYPASS=true` (process exits with configuration error).
  - Turnstile verification is enforced on `/auth/guest` (new guest provisioning), `/auth/register`, and `/join_verify`.
  - Trusted-proxy IP detection defaults to `trust proxy = loopback` (`AUTH_TRUST_PROXY=loopback`); spoofable `X-Forwarded-For` leftmost headers and `CF-Connecting-IP` are ignored unless explicitly verified (`deploy/oci-nginx-frontierx-api.conf.example` clears `CF-Connecting-IP` at Nginx).
  - Cookie CSRF protection validates `Origin`/`Referer` against strict HTTPS origins in production (`https://<DOMAIN>`), rejects `Sec-Fetch-Site: cross-site`, requires an explicitly allowlisted `Origin`/`Referer` for `same-site` requests, and rejects cookie-bearing mutations lacking valid origin proof.
  - Banned accounts cannot self-delete via `DELETE /users/@me` (`403 account_banned`), preserving ban and email enforcement records, and `Worker.ts` checks live ban/deletion status via `/users/@me` on both `POST /api/create_game` and WebSocket `join`.
  - Archive endpoints (`/game/:id`, `/archive_singleplayer_game`) enforce API key / Bearer auth, CSRF, ban rejection, per-IP and per-user rate limits, strict game ID validation, ownership checks, 512 KiB size bounds, and scheduled retention pruning.
- **Single-Player Resiliency**: Local single-player and local replay games (`Transport.ts` `isLocal === true`) use `getLocalPlayToken()` and never require the remote auth service, so auth maintenance or outages never break single-player gameplay.

## Host Prerequisites (Oracle Cloud ARM64 Ubuntu)

1. **Node.js Version (`>= 22.13.0`, Node 24 LTS recommended)**:
   - `AuthStore.ts` uses unflagged built-in `node:sqlite` (`DatabaseSync`), which is unflagged starting in Node.js `22.13.0` (Node 24 LTS used in CI).
   - Verify on OCI before enabling `frontierx-auth.service`:
     ```bash
     which node npm
     node -v
     node -e 'import("node:sqlite").then(() => console.log("sqlite ok"))'
     ```
   - Update `deploy/frontierx-auth.service` `Environment=PATH=...` / `ExecStart=...` if Node is installed under `/home/ubuntu/.nvm` rather than `/usr/bin`.
2. **Permissions & Persistent Directories**:
   ```bash
   sudo mkdir -p /var/lib/frontierx-auth /var/backups/frontierx-auth /etc/frontierx
   sudo chown -R ubuntu:ubuntu /var/lib/frontierx-auth /var/backups/frontierx-auth
   sudo chmod 0700 /var/lib/frontierx-auth /var/backups/frontierx-auth
   sudo chmod 0750 /etc/frontierx
   ```

## Required Environment Variables (`/etc/frontierx/auth.env`, mode `0600`)

```dotenv
NODE_ENV=production
GAME_ENV=prod
DOMAIN=openfront-2.duckdns.org
JWT_AUDIENCE=openfront-2.duckdns.org
JWT_ISSUER=https://openfront-2.duckdns.org/api
AUTH_HOST=127.0.0.1
AUTH_PORT=8787
AUTH_DATA_DIR=/var/lib/frontierx-auth
AUTH_PRIVATE_KEY_FILE=/var/lib/frontierx-auth/ed25519-jwk.json
AUTH_TRUST_PROXY=loopback
AUTH_ALLOWED_ORIGINS=https://openfront-2.duckdns.org
AUTH_GUEST_PUBLIC_LOBBIES=false
AUTH_ACCOUNT_PUBLIC_LOBBIES=true
# Generate API_KEY with: openssl rand -hex 32
API_KEY=<32+ byte random secret shared with OpenFront workers>
TURNSTILE_SITE_KEY=<Cloudflare Turnstile site key>
TURNSTILE_SECRET_KEY=<Cloudflare Turnstile secret key>
```

Set `/etc/frontierx/auth.env` permissions:

```bash
sudo chown root:ubuntu /etc/frontierx/auth.env
sudo chmod 0640 /etc/frontierx/auth.env
```

And on the OpenFront Master / Worker PM2 environment:

```dotenv
API_KEY=<same secret as auth.env>
JWT_AUDIENCE=openfront-2.duckdns.org
JWT_ISSUER=https://openfront-2.duckdns.org/api
AUTH_INTERNAL_URL=http://127.0.0.1:8787
AUTH_SERVICE_URL=http://127.0.0.1:8787
TURNSTILE_SITE_KEY=<same Cloudflare Turnstile site key>
```

## Readiness Checks

- `/health` verifies SQLite connectivity and non-empty Ed25519 JWKS (`200` / `503`).
- `/ready` additionally verifies in `GAME_ENV=prod` that `API_KEY` and `TURNSTILE_SECRET_KEY` are configured (`503` with JSON `reasons` if missing).
- Probe locally on OCI: `curl -fsS http://127.0.0.1:8787/ready`.

## Online SQLite Backups & Restoration Testing

Never copy `auth.sqlite` with `cp` while `frontierx-auth` is running under WAL mode without using SQLite's online backup API. Use `sqlite3 .backup` (or Node `backup`):

```bash
# Daily cron / timer backup (safe while daemon serves live traffic)
STAMP=$(date +%Y%m%d_%H%M%S)
sqlite3 /var/lib/frontierx-auth/auth.sqlite ".backup '/var/backups/frontierx-auth/auth_${STAMP}.sqlite'"
chmod 0600 "/var/backups/frontierx-auth/auth_${STAMP}.sqlite"
sqlite3 "/var/backups/frontierx-auth/auth_${STAMP}.sqlite" "PRAGMA integrity_check;"
```

### Restore Drill (Non-Destructive Verification)

```bash
LATEST=$(ls -1t /var/backups/frontierx-auth/auth_*.sqlite | head -n1)
sqlite3 "$LATEST" "PRAGMA integrity_check; SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS active_sessions FROM sessions WHERE revoked_at IS NULL;"
```

### Full Restore Procedure

```bash
sudo systemctl stop frontierx-auth.service
cp -a /var/lib/frontierx-auth/auth.sqlite "/var/backups/frontierx-auth/auth_pre_restore_$(date +%Y%m%d_%H%M%S).sqlite"
rm -f /var/lib/frontierx-auth/auth.sqlite-wal /var/lib/frontierx-auth/auth.sqlite-shm
cp -a "$LATEST" /var/lib/frontierx-auth/auth.sqlite
chown ubuntu:ubuntu /var/lib/frontierx-auth/auth.sqlite
chmod 0600 /var/lib/frontierx-auth/auth.sqlite
sudo systemctl start frontierx-auth.service
curl -fsS http://127.0.0.1:8787/ready
```

## Safe Key Rotation & Outage-Free Deployment Sequence

1. **Key Rotation (Zero-Downtime)**: Use `KeyManager.rotateKeyFile("/var/lib/frontierx-auth/ed25519-jwk.json")` to generate a new active Ed25519 key while retaining previous public JWKs (default max 2 previous keys) in `previousPublicJwks`. Restart `frontierx-auth.service`; `/.well-known/jwks.json` publishes `[newPublicJwk, oldPublicJwk]`. After the access JWT TTL (15 minutes) elapses, you may prune old public JWKs if desired.
2. **Pre-Merge OCI Prep**: Verify Node `>= 22.13.0` on OCI, create `/etc/frontierx/auth.env` (`0640`), provision `/var/lib/frontierx-auth` (`0700`), and install `/etc/systemd/system/frontierx-auth.service` (`WorkingDirectory=/home/ubuntu/openfront`) — leave it stopped or ready until merge if old code is running, OR merge PR #18 then PR #19:
   - Because `.github/workflows/deploy-oci.yml` only restarts `frontierx-auth.service` when already enabled AND single-player no longer depends on remote auth, merging PR #19 before enabling `frontierx-auth.service` will NOT break existing single-player gameplay.
   - However, **public/private multiplayer requires** `frontierx-auth.service` running (`http://127.0.0.1:8787/ready` -> `200`) and Nginx routing (`/etc/nginx/...` including `deploy/oci-nginx-frontierx-api.conf.example`) or `AUTH_SERVICE_URL` active before enabling external multiplayer announcements.
3. **Activation Order**:
   1. Start and verify `sudo systemctl enable --now frontierx-auth.service` and `curl -fsS http://127.0.0.1:8787/ready`.
   2. Add the Nginx location blocks (`nginx -t && sudo systemctl reload nginx`).
   3. Ensure `AUTH_INTERNAL_URL`, `AUTH_SERVICE_URL`, `API_KEY`, `TURNSTILE_SITE_KEY` are in the PM2 ecosystem/env and `pm2 restart openfront-server --update-env`.
   4. Verify `curl -fsS https://openfront-2.duckdns.org/api/.well-known/jwks.json` and run a two-client browser smoke test.
4. **Rollback**:
   - Stop `sudo systemctl stop frontierx-auth.service`, remove the Nginx auth location include (`nginx -t && sudo systemctl reload nginx`), unset `AUTH_SERVICE_URL` / `AUTH_INTERNAL_URL`, and restart PM2 (`pm2 restart openfront-server --update-env`) or revert `main` / restore from `/home/ubuntu/backups/openfront_pre_deploy_*.tar.gz`. SQLite data in `/var/lib/frontierx-auth/auth.sqlite` remains preserved on disk.
