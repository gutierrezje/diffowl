const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export async function loadCached(key: string, fetchValue: () => Promise<string>): Promise<string> {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let promise = pending.get(key);
  if (promise === undefined) {
    promise = fetchValue().then((value) => {
      cache.set(key, value);
      pending.delete(key);
      return value;
    });
    pending.set(key, promise);
  }

  return promise;
}
