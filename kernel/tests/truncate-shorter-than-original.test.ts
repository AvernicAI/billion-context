import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import type { CoreMessage } from "../src/types.js";

// #3935: the emergency-truncation replacement must be STRICTLY shorter than
// the original. Just above keepPrefix+keepSuffix the fixed marker overhead
// made 4001~4063-char originals come out LONGER (4001 -> 4064), with
// negative savedTokens feeding the stuck-streak accounting backwards.

function msg(
  id: string,
  text: string,
  type: CoreMessage["contentType"] = "text",
): CoreMessage {
  return { id, role: "user", contentType: type, text };
}

const HOT = 96_000; // 96% usage vs limit 100_000 -> above default 0.95 gate

function runBand(len: number, fill = "L") {
  const cfg = defaultConfig(100_000);
  const messages = [
    msg("tr", fill.repeat(len), "tool-result"),
    msg("r1", "recent"),
    msg("r2", "recent"),
    msg("r3", "recent"),
  ];
  return truncateLargeToolOutputs(messages, HOT, cfg, defaultCountTokens, {});
}

test("no original in the 4001~4070 band ever comes out longer (#3935)", () => {
  for (let len = 4001; len <= 4070; len++) {
    const r = runBand(len);
    const after = r.messages[0]!.text!;
    assert.ok(
      after.length <= len,
      `len=${len}: replacement ${after.length} chars must not exceed original`,
    );
    if (r.truncatedCount === 1) {
      assert.ok(
        after.length < len,
        `len=${len}: truncated replacement ${after.length} must be strictly shorter`,
      );
      assert.ok(
        r.savedTokens > 0,
        `len=${len}: savedTokens ${r.savedTokens} must be positive`,
      );
      assert.ok(after.includes("[truncated for context space"));
    } else {
      assert.equal(r.savedTokens, 0);
      assert.equal(
        after,
        "L".repeat(len),
        `len=${len}: untruncated stays verbatim`,
      );
    }
  }
});

test("band floor still truncates: 4001 and 4061-char outputs shrink", () => {
  for (const len of [4001, 4061]) {
    const r = runBand(len);
    assert.equal(r.truncatedCount, 1, `len=${len}: valve must still fire`);
    assert.ok(r.messages[0]!.text!.length < len);
    assert.ok(r.savedTokens > 0);
  }
});

test("CJK band output truncates and saves tokens", () => {
  const r = runBand(4001, "字");
  assert.equal(r.truncatedCount, 1);
  const after = r.messages[0]!.text!;
  assert.ok(after.length < 4001);
  assert.ok(r.savedTokens > 0);
  assert.ok(after.includes("[truncated for context space"));
});

test("outside the band the replacement is byte-identical to the legacy formula", () => {
  const r = runBand(10_000);
  assert.equal(r.truncatedCount, 1);
  const marker =
    "\n\n...[truncated for context space] — original ~2500 tokens]...\n\n";
  const expected = "L".repeat(2000) + marker + "L".repeat(2000);
  assert.equal(r.messages[0]!.text, expected);
  assert.equal(
    r.savedTokens,
    defaultCountTokens("L".repeat(10_000)) - defaultCountTokens(expected),
  );
});

test("token guard: no token saving means no truncation (non-monotonic estimator)", () => {
  const cfg = defaultConfig(100_000);
  const original = "L".repeat(4001);
  const messages = [
    msg("tr", original, "tool-result"),
    msg("r1", "recent"),
    msg("r2", "recent"),
    msg("r3", "recent"),
  ];
  const r = truncateLargeToolOutputs(messages, HOT, cfg, () => 5, {
    minOutputTokens: 5,
  });
  assert.equal(r.candidatesFound, 1);
  assert.equal(r.truncatedCount, 0);
  assert.equal(r.savedTokens, 0);
  assert.equal(r.messages[0]!.text, original);
});

test("multiple band candidates: every applied candidate keeps accounting positive", () => {
  const cfg = defaultConfig(100_000);
  const messages = [
    msg("b1", "L".repeat(4001), "tool-result"),
    msg("b2", "L".repeat(4001), "tool-result"),
    msg("b3", "L".repeat(4001), "tool-result"),
    msg("r1", "recent"),
    msg("r2", "recent"),
    msg("r3", "recent"),
  ];
  const r = truncateLargeToolOutputs(
    messages,
    HOT,
    cfg,
    defaultCountTokens,
    {},
  );
  assert.equal(r.truncatedCount, 3);
  assert.ok(r.savedTokens > 0, `savedTokens=${r.savedTokens}`);
  for (const i of [0, 1, 2]) {
    assert.ok(r.messages[i]!.text!.length < 4001);
  }
});

test("processTurn at 96%: band tool-result shrinks, no false 'unsavable' diagnostic", () => {
  const core = createCore();
  const cfg = defaultConfig(100_000);
  const messages: CoreMessage[] = [
    msg("sys", "S".repeat(80_000), "system"),
    msg("tr", "L".repeat(4001), "tool-result"),
    msg("u1", "hi"),
    msg("a1", "ok", "assistant"),
    msg("u2", "next"),
    msg("a2", "done", "assistant"),
    msg("u3", "again"),
  ];
  // renderTags:"none" compares at the kernel-text layer; the render pass adds
  // a per-message ref-tag wrapper independent of truncation.
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: HOT,
    renderTags: "none",
  });
  const tr = result.messages.find((m) => m.id === "tr")!;
  assert.ok(tr.text!.includes("[truncated for context space"));
  assert.ok(tr.text!.length < 4001);
  assert.equal(result.truncationSkipped, undefined);
  assert.equal(result.state.terminalStreak, 0);
});
