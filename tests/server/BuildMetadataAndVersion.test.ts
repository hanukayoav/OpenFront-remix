import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_METADATA_FILENAME,
  COMMIT_FILENAME,
  readBuildCommitFromDir,
  resolveGitCommitForBuild,
  resolveRuntimeGitCommit,
  writeBuildMetadata,
} from "../../src/server/BuildMetadata";

describe("Build metadata and version consistency", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontierx-build-meta-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes build-metadata.json and commit.txt using explicit env or git HEAD", () => {
    const outDir = makeTempDir();
    const repoRoot = process.cwd();
    const metadata = writeBuildMetadata(outDir, repoRoot, {
      GITHUB_SHA: "abcdef1234567890abcdef1234567890abcdef12",
    });

    expect(metadata.gitCommit).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(metadata.version).toBe("1.0.7");
    expect(readBuildCommitFromDir(outDir)).toBe(metadata.gitCommit);

    const metaJson = JSON.parse(
      fs.readFileSync(path.join(outDir, BUILD_METADATA_FILENAME), "utf8"),
    );
    expect(metaJson).toEqual(metadata);
    expect(
      fs.readFileSync(path.join(outDir, COMMIT_FILENAME), "utf8").trim(),
    ).toBe(metadata.gitCommit);
  });

  it("resolves git HEAD when GIT_COMMIT and GITHUB_SHA are unset", () => {
    const commit = resolveGitCommitForBuild(process.cwd(), {});
    expect(commit).toMatch(/^[0-9a-f]{40}$/i);
  });

  it("ignores stale GIT_COMMIT env in production when build metadata exists on disk", () => {
    const staticDir = makeTempDir();
    writeBuildMetadata(staticDir, process.cwd(), {
      GIT_COMMIT: "fresh1234567890",
    });

    expect(
      resolveRuntimeGitCommit({
        isDev: false,
        envCommit: "6731269a",
        staticDir,
      }),
    ).toBe("fresh1234567890");

    // In Dev mode, explicit GIT_COMMIT continues to win for local/unit workflows.
    expect(
      resolveRuntimeGitCommit({
        isDev: true,
        envCommit: "DEV",
        staticDir,
      }),
    ).toBe("DEV");
  });

  it("keeps version 1.0.7 aligned across resources/version.txt, logo SVG, and starting modal", () => {
    const root = process.cwd();
    const rawVersion = fs
      .readFileSync(path.join(root, "resources/version.txt"), "utf8")
      .trim();
    expect(rawVersion).toBe("1.0.7");

    const logoSvg = fs.readFileSync(
      path.join(root, "resources/images/FrontierXLogo.svg"),
      "utf8",
    );
    expect(logoSvg).toContain(`>v${rawVersion}</text>`);
    expect(logoSvg).not.toContain("v1.0.5");

    const propLogoSvg = fs.readFileSync(
      path.join(root, "proprietary/images/FrontierXLogo.svg"),
      "utf8",
    );
    expect(propLogoSvg).toContain(`>v${rawVersion}</text>`);
    expect(propLogoSvg).not.toContain("v1.0.5");

    const startingModal = fs.readFileSync(
      path.join(root, "src/client/GameStartingModal.ts"),
      "utf8",
    );
    expect(startingModal).toContain("DISPLAY_APP_VERSION");
    expect(startingModal).not.toContain("v1.0.5");
  });
});
