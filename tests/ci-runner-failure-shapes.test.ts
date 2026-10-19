// #3665: unit coverage for the CI runner's failed-phase classifier
// (scripts/ci-failure-shapes.mjs), which decides whether a red shard gets its
// one bounded full-retry or fails hard. Gate discipline (#3617): every
// recoverable shape asserts BOTH directions — "retried when it should" AND
// "NOT retried when it should not". The synthetic TAP mirrors the exact shapes
// observed in the windows-latest flakes: the file-level 'test failed' silent
// death (#3029) and the fail-0/cancelled>0 event-loop-drain tail (#3665).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classifyPhaseFailure,
    describeRetryOutcome,
    extractSwallowedFiles,
    extractTapCounts,
} from "../scripts/ci-failure-shapes.mjs";

const baseToFile = new Map([
    ["issue1993-preflight-400.test.ts", "tests/issue1993-preflight-400.test.ts"],
    ["lane-decisions-matrix.test.ts", "tests/lane-decisions-matrix.test.ts"],
]);

const CONCRETE_TAP = [
    "TAP version 13",
    "# Subtest: preflight rejects malformed proxy args",
    "not ok 1 - preflight rejects malformed proxy args",
    "  ---",
    "  duration_ms: 12.3",
    "  failureType: 'testCodeError'",
    "  code: 'ERR_ASSERTION'",
    "  error: 'expected 400, got 200'",
    "  operator: 'strictEqual'",
    "  stack: |-",
    "    TestContext.<anonymous> (file:///tests/x.test.ts:10:15)",
    "  ...",
    "1..1",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 4567",
].join("\n");

// The exact #3665 signature: subtests lost to event-loop drain, zero assertion
// failures, non-zero exit.
const DRAIN_TAP = [
    "TAP version 13",
    "ok 1 - preflight accepts well-formed proxy args",
    "  ---",
    "  duration_ms: 4812.1",
    "  ...",
    "not ok 2 - preflight rejects malformed proxy args",
    "  ---",
    "  duration_ms: 0",
    "  failureType: 'cancelledByParent'",
    "  error: 'Promise resolution is still pending but the event loop has already resolved'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "1..5",
    "# pass 4352",
    "# fail 0",
    "# cancelled 5",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 612345",
].join("\n");

// The exact #3029 signature: a file-level entry whose only payload is
// 'test failed' — the child died before reporting any of its subtests.
const SWALLOWED_TAP = [
    "TAP version 13",
    "ok 1 - some surviving top-level test",
    "  ---",
    "  duration_ms: 3.2",
    "  ...",
    "not ok 2 - issue1993-preflight-400.test.ts",
    "  ---",
    "  duration_ms: 61000.4",
    "  timing:",
    "    enqueue: 0.01",
    "    start: 1.0",
    "    end: 61001.4",
    "  performance: false",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "1..2",
    "# pass 100",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 90000",
].join("\n");

test("concrete assertion failure -> concrete (never retried)", () => {
    const v = classifyPhaseFailure(CONCRETE_TAP, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("event-loop-drain tail (fail 0, cancelled > 0) -> cancelled-drain (retried once)", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    assert.equal(v.kind, "cancelled-drain");
    assert.deepEqual(v.counts, { pass: 4352, fail: 0, cancelled: 5 });
});

test("swallowed file-level death -> swallowed with the exact file list", () => {
    const v = classifyPhaseFailure(SWALLOWED_TAP, baseToFile);
    assert.equal(v.kind, "swallowed");
    assert.deepEqual(v.files, ["tests/issue1993-preflight-400.test.ts"]);
});

test("real failure alongside drain cancellations -> concrete (a real regression is never masked)", () => {
    const mixed = CONCRETE_TAP.replace("# cancelled 0", "# cancelled 3");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("swallowed death alongside drain cancellations -> swallowed (existing path keeps priority)", () => {
    const mixed = SWALLOWED_TAP.replace("# cancelled 0", "# cancelled 2");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "swallowed");
});

test("no TAP tail at all (child died before summarizing) -> concrete (no evidence, no retry)", () => {
    assert.equal(classifyPhaseFailure("", baseToFile).kind, "concrete");
    assert.equal(classifyPhaseFailure("garbage without any summary\n", baseToFile).kind, "concrete");
});

test("green-looking tail (fail 0, cancelled 0) is NOT a recoverable shape on its own", () => {
    const v = classifyPhaseFailure(DRAIN_TAP.replace("# cancelled 5", "# cancelled 0"), baseToFile);
    assert.equal(v.kind, "concrete");
});

test("extractSwallowedFiles ignores file-level entries whose basename is not a known test file", () => {
    const out = SWALLOWED_TAP.replace("issue1993-preflight-400.test.ts", "some-random-name.test.ts");
    assert.deepEqual(extractSwallowedFiles(out, baseToFile), []);
});

// The retry runs on the SAME runner, so a reproduced drain signature must be
// reported as a persistent infrastructure condition (rerun draws a fresh
// runner), never as "genuine failure" — the #3665 round-2 log mislabelled it.
test("reproduced drain on retry -> persistent-condition message, NOT 'genuine failure'", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /persistent condition on this runner/);
    assert.match(msg, /pass=4352 fail=0 cancelled=5/);
    assert.match(msg, /fresh runner \(#3665\)/);
    assert.doesNotMatch(msg, /genuine failure/);
});

test("swallowed death on retry -> genuine failure naming the files, no fresh-runner hint", () => {
    const v = classifyPhaseFailure(SWALLOWED_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /genuine failure, not a flake/);
    assert.match(msg, /issue1993-preflight-400\.test\.ts/);
    assert.doesNotMatch(msg, /fresh runner/);
});

test("concrete assertion failures on retry -> genuine failure with the count, no fresh-runner hint", () => {
    const v = classifyPhaseFailure(CONCRETE_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /1 concrete assertion failure\(s\)/);
    assert.match(msg, /genuine failure, not a flake/);
    assert.doesNotMatch(msg, /fresh runner/);
    assert.doesNotMatch(msg, /persistent condition/);
});

test("retry with no recognizable TAP shape at all -> genuine failure (no evidence of drain)", () => {
    const v = classifyPhaseFailure("", baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /genuine failure, not a flake/);
    assert.doesNotMatch(msg, /fresh runner/);
});

test("extractTapCounts: missing '# cancelled' line defaults to 0; indented lookalikes are not metadata", () => {
    const noCancelled = DRAIN_TAP.split("\n").filter((l) => l !== "# cancelled 5").join("\n");
    assert.deepEqual(extractTapCounts(noCancelled), { pass: 4352, fail: 0, cancelled: 0 });
    const indented = "ok 1 - x\n  # fail 9\n  # pass 8\n" + DRAIN_TAP;
    // the real tail still wins: first column-0 match per label
    const c = extractTapCounts(indented);
    assert.ok(c !== null && c.fail === 0 && c.pass === 4352);
    assert.equal(extractTapCounts("no summary here"), null);
});
