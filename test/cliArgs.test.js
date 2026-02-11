import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, parseBooleanArg } from "../dist/cliArgs.js";

test("parseBooleanArg handles explicit false string values", () => {
  assert.equal(parseBooleanArg("false"), false);
  assert.equal(parseBooleanArg("0"), false);
  assert.equal(parseBooleanArg("off"), false);
  assert.equal(parseBooleanArg("no"), false);
});

test("parseBooleanArg handles explicit true string values", () => {
  assert.equal(parseBooleanArg("true"), true);
  assert.equal(parseBooleanArg("1"), true);
  assert.equal(parseBooleanArg("on"), true);
  assert.equal(parseBooleanArg("yes"), true);
});

test("parseArgv + parseBooleanArg regression: --stripQuoted false is false", () => {
  const { cmd, args } = parseArgv([
    "node",
    "dist/cli.js",
    "summary",
    "--url",
    "https://lore.kernel.org/r/foo@example.com/",
    "--stripQuoted",
    "false",
  ]);
  assert.equal(cmd, "summary");
  assert.equal(parseBooleanArg(args.stripQuoted, true), false);
});
