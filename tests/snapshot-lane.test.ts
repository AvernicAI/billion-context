import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, createInitialState, defaultConfig, type CompressionBlock, type CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { foldCoverage } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { alignKeyOf, pinSnapshotIds, __resetSnapshotLaneForTests } from "../src/snapshot-lane.ts";
import { rmrf } from "./tmp-rm.ts";

// #2671-style hermeticity: pin config + state dir before any store or rollout
// touch; feature forced ON per-test-file (the one gate-off test unsets it).
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-snaplane-cfg-")),
    "no-config.json",
);
process.env.BILI_STATE_DIR = mkdtempSync(path.join(tmpdir(), "bili-snaplane-state-"));
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_ROLLOUT_PROXY_SNAPSHOT_LANE = "1";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://up:1", title: "snapshot lane test" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 1000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function mkText(id: string, n: number): BiliMessage {
    return { id, role: n % 2 === 0 ? "user" : "assistant", contentType: "text", text: `snap message ${n} ${"z".repeat(48)}` };
}

function mkBlock(ids: string[]): CompressionBlock {
    return {
        blockId: `blk-${ids[0]}`,
        runId: "run-1",
        tier: 1,
        summary: "s",
        directMessageIds: [],
        effectiveMessageIds: ids,
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

type Log = [string, string];

/** Hermetic shadow-mode store with `cores` ingested as the session's raw tail
 *  (writeNow mirrors the production #3007 ingest), pointed at by getStore(). */
async function seedStore(dir: string, sessionId: string, cores: BiliMessage[]): Promise<SessionStore> {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    _setStoreForTest(store);
    const session = makeSession(sessionId);
    session.lastMessages = cores as CoreMessage[];
    await store.writeNow(session);
    if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = prev;
    return store;
}

function storedIds(store: SessionStore, sessionId: string): string[] {
    const rows = store.unifiedRawMessages(sessionId);
    assert.ok(rows, "unified raw rows must exist after seed");
    return [...rows!].sort((a, b) => a.seq - b.seq).map((r) => (JSON.parse(r.content) as BiliMessage).id);
}

function pin(sessionId: string, state: ReturnType<typeof createInitialState>, msgs: BiliMessage[], extra?: Partial<{ pluginMode: boolean; protocol: string }>): { out: BiliMessage[]; logs: Log[] } {
    const logs: Log[] = [];
    const out = pinSnapshotIds({
        sessionId,
        protocol: extra?.protocol ?? "anthropic",
        pluginMode: extra?.pluginMode ?? false,
        msgs,
        state,
        log: (level, msg) => { logs.push([level, msg]); },
    });
    return { out, logs };
}

test("alignKeyOf: dialect-neutral (toolCallId excluded), content-sensitive (#3642 doctrine)", () => {
    const base = mkText("h_a", 1);
    const reminted: BiliMessage = { ...base, id: "h_other", toolCallId: "call_abc" };
    assert.equal(alignKeyOf(base), alignKeyOf(reminted), "id/toolCallId churn must not change the alignment key");
    assert.notEqual(alignKeyOf(base), alignKeyOf(mkText("h_b", 2)), "different text → different key");
    assert.notEqual(alignKeyOf(base), alignKeyOf({ ...base, role: base.role === "user" ? "assistant" : "user" }), "different role → different key");
    const imgA: BiliMessage = { ...base, imageBase64: "aWFtYWdlQ" };
    const imgB: BiliMessage = { ...base, imageBase64: "aW1hZ2VC" };
    assert.notEqual(alignKeyOf(imgA), alignKeyOf(imgB), "image sidecar differences must not collide");
});

test("gates: feature off / plugin mode / empty view pass through the SAME reference", () => {
    const state = createInitialState();
    const msgs = [mkText("h_a", 1)];
    const saved = process.env.BILI_ROLLOUT_PROXY_SNAPSHOT_LANE;
    delete process.env.BILI_ROLLOUT_PROXY_SNAPSHOT_LANE;
    try {
        assert.equal(pin("snap-gate-off", state, msgs).out, msgs, "feature off → untouched ref");
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_PROXY_SNAPSHOT_LANE;
        else process.env.BILI_ROLLOUT_PROXY_SNAPSHOT_LANE = saved;
    }
    assert.equal(pin("snap-plugin", state, msgs, { pluginMode: true }).out, msgs, "plugin mode → untouched ref");
    const empty: BiliMessage[] = [];
    assert.equal(pin("snap-empty", state, empty).out, empty, "empty view → untouched ref");
});

test("legacy storage: passthrough + info-once fallback note", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-legacy-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        _setStoreForTest(store);
        const state = createInitialState();
        const msgs = [mkText("h_a", 1), mkText("h_b", 2)];
        const first = pin("snap-legacy-1", state, msgs);
        assert.equal(first.out, msgs, "legacy-only instance → untouched ref");
        assert.ok(first.logs.some(([lvl, m]) => lvl === "info" && /snapshot/i.test(m)), "first call must log the fallback once");
        assert.equal(first.logs.filter(([lvl]) => lvl === "info").length, 1);
        const second = pin("snap-legacy-1", state, msgs);
        assert.equal(second.out, msgs);
        assert.equal(second.logs.length, 0, "second call of the same session must stay quiet");
        store.closeQuietly();
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

test("APPEND: steady-state tail growth stamps the prefix and keeps client bytes verbatim", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-append-"));
    try {
        const a = mkText("h_a", 1), b = mkText("h_b", 2), c = mkText("h_c", 3);
        const store = await seedStore(dir, "snap-append", [a, b, c]);
        assert.deepEqual(storedIds(store, "snap-append"), ["h_a", "h_b", "h_c"], "ingest must preserve explicit ids verbatim");
        const resent = [mkText("p_a", 1), mkText("p_b", 2), mkText("p_c", 3), mkText("p_d", 4)];
        const { out } = pin("snap-append", createInitialState(), resent);
        assert.deepEqual(out.map((m) => m.id), ["h_a", "h_b", "h_c", "p_d"], "prefix pinned to stored ids, tail keeps its own");
        assert.deepEqual(out.map((m) => m.text), resent.map((m) => m.text), "client bytes verbatim (cache-stable)");
        // Durability: appended rows ride the production save path (#3007
        // rawTail ingest on writeNow) — simulate the post-turn save.
        const after = makeSession("snap-append");
        after.lastMessages = [a, b, c, resent[3]] as CoreMessage[];
        await store.writeNow(after);
        assert.deepEqual(storedIds(store, "snap-append"), ["h_a", "h_b", "h_c", "p_d"], "appended tail persisted via the normal save path");
        store.closeQuietly();
    } finally {
        rmrf(dir);
    }
});

test("TRUNCATE (uncovered rewind): registry clamps to the client's prefix", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-trunc-"));
    try {
        const store = await seedStore(dir, "snap-trunc", [mkText("h_a", 1), mkText("h_b", 2), mkText("h_c", 3)]);
        const resent = [mkText("p_a", 1), mkText("p_b", 2)];
        const { out } = pin("snap-trunc", createInitialState(), resent);
        assert.deepEqual(out.map((m) => m.id), ["h_a", "h_b"]);
        const reg = store.getSessionExt("snap-trunc", "snap:reg") as { ids: string[] };
        assert.deepEqual(reg.ids, ["h_a", "h_b"], "dead uncovered tail dropped from the registry");
        store.closeQuietly();
    } finally {
        rmrf(dir);
    }
});

test("TRUNCATE into covered region: covered rows stay server-authoritative in view AND registry", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-trunc-cover-"));
    try {
        const store = await seedStore(dir, "snap-trunc-cov", [mkText("h_a", 1), mkText("h_b", 2), mkText("h_c", 3)]);
        const state = createInitialState();
        state.blocks.push(mkBlock(["h_c"]));
        const resent = [mkText("p_a", 1), mkText("p_b", 2)];
        const { out } = pin("snap-trunc-cov", state, resent);
        // Only the covered row was rewound past → APPEND shape (dead tail fully
        // covered): the covered row must stay in the outbound view (its id must
        // remain visible to the kernel or the block unfolds).
        assert.deepEqual(out.map((m) => m.id), ["h_a", "h_b", "h_c"], "covered row survives the client rewind (server authority over the covered region)");
        const rowsCov = store.unifiedRawMessages("snap-trunc-cov");
        assert.ok(rowsCov, "rows exist");
        assert.deepEqual(out[2], JSON.parse(rowsCov[2].content), "covered row rendered from the stored snapshot core");
        store.closeQuietly();
    } finally {
        rmrf(dir);
    }
});

test("REPLACE: foreign checkpoint head absorbed (observed, never forwarded); next turn re-verifies it", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-replace-"));
    try {
        const cores = [mkText("h_a", 1), mkText("h_b", 2), mkText("h_c", 3), mkText("h_d", 4), mkText("h_e", 5), mkText("h_f", 6)];
        const store = await seedStore(dir, "snap-replace", cores);
        const state = createInitialState();
        state.blocks.push(mkBlock(["h_c", "h_d", "h_e", "h_f"]));
        const ckpt = (): BiliMessage => ({ id: "ckpt-1", role: "user", contentType: "text", text: "full checkpoint replacement blob" });
        // Turn 1: client replaces its whole history with checkpoint + fresh
        // copies of the last three messages (new wire ids, same content).
        const t1 = [ckpt(), mkText("q_d", 4), mkText("q_e", 5), mkText("q_f", 6)];
        const r1 = pin("snap-replace", state, t1);
        assert.deepEqual(r1.out.map((m) => m.id), ["h_c", "h_d", "h_e", "h_f"], "outbound = server snapshot only; checkpoint NOT forwarded");
        assert.ok(!r1.out.some((m) => m.text === "full checkpoint replacement blob"), "checkpoint content must never reach the outbound");
        assert.ok(r1.logs.some(([lvl, m]) => lvl === "info" && /absorbed/i.test(m)), "absorption is reported once at info level");
        // Turn 2: same checkpoint head again + one brand-new tail message.
        const t2 = [ckpt(), mkText("r_d", 4), mkText("r_e", 5), mkText("r_f", 6), mkText("r_g", 7)];
        const r2 = pin("snap-replace", state, t2);
        assert.deepEqual(r2.out.map((m) => m.id), ["h_c", "h_d", "h_e", "h_f", "r_g"], "head marker verified → checkpoint excluded, tail appended");
        assert.ok(!r2.out.some((m) => m.id === "ckpt-1"));
        // APPEND deliberately does NOT rewrite the registry ext — appended rows
        // ride the production save path + seq filter. Simulate the post-turn
        // save, then prove restart determinism via a cold re-seed.
        const reg = store.getSessionExt("snap-replace", "snap:reg") as { ids: string[] };
        assert.deepEqual(reg.ids, ["h_c", "h_d", "h_e", "h_f"], "ext still holds the REPLACE write; append rides rawTail");
        const saved = makeSession("snap-replace");
        saved.lastMessages = r2.out as CoreMessage[];
        await store.writeNow(saved);
        __resetSnapshotLaneForTests();
        // g re-mints its wire id (s_g) after the upgrade — the lane must pin it
        // back to the id frozen at ingest (r_g), exactly acceptance ①.
        const r3 = pin("snap-replace", state, [ckpt(), mkText("s_d", 4), mkText("s_e", 5), mkText("s_f", 6), mkText("s_g", 7)]);
        assert.deepEqual(r3.out.map((m) => m.id), ["h_c", "h_d", "h_e", "h_f", "r_g"], "cold re-seed recovers the appended tail and pins its frozen id across the re-mint");
        store.closeQuietly();
    } finally {
        rmrf(dir);
    }
});

test("bails: mid-insert / short-tail / dup-append all return the input untouched", async () => {
    __resetSnapshotLaneForTests();
    const dirs: string[] = [];
    let store: SessionStore | null = null;
    try {
        const d1 = mkdtempSync(path.join(tmpdir(), "bili-snaplane-bail1-"));
        dirs.push(d1);
        store = await seedStore(d1, "snap-bail-mid", [mkText("h_a", 1), mkText("h_b", 2), mkText("h_c", 3)]);
        const midInsert: BiliMessage[] = [mkText("p_a", 1), { id: "x-mid", role: "user", contentType: "text", text: "inserted middle message" }, mkText("p_b", 2), mkText("p_c", 3)];
        assert.equal(pin("snap-bail-mid", createInitialState(), midInsert).out, midInsert, "mid-insert (uncovered remainder both sides) → passthrough");

        const d2 = mkdtempSync(path.join(tmpdir(), "bili-snaplane-bail2-"));
        dirs.push(d2);
        store = await seedStore(d2, "snap-bail-short", [mkText("h_a", 1), mkText("h_b", 2), mkText("h_c", 3)]);
        const shortTail: BiliMessage[] = [{ id: "x-head", role: "user", contentType: "text", text: "some foreign head" }, mkText("p_c", 3)];
        assert.equal(pin("snap-bail-short", createInitialState(), shortTail).out, shortTail, "matched suffix < 3 → passthrough");

        // dup-append: the whole registry is covered (so APPEND is reached),
        // but the resent tail re-presents unaligned registry content under new
        // ids — a checkpoint-shaped rewrite, ambiguous as an append; bail.
        const d3 = mkdtempSync(path.join(tmpdir(), "bili-snaplane-bail3-"));
        dirs.push(d3);
        store = await seedStore(d3, "snap-bail-dup", [mkText("h_a", 1), mkText("h_b", 2)]);
        const stateDup = createInitialState();
        stateDup.blocks.push(mkBlock(["h_a", "h_b"]));
        const dupAppend: BiliMessage[] = [{ id: "x-h", role: "user", contentType: "text", text: "foreign head" }, mkText("p_a", 1), mkText("p_b", 2)];
        assert.equal(pin("snap-bail-dup", stateDup, dupAppend).out, dupAppend, "dup-append collision → passthrough");
    } finally {
        store?.closeQuietly();
        for (const d of dirs) rmrf(d);
    }
});

// #3752 replay: an identity-function swap (kernel upgrade re-seeding every
// content hash) mass-unfolded persisted sessions because each turn re-derived
// historical ids from client-resent bytes. With the snapshot lane engaged the
// historical ids come from the store instead — coverage survives and the
// outbound stays byte-stable. The unpinned control leg proves the drift is
// real without the lane.
test("identity swap (acceptance 1+4): pinned resend keeps coverage, outbound byte-stable; unpinned control drifts", async () => {
    __resetSnapshotLaneForTests();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-snaplane-swap-"));
    try {
        const session = makeSession("snap-swap");
        const core = createCore();
        const config = defaultConfig(200000);
        const mkOld = (i: number): CoreMessage => ({ id: `h_old${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
        const oldMsgs: CoreMessage[] = [];
        for (let i = 0; i < 24; i++) oldMsgs.push(mkOld(i));
        const turn0 = core.processTurn({ messages: oldMsgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
        session.state = turn0.state;
        const res0 = core.applyCompression({
            ranges: [{ startRef: "m00001", endRef: "m00007", summary: "compressed early history that is long enough to pass the min summary length check" }],
            messages: turn0.messages,
            state: turn0.state,
            config,
        });
        session.state = res0.state;
        const block = session.state.blocks[session.state.blocks.length - 1];
        assert.ok(block.active, "fixture block must be active");
        const coveredIds = [...block.effectiveMessageIds];
        assert.ok(coveredIds.length > 0, "fixture block must cover message ids");

        const store = await seedStore(dir, "snap-swap", oldMsgs as BiliMessage[]);
        assert.deepEqual(storedIds(store, "snap-swap"), oldMsgs.map((m) => m.id));
        const coveredBefore = new Set(coveredIds);

        // Leg A — steady state today (same ids, lane engaged): baseline render.
        const stateA = structuredClone(session.state);
        const legA = pin("snap-swap", stateA, oldMsgs.map((m) => ({ ...m })) as BiliMessage[]);
        assert.deepEqual(legA.out.map((m) => m.id), oldMsgs.map((m) => m.id));
        const turnA = core.processTurn({ messages: legA.out, state: stateA, config, tokenCount: 9999, renderTags: "text-only" });

        // Leg B — identity swap (every historical id re-minted by the "new"
        // kernel): pinning must restore the stored ids before processTurn.
        const swapped = oldMsgs.map((m, i) => ({ ...m, id: `h_new${i}` })) as BiliMessage[];
        const stateB = structuredClone(session.state);
        const legB = pin("snap-swap", stateB, swapped);
        assert.deepEqual(legB.out.map((m) => m.id), oldMsgs.map((m) => m.id), "historical ids pinned to the snapshot despite the identity swap");
        assert.deepEqual(legB.out.map((m) => m.text), swapped.map((m) => m.text), "client bytes stay verbatim");
        assert.equal(foldCoverage(coveredBefore, legB.out.map((m) => m.id)), null, "coverage intact after pinning");
        const turnB = core.processTurn({ messages: legB.out, state: stateB, config, tokenCount: 9999, renderTags: "text-only" });
        const blockAfter = turnB.state.blocks[turnB.state.blocks.length - 1];
        assert.equal(blockAfter.active, true, "block must survive the swapped resend");

        // Leg C — control: the same swapped resend WITHOUT the lane.
        const stateC = structuredClone(session.state);
        core.processTurn({ messages: swapped, state: stateC, config, tokenCount: 9999, renderTags: "text-only" });
        const gapC = foldCoverage(coveredBefore, swapped.map((m) => m.id));
        assert.ok(gapC !== null, "unpinned swapped resend must show a coverage gap");
        assert.equal(gapC.matched, 0, "no covered id survives the identity swap without pinning");

        assert.deepEqual(JSON.stringify(turnA.messages), JSON.stringify(turnB.messages), "outbound byte-stable across the identity swap (acceptance 1+4)");
        store.closeQuietly();
    } finally {
        rmrf(dir);
    }
});
