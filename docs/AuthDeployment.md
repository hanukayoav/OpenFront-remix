# FrontierX Self-Hosted Authentication & API Deployment Guide

Mission 22.5 introduces `frontierx-auth` (`src/auth/Server.ts`), an independent, zero-external-database Node.js (`node:sqlite` + `jose` Ed25519) authentication and game-API daemon designed specifically for the Oracle Cloud ARM Ubuntu host.

## Architecture Overview

- **Key Management (`src/auth/KeyManager.ts`)**: Signs access JWTs (`EdDSA` / `Ed25519`) and exposes `/.well-known/jwks.json` + `/api/.well-known/jwks.json`. Persists an `0600` JWK file (`AUTH_PRIVATE_KEY_FILE` or `${AUTH_DATA_DIR}/ed25519-jwk.json`) unless injected via `AUTH_PRIVATE_KEY_PEM`.
- **Identity & Session Store (`src/auth/AuthStore.ts`)**: Stores accounts, salted `scrypt` password hashes, single-use recovery code hashes, refresh token families (with replay-reuse family revocation), bans, username cooldowns, and archived game records in SQLite WAL mode (`${AUTH_DATA_DIR}/auth.sqlite`).
- **Anti-Abuse (`src/auth/TurnstileVerifier.ts`, `src/auth/RateLimiter.ts`)**: Fails closed when Turnstile is unconfigured in non-dev environments, enforces per-IP/account sliding-window rate limits, timing-safe `x-api-key` verification for server-to-server endpoints (`/join_verify`, `/reserved_clan_tags`, `/custom_tribes`, `/game/:id`, `/archive_singleplayer_game`, `/matchmaking/checkin`), and CSRF Origin/`Sec-Fetch-Site` enforcement on cookie-authenticated endpoints.
- **Game Cluster Integration**:
  - `ServerEnv.internalApiBase()` lets Master and Workers reach `frontierx-auth` locally on `http://127.0.0.1:8787` (`AUTH_INTERNAL_URL`) without hair-pinning through Cloudflare/Nginx.
  - `Master.ts` optionally proxies API/auth paths to `AUTH_SERVICE_URL`, or Nginx routes `/api/auth/*`, `/api/.well-known/jwks.json`, `/api/users/*`, etc. directly (`deploy/oci-nginx-frontierx-api.conf.example`).

## Required Environment Variables (`/etc/frontierx/auth.env`)

- `GAME_ENV=prod`
- `DOMAIN=openfront-2.duckdns.org`
- `JWT_AUDIENCE=openfront-2.duckdns.org`
- `JWT_ISSUER=https://openfront-2.duckdns.org/api`
- `AUTH_HOST=127.0.0.1`
- `AUTH_PORT=8787`
- `AUTH_DATA_DIR=/var/lib/frontierx-auth`
- `API_KEY=<32+ byte random secret matching OpenFront workers>`
- `TURNSTILE_SITE_KEY=<Cloudflare Turnstile site key>`
- `TURNSTILE_SECRET_KEY=<Cloudflare Turnstile secret key>`
- `AUTH_GUEST_PUBLIC_LOBBIES=false` (recommended default; set `true` only if guests may list public lobbies)
- `AUTH_ACCOUNT_PUBLIC_LOBBIES=true`

And on the OpenFront Master / Worker environment:

- `AUTH_INTERNAL_URL=http://127.0.0.1:8787`
- `AUTH_SERVICE_URL=http://127.0.0.1:8787` (if relying on Master proxy instead of or alongside Nginx location rules)

## Key Rotation & Rollback

1. **Key Rotation**: Set `AUTH_PRIVATE_KEY_FILE` (or rotate JSON via script leaving previous public JWK briefly in JWKS) — workers automatically refresh JWKS on unknown `kid` / verification failure (`src/server/jwt.ts`) with a 5-second cooldown.
2. **Rollback**: Stop `frontierx-auth.service`, remove the `/etc/nginx` auth snippet, unset `AUTH_SERVICE_URL` / `AUTH_INTERNAL_URL`, and reload Nginx. SQLite snapshots in `/var/lib/frontierx-auth/auth.sqlite` remain intact.
