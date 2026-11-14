import type { UserMeResponse } from "../core/ApiSchemas";
import { getApiBase } from "./Api";
import * as Auth from "./Auth";

export interface FrontierAuthActionResult {
  ok: boolean;
  error?: string;
  user?: UserMeResponse;
  upgradedFromGuest?: boolean;
}

export interface FrontierRecoveryCodeResult {
  ok: boolean;
  recoveryCode?: string;
  expiresAt?: string;
  error?: string;
}

export interface FrontierAuthProviders {
  providers: {
    guest: boolean;
    frontierx: boolean;
    recovery: boolean;
    discord: boolean;
    google: boolean;
  };
  turnstileRequired: boolean;
}

async function installSessionResponse(json: {
  jwt?: unknown;
  expiresIn?: unknown;
}): Promise<void> {
  const applyFn = (
    Auth as unknown as {
      applyAccessToken?: (jwt: string, expiresIn: number) => Promise<unknown>;
    }
  ).applyAccessToken;
  if (
    typeof applyFn === "function" &&
    typeof json.jwt === "string" &&
    typeof json.expiresIn === "number"
  ) {
    await applyFn(json.jwt, json.expiresIn);
    return;
  }
  Auth.clearLocalSession();
  await Auth.userAuth();
}

export async function registerFrontierAccount(args: {
  email: string;
  password: string;
  username?: string;
}): Promise<FrontierAuthActionResult> {
  try {
    const authHeader = await Auth.getAuthHeader().catch(() => "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    const response = await fetch(`${getApiBase()}/auth/register`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(args),
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
    await installSessionResponse(json);
    return {
      ok: true,
      user: json.user,
      upgradedFromGuest: json.upgradedFromGuest,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loginFrontierAccount(args: {
  email: string;
  password: string;
}): Promise<FrontierAuthActionResult> {
  try {
    const response = await fetch(`${getApiBase()}/auth/login`, {
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
    await installSessionResponse(json);
    return {
      ok: true,
      user: json.user,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createSessionRecoveryCode(): Promise<FrontierRecoveryCodeResult> {
  try {
    const ensureFn = (
      Auth as unknown as {
        ensureGuestSession?: () => Promise<unknown>;
      }
    ).ensureGuestSession;
    let authHeader = await Auth.getAuthHeader().catch(() => "");
    if (!authHeader && typeof ensureFn === "function") {
      await ensureFn();
      authHeader = await Auth.getAuthHeader().catch(() => "");
    }
    if (!authHeader) {
      return { ok: false, error: "Start a session first to generate a code." };
    }
    const response = await fetch(`${getApiBase()}/auth/recovery-code`, {
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
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function recoverFrontierSession(
  recoveryCode: string,
): Promise<FrontierAuthActionResult> {
  try {
    const response = await fetch(`${getApiBase()}/auth/recover`, {
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
    await installSessionResponse(json);
    return {
      ok: true,
      user: json.user,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getAuthProvidersInfo(): Promise<FrontierAuthProviders | null> {
  try {
    const response = await fetch(`${getApiBase()}/auth/providers`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    return (await response.json()) as FrontierAuthProviders;
  } catch {
    return null;
  }
}
