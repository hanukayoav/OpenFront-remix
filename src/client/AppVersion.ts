import rawVersion from "resources/version.txt?raw";

export function formatVersionLabel(versionText: string): string {
  const trimmed = versionText.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export const RAW_APP_VERSION = rawVersion.trim();
export const DISPLAY_APP_VERSION = formatVersionLabel(rawVersion);
