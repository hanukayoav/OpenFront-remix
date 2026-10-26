import { base64url } from "jose";
import { Logger } from "winston";
import { ReservedClanTagsResponseSchema } from "../core/ClanApiSchemas";
import { Cosmetics, CosmeticsSchema } from "../core/CosmeticSchemas";
import { GameEnv } from "../core/configuration/Config";
import { startPolling } from "./PollingLoop";
import {
  FailOpenPrivilegeChecker,
  PrivilegeChecker,
  PrivilegeCheckerImpl,
} from "./Privilege";
import { ServerEnv } from "./ServerEnv";

// Refreshes the privilege checker every 3 minutes.
// WARNING: This fails open if cosmetics.json is not available.
export class PrivilegeRefresher {
  private privilegeChecker: PrivilegeChecker | null = null;
  private failOpenPrivilegeChecker: PrivilegeChecker =
    new FailOpenPrivilegeChecker();

  private log: Logger;

  constructor(
    private cosmeticsEndpoint: string,
    private apiKey: string,
    private reservedClanTagsEndpoint: string,
    parentLog: Logger,
    private refreshInterval: number = 1000 * 60 * 3,
  ) {
    this.log = parentLog.child({ comp: "privilege-refresher" });
  }

  public async start() {
    this.log.info(
      `Starting privilege refresher with interval ${this.refreshInterval}`,
    );
    startPolling(() => this.loadPrivilegeChecker(), this.refreshInterval);
  }

  public get(): PrivilegeChecker {
    return this.privilegeChecker ?? this.failOpenPrivilegeChecker;
  }

  private async loadPrivilegeChecker(): Promise<void> {
    this.log.info(`Loading privilege checker`);
    const isDev = ServerEnv.env() === GameEnv.Dev;
    try {
      const fetchWithTimeout = async (url: string) => {
        try {
          return await fetch(url, {
            signal: AbortSignal.timeout(5000),
            headers: { "x-api-key": this.apiKey },
          });
        } catch (error) {
          this.log.warn(`Failed to fetch ${url}: ${error}`);
          return null;
        }
      };

      const [cosmeticsResponse, reservedClanTagsResponse] = await Promise.all([
        fetchWithTimeout(this.cosmeticsEndpoint),
        fetchWithTimeout(this.reservedClanTagsEndpoint),
      ]);

      let cosmeticsData: Cosmetics;
      if (!cosmeticsResponse || !cosmeticsResponse.ok) {
        if (isDev) {
          this.log.warn(
            `Cosmetics fetch failed in dev mode (${cosmeticsResponse?.status ?? "network error"}); falling back to empty cosmetics`,
          );
          cosmeticsData = { patterns: {}, flags: {} };
        } else {
          throw new Error(
            `Cosmetics HTTP error! status: ${cosmeticsResponse?.status ?? "network error"}`,
          );
        }
      } else {
        const raw = await cosmeticsResponse.json();
        const result = CosmeticsSchema.safeParse(raw);
        if (!result.success) {
          if (isDev) {
            this.log.warn(
              `Invalid cosmetics data in dev mode: ${result.error.message}; falling back to empty cosmetics`,
            );
            cosmeticsData = { patterns: {}, flags: {} };
          } else {
            throw new Error(`Invalid cosmetics data: ${result.error.message}`);
          }
        } else {
          cosmeticsData = result.data;
        }
      }

      // Reserved clan tags are critical: a missing or malformed list would
      // make every non-member tag look fictional and let impersonation
      // through. In dev mode, fall back to empty list when offline.
      let reservedClanTagsList: string[];
      if (!reservedClanTagsResponse || !reservedClanTagsResponse.ok) {
        if (isDev) {
          this.log.warn(
            `Reserved clan tags fetch failed in dev mode (${reservedClanTagsResponse?.status ?? "network error"}); falling back to empty tags`,
          );
          reservedClanTagsList = [];
        } else {
          throw new Error(
            `Reserved clan tags HTTP error! status: ${reservedClanTagsResponse?.status ?? "network error"}`,
          );
        }
      } else {
        const raw = await reservedClanTagsResponse.json();
        const result = ReservedClanTagsResponseSchema.safeParse(raw);
        if (!result.success) {
          if (isDev) {
            this.log.warn(
              `Invalid reserved clan tags data in dev mode: ${result.error.message}; falling back to empty list`,
            );
            reservedClanTagsList = [];
          } else {
            throw new Error(
              `Invalid reserved clan tags data: ${result.error.message}`,
            );
          }
        } else {
          reservedClanTagsList = result.data;
        }
      }

      const reservedClanTags = new Set(
        reservedClanTagsList.map((tag) => tag.toUpperCase()),
      );

      this.privilegeChecker = new PrivilegeCheckerImpl(
        cosmeticsData,
        base64url.decode,
        reservedClanTags,
      );
      this.log.info(
        `Privilege checker loaded successfully (${reservedClanTags.size} reserved clan tags)`,
      );
    } catch (error) {
      if (isDev) {
        this.log.warn(
          `Failed to load privilege checker in dev mode, continuing with fallback: ${error}`,
        );
        return;
      }
      this.log.error(`Failed to load privilege checker:`, error);
      throw error;
    }
  }
}
