// Add global mocks or configuration here if needed
import "vitest-canvas-mock";

// Node v22+/v26 experimental localStorage fix: when --localstorage-file is not provided,
// Node defines globalThis.localStorage as undefined, shadowing jsdom's window.localStorage.
if (typeof window !== "undefined") {
  const needsShim =
    !globalThis.localStorage ||
    typeof globalThis.localStorage.getItem !== "function";
  if (needsShim) {
    const store = new Map<string, string>();
    const storageShim: Storage = {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    };

    const targetStorage =
      window.localStorage && typeof window.localStorage.getItem === "function"
        ? window.localStorage
        : storageShim;

    Object.defineProperty(globalThis, "localStorage", {
      value: targetStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "localStorage", {
      value: targetStorage,
      writable: true,
      configurable: true,
    });
  }
}
