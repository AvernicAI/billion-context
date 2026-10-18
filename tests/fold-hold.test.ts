// #3003 deferred fold materialization — unit tests for the burst-hold gate.
// The proxy-level seam behavior (one materialization per burst on the wire)
// is pinned in tests/fold-hold-seam.test.ts; here we pin the gate itself:
// commit tracking, hold/materialize decision, pressure override, knob kill,
// and the view-state clone/restore roundtrip.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompressionState } from "acp-kernel";
import { createSession } from "../src/session.js";
import {
    FOLD_HOLD_PRESSURE_PCT,
    clearFoldHold,
    foldHoldPressure,
    heldFoldBlockIds,
    holdViewState,
    noteFoldCommit,
    resolvePrepareHold,
    restoreHeldBlocks,
} from "../src/fold-hold.js";

process.env.BILI_STATE_DIR = "/tmp/bili-test-fold-hold-state";

function freshSession() {
    return createSession(`s-${Math.random().toString(36).slice(2)}`);
}

function stateOf(...blockIds: string[]): CompressionState {
    return {
        nextBlockId: 1,
        blocks: blockIds.map((blockId) => ({ blockId, summary: `sum ${blockId}`, active: true, summaryTokens: 10, covered: [] })),
    } as unknown as CompressionState;
}

test("noteFoldCommit tracks commits; resolvePrepareHold holds the first post-commit leg, materializes the fold-free one", () => {
    const s = freshSession();
    delete process.env.BILI_DEFER_MATERIALIZATION;
    // No fold yet: nothing to hold.
    assert.equal(resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000 }).hold, false);
    // A committed fold arrives (default: hold enabled).
    noteFoldCommit(s, ["b1"]);
    assert.deepEqual([...heldFoldBlockIds(s)], ["b1"]);
    const logs: string[] = [];
    // First post-commit view build: burst leg — raw view.
    const a = resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000, log: (m) => logs.push(m) });
    assert.equal(a.hold, true);
    assert.deepEqual([...a.heldBlockIds], ["b1"]);
    // Second fold in the SAME burst: still holding (leg 2), both ids held.
    noteFoldCommit(s, ["b2"]);
    const b = resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000, log: (m) => logs.push(m) });
    assert.equal(b.hold, true);
    assert.deepEqual([...b.heldBlockIds].sort(), ["b1", "b2"]);
    // Fold-free request: materialize EVERYTHING held — the single seam.
    const c = resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000, log: (m) => logs.push(m) });
    assert.equal(c.hold, false);
    assert.equal(heldFoldBlockIds(s).size, 0);
    assert.ok(logs.some((l) => l.includes("holding 1 block(s)")));
    assert.ok(logs.some((l) => l.includes("leg 2")));
    assert.ok(logs.some((l) => l.includes("materialized 2 held block(s) after 2 burst leg(s) — one seam")));
});

test("window pressure materializes immediately even mid-burst", () => {
    const s = freshSession();
    noteFoldCommit(s, ["b1"]);
    // tokenCount at 0.9 of the limit → must not hold (raw view could overflow).
    const hot = resolvePrepareHold(s, { limit: 100_000, tokenCount: Math.floor(FOLD_HOLD_PRESSURE_PCT * 100_000) });
    assert.equal(hot.hold, false, "pressure materializes at >= 0.9x limit");
    assert.equal(heldFoldBlockIds(s).size, 0);
    // Just under the threshold still holds.
    noteFoldCommit(s, ["b2"]);
    const warm = resolvePrepareHold(s, { limit: 100_000, tokenCount: Math.floor(FOLD_HOLD_PRESSURE_PCT * 100_000) - 1 });
    assert.equal(warm.hold, true);
});

test("pressure helper: zero/undefined context never trips", () => {
    assert.equal(foldHoldPressure(0, 100_000), false, "uncalibrated tokenCount (0) never forces materialization");
    assert.equal(foldHoldPressure(10_000, 0), false, "unknown window never forces materialization");
    assert.equal(foldHoldPressure(95_000, 100_000), true);
});

test("BILI_DEFER_MATERIALIZATION=0 disables the hold entirely (eager materialization)", () => {
    const s = freshSession();
    process.env.BILI_DEFER_MATERIALIZATION = "0";
    try {
        noteFoldCommit(s, ["b1"]);
        assert.equal(heldFoldBlockIds(s).size, 0, "knob off: commit never lands in the hold set");
        assert.equal(resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000 }).hold, false);
    } finally {
        delete process.env.BILI_DEFER_MATERIALIZATION;
    }
});

test("holdFold:false (emergency folds) never enters the hold set", () => {
    const s = freshSession();
    noteFoldCommit(s, ["b9"], { hold: false });
    assert.equal(heldFoldBlockIds(s).size, 0);
    assert.equal(resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000 }).hold, false);
});

test("holdViewState/restoreHeldBlocks: view-only fiction — clone deactivates, restore reactivates, originals untouched", () => {
    const real = stateOf("b1", "b2", "b3");
    const held = new Set(["b2"]);
    const view = holdViewState(real, held);
    assert.equal(view.blocks[0], real.blocks[0], "untouched blocks keep identity (no clone churn)");
    assert.equal(view.blocks[1]!.active, false, "held block inactive in the view");
    assert.equal(view.blocks[2]!.active, true);
    assert.equal(real.blocks[1]!.active, true, "REAL state stays active (ledger is committed)");
    const restored = restoreHeldBlocks(view, held);
    assert.equal(restored.blocks[1]!.active, true);
    assert.deepEqual(restored.blocks.map((b) => b.blockId), ["b1", "b2", "b3"]);
});

test("hold state is per-session-object (fork/reload materializes by construction)", () => {
    const a = freshSession();
    noteFoldCommit(a, ["b1"]);
    const b = freshSession();
    assert.equal(heldFoldBlockIds(b).size, 0, "a sibling session object never inherits the hold");
    assert.equal(resolvePrepareHold(b, { limit: 100_000, tokenCount: 10_000 }).hold, false);
});

test("clearFoldHold spends the hold (loop refresh = materialization)", () => {
    const s = freshSession();
    noteFoldCommit(s, ["b1"]);
    clearFoldHold(s);
    assert.equal(heldFoldBlockIds(s).size, 0);
    assert.equal(resolvePrepareHold(s, { limit: 100_000, tokenCount: 10_000 }).hold, false);
});
