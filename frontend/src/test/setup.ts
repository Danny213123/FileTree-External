import "@testing-library/jest-dom/vitest";

// Node 22+ defines its own experimental `localStorage` global that is unusable
// without --localstorage-file, and it shadows jsdom's working one: Vitest skips
// the key when copying jsdom globals, so `localStorage` reads back as undefined
// for tests and app code alike. jsdom's own Storage is unreachable from here
// (Vitest aliases both `window` and `document.defaultView` to the global), so
// install an in-memory Storage of our own. `window === globalThis` under Vitest,
// so this one definition serves both access paths.
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number { return this.entries.size; }
  key(index: number): string | null { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.entries.get(String(key)) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(String(key), String(value)); }
  removeItem(key: string): void { this.entries.delete(String(key)); }
  clear(): void { this.entries.clear(); }
}

for (const key of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
