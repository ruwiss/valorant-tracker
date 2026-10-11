import assert from "node:assert/strict";
import test from "node:test";
import { diffUnread } from "../src/lib/messageAlert.ts";
import type { Conversation } from "../src/lib/types.ts";

function conv(cid: string, unread: number, muted = false): Conversation {
  return {
    cid,
    direct_messages: true,
    global_read: false,
    message_history: true,
    muted,
    muted_restriction: false,
    type: "chat",
    unread_count: unread,
  };
}

test("first snapshot is a silent baseline", () => {
  const { baseline, delta } = diffUnread(null, [conv("a", 5), conv("b", 2)]);
  assert.equal(delta, 0);
  assert.deepEqual(baseline, { a: 5, b: 2 });
});

test("unread increases across conversations add up", () => {
  const { baseline, delta } = diffUnread(
    { a: 0, b: 1 },
    [conv("a", 3), conv("b", 2)],
  );
  assert.equal(delta, 4);
  assert.deepEqual(baseline, { a: 3, b: 2 });
});

test("a drop updates the baseline without alerting", () => {
  const { baseline, delta } = diffUnread({ a: 4 }, [conv("a", 1)]);
  assert.equal(delta, 0);
  assert.deepEqual(baseline, { a: 1 });
});

test("live party rooms are ignored", () => {
  const { baseline, delta } = diffUnread(
    { dm: 0 },
    [conv("dm", 1), conv("ares-parties-room", 9)],
  );
  assert.equal(delta, 1);
  assert.deepEqual(baseline, { dm: 1 });
});

test("muted conversations are ignored", () => {
  const { baseline, delta } = diffUnread({ loud: 0 }, [conv("loud", 2), conv("quiet", 6, true)]);
  assert.equal(delta, 2);
  assert.deepEqual(baseline, { loud: 2 });
});

test("a conversation that disappears leaves the baseline", () => {
  const { baseline, delta } = diffUnread({ a: 1, b: 3 }, [conv("a", 1)]);
  assert.equal(delta, 0);
  assert.deepEqual(baseline, { a: 1 });
});
