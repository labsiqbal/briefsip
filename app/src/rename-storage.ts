type ReadStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem' | 'removeItem'>>;

function legacyKey(key: string): string {
  return key.replace(/^minarbot(?=[.:-])/, 'briefsip');
}

export function readProductStorage(storage: ReadStorage, key: string): string | null {
  const value = storage.getItem(key);
  const old = legacyKey(key);
  if (value !== null || old === key) return value;

  const saved = storage.getItem(old);
  if (saved !== null && storage.setItem) {
    try {
      storage.setItem(key, saved);
      storage.removeItem?.(old);
    } catch {
      // A failed copy must leave recovery data readable under its old key.
    }
  }
  return saved;
}

export function removeProductStorage(storage: Pick<Storage, 'removeItem'>, key: string): void {
  const old = legacyKey(key);
  if (old !== key) storage.removeItem(old);
  storage.removeItem(key);
}

export function productTheme<T>(value: T): T | 'minarbot' {
  return value === 'briefsip' ? 'minarbot' : value;
}
