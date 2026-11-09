import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("FrontierX v1.0.5 Branding Implementation", () => {
  const rootDir = process.cwd();

  it("verifies FrontierXLogo.svg exists in resources and proprietary directories", () => {
    const resLogoPath = path.join(
      rootDir,
      "resources/images/FrontierXLogo.svg",
    );
    const propLogoPath = path.join(
      rootDir,
      "proprietary/images/FrontierXLogo.svg",
    );

    expect(fs.existsSync(resLogoPath)).toBe(true);
    expect(fs.existsSync(propLogoPath)).toBe(true);

    const content = fs.readFileSync(resLogoPath, "utf-8");
    expect(content).toContain("<svg");
    expect(content).toContain("FRONTIER");
    expect(content).toContain("TACTICAL STRATEGY COMBAT");
  });

  it("verifies FrontierXEmblem.svg exists and contains shield & tactical X geometry", () => {
    const emblemPath = path.join(
      rootDir,
      "resources/images/FrontierXEmblem.svg",
    );
    expect(fs.existsSync(emblemPath)).toBe(true);

    const content = fs.readFileSync(emblemPath, "utf-8");
    expect(content).toContain("<svg");
    // Shield armor body
    expect(content).toContain("SHIELD ARMOR BODY");
    // Globe core
    expect(content).toContain("GLOBE / MAP GRID CORE");
    // Faceted X
    expect(content).toContain('THE FACETED TACTICAL "X"');
  });

  it("verifies Favicon.svg contains the Concept A shield favicon", () => {
    const favPath = path.join(rootDir, "proprietary/images/Favicon.svg");
    expect(fs.existsSync(favPath)).toBe(true);

    const content = fs.readFileSync(favPath, "utf-8");
    expect(content).toContain("fav-a-shield");
    expect(content).toContain("fav-a-x");
  });

  it("verifies web manifest is updated to FrontierX", () => {
    const manifestPath = path.join(rootDir, "resources/manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.name).toBe("FrontierX");
    expect(manifest.short_name).toBe("FrontierX");
  });

  it("verifies English locale dictionary sets main.title to FrontierX (ALPHA)", () => {
    const langPath = path.join(rootDir, "resources/lang/en.json");
    const en = JSON.parse(fs.readFileSync(langPath, "utf-8"));

    expect(en.main.title).toBe("FrontierX (ALPHA)");
  });

  it("verifies index.html has FrontierX title and OpenGraph metadata", () => {
    const htmlPath = path.join(rootDir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf-8");

    expect(html).toContain(
      '<title data-i18n="main.title">FrontierX (ALPHA)</title>',
    );
    expect(html).toContain(
      'content="FrontierX - Tactical Strategy Battle Royale"',
    );
  });

  it("verifies navigation components reference FrontierXLogo.svg and alt text", () => {
    const desktopNav = fs.readFileSync(
      path.join(rootDir, "src/client/components/DesktopNavBar.ts"),
      "utf-8",
    );
    expect(desktopNav).toContain("images/FrontierXLogo.svg");
    expect(desktopNav).toContain('alt="FrontierX"');

    const mobileNav = fs.readFileSync(
      path.join(rootDir, "src/client/components/MobileNavBar.ts"),
      "utf-8",
    );
    expect(mobileNav).toContain("images/FrontierXLogo.svg");
    expect(mobileNav).toContain('alt="FrontierX"');

    const playPage = fs.readFileSync(
      path.join(rootDir, "src/client/components/PlayPage.ts"),
      "utf-8",
    );
    expect(playPage).toContain("images/FrontierXLogo.svg");
    expect(playPage).toContain('alt="FrontierX"');
  });

  it("verifies GameStartingModal uses FrontierX branding and preserves AGPL-3.0 attribution", () => {
    const modal = fs.readFileSync(
      path.join(rootDir, "src/client/GameStartingModal.ts"),
      "utf-8",
    );
    expect(modal).toContain("images/FrontierXEmblem.svg");
    expect(modal).toContain("Frontier");
    expect(modal).toContain("v1.0.5");
    expect(modal).toContain("game_starting_modal.code_license");
    expect(modal).toContain("OpenFront and Contributors");
    expect(modal).toContain("game_starting_modal.credits");
  });
});
