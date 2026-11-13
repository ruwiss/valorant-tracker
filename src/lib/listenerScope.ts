/** Own async native subscriptions, including ones that resolve after cleanup. */
export function createListenerScope() {
  let disposed = false;
  const listeners = new Set<() => void>();
  return {
    async add(subscription: Promise<() => void>) {
      const unlisten = await subscription;
      if (disposed) unlisten();
      else listeners.add(unlisten);
    },
    dispose() {
      disposed = true;
      for (const unlisten of listeners) unlisten();
      listeners.clear();
    },
  };
}
