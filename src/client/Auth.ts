import { decodeJwt } from "jose";
import { ClientEnv } from "src/client/ClientEnv";
import { UserSettings } from "src/core/game/UserSettings";
import { z } from "zod";
import {
  TokenPayload,
  TokenPayloadSchema,
  UserMeResponse,
} from "../core/ApiSchemas";
import { base64urlToUuid } from "../core/Base64";
import { GameEnv } from "../core/configuration/Config";
import { getApiBase, getAudience } from "./Api";
import { crazyGamesSDK } from "./CrazyGamesSDK";
import { steamSDK } from "./SteamSDK";
import { isTurnstileClientRequired, requestTurnstileToken } from "./Turnstile";
import { generateCryptoRandomUUID } from "./Utils";

export type UserAuth = { jwt: string; claims: TokenPayload } | false;

export interface AuthActionResult {
  ok: boolean;
  error?: string;
  user?: UserMeResponse;
  upgradedFromGuest?: boolean;
}

export interface RecoveryCodeResult {
  ok: boolean;
  recoveryCode?: string;
  expiresAt?: string;
  error?: string;
}

export interface AuthProvidersInfo {
  providers: {
    guest: boolean;
    frontierx: boolean;
    recovery: boolean;
    discord: boolean;
    google: boolean;
  };
  turnstileRequired: boolean;
}

const PERSISTENT_ID_KEY = "player_persistent_id";
const AUTH_REFRESH_LOCK_NAME = "frontierx_auth_refresh_lock";
const AUTH_BROADCAST_CHANNEL = "frontierx_auth_sync";

let __tabId: string | null = null;
function getTabId(): string {
  __tabId ??=
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return __tabId;
}

let __jwt: string | null = null;
let __refreshPromise: Promise<void> | null = null;
let __guestPromise: Promise<UserAuth> | null = null;
let __expiresAt: number = 0;
let __broadcastChannel: BroadcastChannel | null = null;

type AuthBroadcastMessage =
  | { type: "session_updated"; sender: string; jwt: string; expiresAt: number }
  | { type: "session_cleared"; sender: string };

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (!__broadcastChannel) {
    try {
      __broadcastChannel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
      __broadcastChannel.onmessage = (
        event: MessageEvent<AuthBroadcastMessage>,
      ) => {
        const msg = event.data;
        if (!msg || msg.sender === getTabId()) {
          return;
        }
        if (
          msg.type === "session_updated" &&
          typeof msg.jwt === "string" &&
          typeof msg.expiresAt === "number"
        ) {
          __jwt = msg.jwt;
          __expiresAt = msg.expiresAt;
        } else if (msg.type === "session_cleared") {
          __jwt = null;
          __expiresAt = 0;
        }
      };
    } catch {
      return null;
    }
  }
  return __broadcastChannel;
}

function broadcastSessionUpdate(jwt: string, expiresAt: number): void {
  getBroadcastChannel()?.postMessage({
    type: "session_updated",
    sender: getTabId(),
    jwt,
    expiresAt,
  } satisfies AuthBroadcastMessage);
}

function broadcastSessionCleared(): void {
  getBroadcastChannel()?.postMessage({
    type: "session_cleared",
    sender: getTabId(),
  } satisfies AuthBroadcastMessage);
}

export function discordLogin() {
  const redirectUri = encodeURIComponent(window.location.href);
  window.location.href = `${getApiBase()}/auth/login/discord?redirect_uri=${redirectUri}`;
}

export function googleLogin() {
  const redirectUri = encodeURIComponent(window.location.href);
  window.location.href = `${getApiBase()}/auth/login/google?redirect_uri=${redirectUri}`;
}

// Link a Google account to the currently logged-in player. Unlike login this is
// an authenticated request, so we fetch the Google authorize URL with the
// Bearer token (a top-level navigation can't carry it) and then navigate to it.
// Returns false if the user isn't logged in or the request fails.
export async function linkGoogle(): Promise<boolean> {
  const authHeader = await getAuthHeader();
  if (authHeader === "") return false;
  const redirectUri = encodeURIComponent(window.location.href);
  try {
    const response = await fetch(
      `${getApiBase()}/auth/link/google?redirect_uri=${redirectUri}`,
      {
        headers: { Authorization: authHeader },
        credentials: "include",
      },
    );
    if (!response.ok) {
      console.error("Failed to start Google link", response);
      return false;
    }
    const { url } = await response.json();
    if (typeof url !== "string") return false;
    window.location.href = url;
    return true;
  } catch (e) {
    console.error("Failed to start Google link", e);
    return false;
  }
}

export async function tempTokenLogin(token: string): Promise<string | null> {
  const response = await fetch(
    `${getApiBase()}/auth/login/token?login-token=${token}`,
    {
      credentials: "include",
    },
  );
  if (response.status !== 200) {
    console.error("Token login failed", response);
    return null;
  }
  const json = await response.json();
  const { email } = json;
  return email;
}

export async function getAuthHeader(): Promise<string> {
  const userAuthResult = await userAuth();
  if (!userAuthResult) return "";
  const { jwt } = userAuthResult;
  return `Bearer ${jwt}`;
}

export async function logOut(allSessions: boolean = false): Promise<boolean> {
  try {
    const response = await fetch(
      getApiBase() + (allSessions ? "/auth/revoke" : "/auth/logout"),
      {
        method: "POST",
        credentials: "include",
      },
    );

    if (response.ok === false) {
      console.error("Logout failed", response);
      return false;
    }

    return true;
  } catch (e) {
    console.error("Logout failed", e);
    return false;
  } finally {
    clearLocalSession();
  }
}

// Drop all client-side auth state without calling the API. Used after account
// deletion (DELETE /users/@me), where the server has already revoked every
// session and cleared the refresh cookie, so /auth/logout must not be called.
export function clearLocalSession(): void {
  __jwt = null;
  __expiresAt = 0;
  broadcastSessionCleared();
  localStorage.removeItem(PERSISTENT_ID_KEY);
  // Switch cosmetics back to the logged-out scope. The player's own
  // selections stay stored under their publicId and are restored on the
  // next login (#4955).
  UserSettings.setPlayerId(null);
}

export async function isLoggedIn(): Promise<boolean> {
  const userAuthResult = await userAuth();
  return userAuthResult !== false;
}

// True when the in-memory session still belongs to the given JWT subject.
// Lets callers of authenticated endpoints discard a response that arrived
// after a logout or session change invalidated the request's session.
export function isSessionActive(sub: string): boolean {
  if (__jwt === null) return false;
  try {
    return decodeJwt(__jwt).sub === sub;
  } catch {
    return false;
  }
}

export async function userAuth(
  shouldRefresh: boolean = true,
): Promise<UserAuth> {
  try {
    const jwt = __jwt;
    if (!jwt) {
      if (!shouldRefresh) {
        console.warn("No JWT found and shouldRefresh is false");
        return false;
      }
      console.log("No JWT found");
      await refreshJwt();
      return userAuth(false);
    }

    // Verify the JWT (requires browser support)
    // const jwks = createRemoteJWKSet(
    //   new URL(getApiBase() + "/.well-known/jwks.json"),
    // );
    // const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    //   issuer: getApiBase(),
    //   audience: getAudience(),
    // });

    const payload = decodeJwt(jwt);
    const { iss, aud } = payload;

    if (iss !== getApiBase()) {
      // JWT was not issued by the correct server
      console.error('unexpected "iss" claim value');
      logOut();
      return false;
    }
    const myAud = getAudience();
    if (myAud !== "localhost" && aud !== myAud) {
      // JWT was not issued for this website
      console.error('unexpected "aud" claim value');
      logOut();
      return false;
    }
    if (Date.now() >= __expiresAt - 3 * 60 * 1000) {
      console.log("jwt expired or about to expire");
      if (!shouldRefresh) {
        console.error("jwt expired and shouldRefresh is false");
        return false;
      }
      await refreshJwt();

      // Try to get login info again after refreshing
      return userAuth(false);
    }

    const result = TokenPayloadSchema.safeParse(payload);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Invalid payload", error);
      return false;
    }

    const claims = result.data;
    return { jwt, claims };
  } catch (e) {
    console.error("isLoggedIn failed", e);
    return false;
  }
}

async function refreshJwt(): Promise<void> {
  if (__refreshPromise) {
    return __refreshPromise;
  }
  getBroadcastChannel();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const run =
    locks && typeof locks.request === "function"
      ? locks.request(AUTH_REFRESH_LOCK_NAME, async () => {
          // Another tab may have rotated the refresh cookie and broadcasted a
          // fresh access token while we waited on the cross-tab lock.
          if (__jwt !== null && Date.now() < __expiresAt - 3 * 60 * 1000) {
            return;
          }
          await doRefreshJwt();
        })
      : doRefreshJwt();
  __refreshPromise = run;
  try {
    await run;
  } finally {
    __refreshPromise = null;
  }
}

async function doRefreshJwt(): Promise<void> {
  if (steamSDK.isOnSteam()) {
    const ticket = await steamSDK.getTicket();
    if (ticket) {
      // On Steam, we exchange a Steam Web-API ticket for our session. No
      // ticket (Steam unavailable) falls through to the guest flow below.
      return doSteamLogin(ticket);
    }
  }
  if (crazyGamesSDK.isOnCrazyGames()) {
    const token = await crazyGamesSDK.getUserToken();
    if (token) {
      // Signed-in CrazyGames account: exchange their token for our session.
      // No CrazyGames account / not signed in falls through to the guest flow
      // below.
      return doCrazyGamesLogin(token);
    }
  }
  try {
    console.log("Refreshing jwt");
    const response = await fetch(getApiBase() + "/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (response.status !== 200) {
      console.warn("Refresh failed", response.status);
      clearLocalSession();
      return;
    }
    const json = await response.json();
    const { jwt, expiresIn } = json;
    if (typeof jwt !== "string" || typeof expiresIn !== "number") {
      clearLocalSession();
      return;
    }
    __expiresAt = Date.now() + expiresIn * 1000;
    console.log("Refresh succeeded");
    __jwt = jwt;
    broadcastSessionUpdate(jwt, __expiresAt);
  } catch (e) {
    console.error("Refresh failed", e);
    // if server unreachable, just clear jwt
    __jwt = null;
    __expiresAt = 0;
    return;
  }
}

// Exchange a CrazyGames user token for our session. On CrazyGames the refresh
// cookie isn't usable (SameSite=Lax, cross-site iframe), so we re-exchange on
// expiry instead of hitting /auth/refresh.
async function doCrazyGamesLogin(token: string): Promise<void> {
  try {
    console.log("Logging in with CrazyGames");
    const response = await fetch(getApiBase() + "/auth/crazygames", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.status !== 200) {
      console.error("CrazyGames login failed", response);
      __jwt = null;
      return;
    }
    const json = await response.json();
    const { jwt, expiresIn } = json;
    __expiresAt = Date.now() + expiresIn * 1000;
    console.log("CrazyGames login succeeded");
    __jwt = jwt;
  } catch (e) {
    console.error("CrazyGames login failed", e);
    __jwt = null;
  }
}

// Exchange a Steam Web-API ticket for our session. Like CrazyGames, the
// refresh cookie isn't usable from app://openfront (cross-site), so we
// re-exchange a fresh ticket on expiry rather than hitting /auth/refresh.
async function doSteamLogin(ticket: string): Promise<void> {
  try {
    console.log("Logging in with Steam");
    const response = await fetch(getApiBase() + "/auth/steam", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (response.status !== 200) {
      console.error("Steam login failed", response);
      __jwt = null;
      return;
    }
    const json = await response.json();
    const { jwt, expiresIn } = json;
    __expiresAt = Date.now() + expiresIn * 1000;
    console.log("Steam login succeeded");
    __jwt = jwt;
  } catch (e) {
    console.error("Steam login failed", e);
    __jwt = null;
  }
}

// Called when the CrazyGames auth state changes mid-session (e.g. the player
// signs in): drop the cached session so userAuth() re-exchanges the new token.
// Single-flight: Main's auth listener and the account modal's sign-in handler
// can both react to the same sign-in; sharing one exchange keeps them from
// racing on __jwt. Any refresh already in flight is allowed to settle first so
// its stale result can't satisfy the reauth.
let __reauthPromise: Promise<UserAuth> | null = null;
export async function reauthAfterCrazyGamesChange(): Promise<UserAuth> {
  __reauthPromise ??= (async () => {
    try {
      if (__refreshPromise) {
        await __refreshPromise.catch(() => {});
      }
      __jwt = null;
      __expiresAt = 0;
      return await userAuth();
    } finally {
      __reauthPromise = null;
    }
  })();
  return __reauthPromise;
}

export async function sendMagicLink(email: string): Promise<boolean> {
  try {
    const apiBase = getApiBase();
    const response = await fetch(`${apiBase}/auth/magic-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        redirectDomain: window.location.origin,
        email: email,
      }),
    });

    if (response.ok) {
      return true;
    } else {
      console.error(
        "Failed to send recovery email:",
        response.status,
        response.statusText,
      );
      return false;
    }
  } catch (error) {
    console.error("Error sending recovery email:", error);
    return false;
  }
}

async function setSessionFromAuthResponse(json: {
  jwt?: unknown;
  expiresIn?: unknown;
}): Promise<UserAuth> {
  if (typeof json.jwt !== "string" || typeof json.expiresIn !== "number") {
    return false;
  }
  __jwt = json.jwt;
  __expiresAt = Date.now() + json.expiresIn * 1000;
  broadcastSessionUpdate(__jwt, __expiresAt);
  return userAuth(false);
}

export async function applyAccessToken(
  jwt: string,
  expiresIn: number,
): Promise<UserAuth> {
  return setSessionFromAuthResponse({ jwt, expiresIn });
}

export async function forceRefreshSession(): Promise<UserAuth> {
  __jwt = null;
  __expiresAt = 0;
  await refreshJwt();
  const refreshed = await userAuth(false);
  if (refreshed !== false) {
    return refreshed;
  }
  return ensureGuestSession();
}

export async function ensureGuestSession(
  prefetchedTurnstileToken?: string,
): Promise<UserAuth> {
  const existing = await userAuth();
  if (existing !== false) {
    return existing;
  }
  if (__guestPromise) {
    return __guestPromise;
  }
  __guestPromise = (async (): Promise<UserAuth> => {
    try {
      let turnstileToken = prefetchedTurnstileToken;
      if (!turnstileToken && isTurnstileClientRequired()) {
        turnstileToken = (await requestTurnstileToken()).token;
      }
      const payload = turnstileToken ? { turnstileToken } : {};
      const response = await fetch(getApiBase() + "/auth/guest", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.warn("Guest session provisioning failed", response.status);
        return false;
      }
      const json = (await response.json()) as {
        jwt?: unknown;
        expiresIn?: unknown;
      };
      return setSessionFromAuthResponse(json);
    } catch (e) {
      console.warn("Guest session request failed", e);
      return false;
    } finally {
      __guestPromise = null;
    }
  })();
  return __guestPromise;
}

export async function registerAccount(args: {
  email: string;
  password: string;
  username?: string;
  turnstileToken?: string;
}): Promise<AuthActionResult> {
  try {
    let turnstileToken = args.turnstileToken;
    if (!turnstileToken && isTurnstileClientRequired()) {
      turnstileToken = (await requestTurnstileToken()).token;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (__jwt) {
      headers.Authorization = `Bearer ${__jwt}`;
    }
    const body = turnstileToken
      ? { ...args, turnstileToken }
      : { email: args.email, password: args.password, username: args.username };
    const response = await fetch(getApiBase() + "/auth/register", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as {
      jwt?: unknown;
      expiresIn?: unknown;
      user?: UserMeResponse;
      upgradedFromGuest?: boolean;
      message?: string;
      error?: string;
    } | null;
    if (!response.ok || !json) {
      return {
        ok: false,
        error: json?.message ?? json?.error ?? `HTTP ${response.status}`,
      };
    }
    await setSessionFromAuthResponse(json);
    return {
      ok: true,
      user: json.user,
      upgradedFromGuest: json.upgradedFromGuest,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function loginAccount(args: {
  email: string;
  password: string;
}): Promise<AuthActionResult> {
  try {
    const response = await fetch(getApiBase() + "/auth/login", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    const json = (await response.json().catch(() => null)) as {
      jwt?: unknown;
      expiresIn?: unknown;
      user?: UserMeResponse;
      message?: string;
      error?: string;
    } | null;
    if (!response.ok || !json) {
      return {
        ok: false,
        error: json?.message ?? json?.error ?? `HTTP ${response.status}`,
      };
    }
    await setSessionFromAuthResponse(json);
    return {
      ok: true,
      user: json.user,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function createRecoveryCode(): Promise<RecoveryCodeResult> {
  try {
    const authHeader = await getAuthHeader();
    if (!authHeader) {
      return { ok: false, error: "Sign in or start a session first." };
    }
    const response = await fetch(getApiBase() + "/auth/recovery-code", {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const json = (await response.json().catch(() => null)) as {
      recoveryCode?: string;
      expiresAt?: string;
      message?: string;
      error?: string;
    } | null;
    if (!response.ok || !json?.recoveryCode) {
      return {
        ok: false,
        error: json?.message ?? json?.error ?? `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      recoveryCode: json.recoveryCode,
      expiresAt: json.expiresAt,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function recoverSession(
  recoveryCode: string,
): Promise<AuthActionResult> {
  try {
    const response = await fetch(getApiBase() + "/auth/recover", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recoveryCode }),
    });
    const json = (await response.json().catch(() => null)) as {
      jwt?: unknown;
      expiresIn?: unknown;
      user?: UserMeResponse;
      message?: string;
      error?: string;
    } | null;
    if (!response.ok || !json) {
      return {
        ok: false,
        error: json?.message ?? json?.error ?? `HTTP ${response.status}`,
      };
    }
    await setSessionFromAuthResponse(json);
    return {
      ok: true,
      user: json.user,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchAuthProviders(): Promise<AuthProvidersInfo | null> {
  try {
    const response = await fetch(getApiBase() + "/auth/providers", {
      credentials: "include",
    });
    if (!response.ok) return null;
    return (await response.json()) as AuthProvidersInfo;
  } catch {
    return null;
  }
}

// WARNING: DO NOT EXPOSE THIS ID
export async function getPlayToken(): Promise<string> {
  const result = await userAuth();
  if (result !== false) return result.jwt;
  if (ClientEnv.env() === GameEnv.Dev) {
    return getPersistentIDFromLocalStorage();
  }
  const guestResult = await ensureGuestSession();
  if (guestResult !== false) return guestResult.jwt;
  throw new Error(
    "Authentication required: unable to provision FrontierX session token.",
  );
}

/**
 * Resolves a local-only play token for offline single-player matches and
 * local replays without requiring remote authentication availability.
 */
export async function getLocalPlayToken(): Promise<string> {
  if (__jwt !== null && Date.now() < __expiresAt - 60_000) {
    const cached = await userAuth(false);
    if (cached !== false) {
      return cached.jwt;
    }
  }
  return getPersistentIDFromLocalStorage();
}

// WARNING: DO NOT EXPOSE THIS ID
export function getPersistentID(): string {
  const jwt = __jwt;
  if (!jwt) return getPersistentIDFromLocalStorage();
  const payload = decodeJwt(jwt);
  const sub = payload.sub;
  if (!sub) return getPersistentIDFromLocalStorage();
  return base64urlToUuid(sub);
}

// WARNING: DO NOT EXPOSE THIS ID
function getPersistentIDFromLocalStorage(): string {
  // Try to get existing ID
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const storage = isLocalhost ? sessionStorage : localStorage;

  const value = storage.getItem(PERSISTENT_ID_KEY);
  if (value) return value;

  // If no ID exists, create new ID and set storage
  const newID = generateCryptoRandomUUID();
  storage.setItem(PERSISTENT_ID_KEY, newID);

  return newID;
}
