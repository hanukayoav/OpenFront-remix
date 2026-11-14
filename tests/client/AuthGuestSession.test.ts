import { UnsecuredJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalSession,
  getPlayToken,
  userAuth,
} from "../../src/client/Auth";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  loginFrontierAccount,
  recoverFrontierSession,
  registerFrontierAccount,
} from "../../src/client/FrontierAuth";
import { steamSDK } from "../../src/client/SteamSDK";

function setBootstrapConfig(
  gameEnv: "prod" | "dev" = "prod",
  jwtAudience = "openfront-2.duckdns.org",
) {
  (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG = {
    gameEnv,
    numWorkers: 2,
    turnstileSiteKey: "1x00000000000000000000AA",
    jwtAudience,
    instanceId: "test-inst",
    gitCommit: "test-commit",
  };
  ClientEnv.reset();
}

function makeSignedLookingJwt(
  iss: string,
  aud: string,
  sub = "AAAAAAAAAAAAAAAAAAAAAA",
) {
  return new UnsecuredJWT({
    jti: "jti-guest-1",
    sub,
    iat: Math.floor(Date.now() / 1000),
    iss,
    aud,
    exp: Math.floor(Date.now() / 1000) + 900,
    provider: "guest",
  }).encode();
}

function installTurnstileMock(token = "turnstile-test-token") {
  window.turnstile = {
    render: () => "mock-widget-1",
    execute: (_widgetId, opts) => {
      opts.callback(token);
    },
    remove: () => {},
  };
}

describe("Client Guest Session & FrontierAuth integration", () => {
  beforeEach(() => {
    setBootstrapConfig("prod", "openfront-2.duckdns.org");
    clearLocalSession();
    delete window.turnstile;
    vi.restoreAllMocks();
    vi.spyOn(steamSDK, "isOnSteam").mockReturnValue(false);
  });

  it("clears session locally on 401 refresh without triggering redundant /auth/logout POSTs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "missing_refresh_token" }), {
        status: 401,
      }),
    );

    const res = await userAuth();
    expect(res).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/auth/refresh");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/auth/logout")),
    ).toBe(false);
  });

  it("deduplicates concurrent getPlayToken() guest provisioning calls via single-flight /auth/guest", async () => {
    installTurnstileMock("turnstile-guest-token");
    const expectedIss = `${window.location.origin}/api`;
    const jwt = makeSignedLookingJwt(expectedIss, "openfront-2.duckdns.org");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/auth/refresh")) {
          return new Response(JSON.stringify({ error: "missing" }), {
            status: 401,
          });
        }
        if (url.endsWith("/auth/guest")) {
          return new Response(JSON.stringify({ jwt, expiresIn: 900 }), {
            status: 201,
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    const [t1, t2] = await Promise.all([getPlayToken(), getPlayToken()]);
    expect(t1).toBe(jwt);
    expect(t2).toBe(jwt);

    const guestCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/auth/guest"),
    );
    expect(guestCalls).toHaveLength(1);
    const guestBody = JSON.parse(String(guestCalls[0][1]?.body ?? "{}")) as {
      turnstileToken?: string;
    };
    expect(guestBody.turnstileToken).toBe("turnstile-guest-token");
  });

  it("refuses unsigned persistent IDs and fails closed when Turnstile or /auth/guest is unavailable in prod, while allowing unsigned IDs in Dev", async () => {
    // Without window.turnstile in prod, getPlayToken() refuses without issuing unverified /auth/guest calls
    const fetchNoTurnstile = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "missing" }), { status: 401 }),
      );
    await expect(getPlayToken()).rejects.toThrow(/Authentication required/);
    expect(
      fetchNoTurnstile.mock.calls.some((c) =>
        String(c[0]).endsWith("/auth/guest"),
      ),
    ).toBe(false);

    installTurnstileMock("turnstile-guest-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    await expect(getPlayToken()).rejects.toThrow(/Authentication required/);

    setBootstrapConfig("dev", "localhost");
    clearLocalSession();
    const devToken = await getPlayToken();
    expect(devToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("installs registered, logged-in, and recovered JWT sessions cleanly", async () => {
    installTurnstileMock("turnstile-register-token");
    const expectedIss = `${window.location.origin}/api`;
    const jwt = makeSignedLookingJwt(expectedIss, "openfront-2.duckdns.org");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jwt,
            expiresIn: 900,
            upgradedFromGuest: true,
          }),
          { status: 200 },
        );
      });

    const reg = await registerFrontierAccount({
      email: "pilot@frontierx.test",
      password: "Password!123",
    });
    expect(reg.ok).toBe(true);
    const regCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/auth/register"),
    );
    expect(JSON.parse(String(regCall?.[1]?.body ?? "{}")).turnstileToken).toBe(
      "turnstile-register-token",
    );
    expect(await getPlayToken()).toBe(jwt);

    clearLocalSession();
    const login = await loginFrontierAccount({
      email: "pilot@frontierx.test",
      password: "Password!123",
    });
    expect(login.ok).toBe(true);
    expect(await getPlayToken()).toBe(jwt);

    clearLocalSession();
    const rec = await recoverFrontierSession("FXREC-AAAA-BBBB-CCCC");
    expect(rec.ok).toBe(true);
    expect(await getPlayToken()).toBe(jwt);
  });

  it("serializes /auth/refresh via navigator.locks and reuses freshly broadcasted JWT across concurrent tabs", async () => {
    const expectedIss = `${window.location.origin}/api`;
    const jwt = makeSignedLookingJwt(expectedIss, "openfront-2.duckdns.org");

    let lockAcquired = 0;
    const origNavigator = globalThis.navigator;
    let lockChain = Promise.resolve();
    const fakeLocks = {
      request: vi.fn(
        async (_name: string, fn: () => Promise<void>): Promise<void> => {
          lockAcquired++;
          const run = lockChain.then(async () => {
            await fn();
          });
          lockChain = run.catch(() => {});
          return run;
        },
      ),
    };
    Object.defineProperty(origNavigator, "locks", {
      configurable: true,
      value: fakeLocks,
    });

    try {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.endsWith("/auth/refresh")) {
            return new Response(JSON.stringify({ jwt, expiresIn: 900 }), {
              status: 200,
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        });

      // Simulate first tab refresh acquiring lock and caching fresh JWT,
      // followed by a second call once session already updated via sync.
      const res1 = await userAuth();
      expect(res1).not.toBe(false);
      expect(lockAcquired).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const res2 = await userAuth();
      expect(res2).not.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(origNavigator, "locks", {
        configurable: true,
        value: undefined,
      });
    }
  });
});
