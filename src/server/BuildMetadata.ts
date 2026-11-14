import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export interface BuildMetadata {
  gitCommit: string;
  version: string;
}

export const BUILD_METADATA_FILENAME = "build-metadata.json";
export const COMMIT_FILENAME = "commit.txt";

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveGitCommitForBuild(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv =
    nonEmptyTrimmed(env.GIT_COMMIT) ?? nonEmptyTrimmed(env.GITHUB_SHA);
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const out = execSync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return nonEmptyTrimmed(out) ?? "";
  } catch {
    return "";
  }
}

export function readVersionFromResources(rootDir: string): string {
  try {
    return (
      nonEmptyTrimmed(
        fs.readFileSync(path.join(rootDir, "resources", "version.txt"), "utf8"),
      ) ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

export function writeBuildMetadata(
  outDir: string,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): BuildMetadata {
  const gitCommit = resolveGitCommitForBuild(rootDir, env);
  const version = readVersionFromResources(rootDir);
  const metadata: BuildMetadata = { gitCommit, version };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, BUILD_METADATA_FILENAME),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );
  if (gitCommit) {
    fs.writeFileSync(path.join(outDir, COMMIT_FILENAME), gitCommit, "utf8");
  }
  return metadata;
}

export function readBuildCommitFromDir(
  staticDir: string = path.join(process.cwd(), "static"),
): string | undefined {
  const metadataPath = path.join(staticDir, BUILD_METADATA_FILENAME);
  if (fs.existsSync(metadataPath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(metadataPath, "utf8"),
      ) as Partial<BuildMetadata>;
      const fromMeta = nonEmptyTrimmed(parsed.gitCommit);
      if (fromMeta) return fromMeta;
    } catch {
      // Ignore malformed metadata and fall through to commit.txt
    }
  }

  const commitPath = path.join(staticDir, COMMIT_FILENAME);
  if (fs.existsSync(commitPath)) {
    try {
      const fromCommitFile = nonEmptyTrimmed(
        fs.readFileSync(commitPath, "utf8"),
      );
      if (fromCommitFile) return fromCommitFile;
    } catch {
      // Ignore read failure and fall back to env var
    }
  }

  return undefined;
}

export function resolveRuntimeGitCommit(options: {
  isDev: boolean;
  envCommit?: string;
  staticDir?: string;
}): string {
  const envCommit = nonEmptyTrimmed(options.envCommit);
  const builtCommit = readBuildCommitFromDir(options.staticDir);

  if (options.isDev) {
    if (envCommit) return envCommit;
    if (builtCommit) return builtCommit;
  } else {
    // In production/staging, prefer the build artifact emitted alongside the
    // static assets so stale PM2/process GIT_COMMIT values cannot pin old SHAs.
    if (builtCommit) return builtCommit;
    if (envCommit) return envCommit;
  }

  throw new Error("GIT_COMMIT not set");
}
