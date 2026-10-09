import assert from "node:assert/strict";
import test from "node:test";
import { tLocale } from "../src/lib/i18n.ts";
import { isAttackSide, localeForGame, modeI18nKey } from "../src/lib/matchLabels.ts";

test("turkish client locale maps swiftplay to Tamgaz and sides to Turkish", () => {
  const locale = localeForGame("tr_TR", "en");
  assert.equal(locale, "tr");
  assert.equal(tLocale(locale, modeI18nKey("swiftplay", "Swiftplay")!), "Tamgaz");
  assert.equal(tLocale(locale, isAttackSide("SALDIRAN") ? "side.attack" : "side.defense"), "Saldıran");
  assert.equal(tLocale(locale, isAttackSide("SAVUNAN") ? "side.attack" : "side.defense"), "Defans");
});

test("english client locale keeps Swiftplay and ATK/DEF even if the overlay is Turkish", () => {
  const locale = localeForGame("en_US", "tr");
  assert.equal(locale, "en");
  assert.equal(tLocale(locale, modeI18nKey(null, "Swiftplay")!), "Swiftplay");
  assert.equal(tLocale(locale, isAttackSide("ATTACK") ? "side.attack" : "side.defense"), "ATK");
  assert.equal(tLocale(locale, isAttackSide("DEF") ? "side.attack" : "side.defense"), "DEF");
});

test("missing client locale follows the overlay language", () => {
  assert.equal(localeForGame(null, "tr"), "tr");
  assert.equal(localeForGame("", "en"), "en");
});
