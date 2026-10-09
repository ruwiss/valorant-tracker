import assert from "node:assert/strict";
import test from "node:test";
import { planChangelog } from "../src/changelog.ts";

test("blank notes never open the card, and a new version is marked seen", () => {
  const plan = planChangelog({
    notes: "  \n",
    currentVersion: "1.9.7",
    seenVersion: "1.9.6",
    hasUsedAppBefore: true,
  });
  assert.equal(plan.show, false);
  assert.equal(plan.markSeen, true);
});

test("first install does not open the card, but records the version", () => {
  const plan = planChangelog({
    notes: "Updates now install on their own.",
    currentVersion: "1.9.7",
    seenVersion: null,
    hasUsedAppBefore: false,
  });
  assert.equal(plan.show, false);
  assert.equal(plan.markSeen, true);
});

test("an existing user with no recorded version sees notes once", () => {
  const plan = planChangelog({
    notes: "Updates now install on their own.",
    currentVersion: "1.9.7",
    seenVersion: null,
    hasUsedAppBefore: true,
  });
  assert.equal(plan.show, true);
  assert.equal(plan.markSeen, false);
});

test("a version change with notes opens the card and waits for dismiss", () => {
  const plan = planChangelog({
    notes: "Line one\nLine two",
    currentVersion: "1.9.7",
    seenVersion: "1.9.6",
    hasUsedAppBefore: true,
  });
  assert.equal(plan.show, true);
  assert.equal(plan.markSeen, false);
});

test("the same version does not open the card again", () => {
  const plan = planChangelog({
    notes: "Line one",
    currentVersion: "1.9.7",
    seenVersion: "1.9.7",
    hasUsedAppBefore: true,
  });
  assert.equal(plan.show, false);
  assert.equal(plan.markSeen, false);
});

test("a missing app version does nothing", () => {
  const plan = planChangelog({
    notes: "Line one",
    currentVersion: "",
    seenVersion: null,
    hasUsedAppBefore: true,
  });
  assert.equal(plan.show, false);
  assert.equal(plan.markSeen, false);
});
