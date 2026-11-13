import assert from "node:assert/strict";
import test from "node:test";
import { createListenerScope } from "../src/lib/listenerScope.ts";

test("native subscriptions resolving after unmount are removed immediately", async () => {
  const scope = createListenerScope();
  let finish!: (unlisten: () => void) => void;
  let removed = 0;
  const subscribing = scope.add(new Promise(resolve => { finish = resolve; }));
  scope.dispose();
  finish(() => { removed += 1; });
  await subscribing;
  assert.equal(removed, 1);
  scope.dispose();
  assert.equal(removed, 1);
});
test("StrictMode remount leaves only the current native listener alive", async () => {
  const events = new Set<() => void>();
  const widths: number[] = [];
  const oldScope = createListenerScope();
  let finish!: (unlisten: () => void) => void;
  const staleCallback = () => widths.push(380);
  const pending = oldScope.add(new Promise(resolve => { finish = resolve; }));
  oldScope.dispose();
  const newScope = createListenerScope();
  const activeCallback = () => widths.push(780);
  events.add(activeCallback);
  await newScope.add(Promise.resolve(() => { events.delete(activeCallback); }));
  events.add(staleCallback);
  finish(() => { events.delete(staleCallback); });
  await pending;
  for (const callback of events) callback();
  assert.deepEqual(widths, [780]);
  newScope.dispose();
  assert.equal(events.size, 0);
});
