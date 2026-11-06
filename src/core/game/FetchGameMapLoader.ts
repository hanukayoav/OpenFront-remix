import { GameMapType } from "./Game";
import { GameMapLoader, MapData } from "./GameMapLoader";

export class FetchGameMapLoader implements GameMapLoader {
  private maps: Map<GameMapType, MapData>;

  public constructor(
    private readonly pathResolver: string | ((path: string) => string),
  ) {
    this.maps = new Map<GameMapType, MapData>();
  }

  public getMapData(map: GameMapType): MapData {
    const cachedMap = this.maps.get(map);
    if (cachedMap) {
      return cachedMap;
    }

    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    const fileName = key?.toLowerCase();

    if (!fileName) {
      throw new Error(`Unknown map: ${map}`);
    }

    const mapData = {
      mapBin: () => this.loadBinaryFromUrl(this.url(fileName, "map.bin")),
      map4xBin: () => this.loadBinaryFromUrl(this.url(fileName, "map4x.bin")),
      map16xBin: () => this.loadBinaryFromUrl(this.url(fileName, "map16x.bin")),
      manifest: () => this.loadJsonFromUrl(this.url(fileName, "manifest.json")),
      webpPath: this.url(fileName, "thumbnail.webp"),
      layerPng: (layerId: string) =>
        this.loadImageBitmap(this.url(fileName, `${layerId}.png`)),
    } satisfies MapData;

    this.maps.set(map, mapData);
    return mapData;
  }

  private resolveUrl(path: string): string {
    const raw =
      typeof this.pathResolver === "function"
        ? this.pathResolver(path)
        : `${this.pathResolver}/${path}`;

    // Blob-based Web Workers cannot reliably fetch root-relative URLs.
    // Resolve them against the worker's origin or configured CDN origin.
    if (typeof window === "undefined" && raw.startsWith("/")) {
      const workerOrigin =
        typeof self !== "undefined" && self.location?.origin
          ? self.location.origin
          : undefined;
      const cdnOrigin = (globalThis as unknown as { __CDN_BASE__?: string }).__CDN_BASE__;
      const origin = workerOrigin ?? cdnOrigin ?? "";
      if (origin) {
        try {
          return new URL(raw, origin).href;
        } catch {
          return raw;
        }
      }
    }

    return raw;
  }

  private url(map: string, path: string) {
    return this.resolveUrl(`${map}/${path}`);
  }

  private async loadBinaryFromUrl(url: string) {
    const startTime = performance.now();
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    const data = await response.arrayBuffer();
    console.log(
      `[MapLoader] ${url}: ${(performance.now() - startTime).toFixed(0)}ms`,
    );
    return new Uint8Array(data);
  }

  private async loadJsonFromUrl(url: string) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    return response.json();
  }

  private async loadImageBitmap(url: string): Promise<ImageBitmap> {
    const startTime = performance.now();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    console.log(
      `[MapLoader] ${url}: ${(performance.now() - startTime).toFixed(0)}ms`,
    );
    return bitmap;
  }
}
