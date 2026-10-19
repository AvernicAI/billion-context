// #3831 sub-defect b: lazy label adoption must CONVERGE the unified index row
// (migrate old-id -> label), not mint a duplicate. One conversation carrying
// two rows is permanent ballast otherwise: double byte accounting, double
// listing, split-brain eviction, and a stale boot entry once the historical
// file stops aliasing. Gate discipline (#3617): every positive convergence
// case has its negative twin (sole rows survive, plain sessions untouched).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, _resetSessionsForTest } from "../src/session.ts";

type ShadowProbe = {
    listSessionIds(): string[];
    importRecord(record: unknown): unknown;
};

function shadowOf(store: SessionStore): ShadowProbe | undefined {
    return (store as unknown as { shadow?: ShadowProbe }).shadow;
}

function indexRows(store: SessionStore): string[] {
    return [...(shadowOf(store)?.listSessionIds() ?? [])].sort();
}

/** Multi-boot fixture: each makeStore() call closes the previous store and
 *  opens a fresh one on the SAME dir (fresh process posture), with the
 *  global session map reset between incarnations. Full mode is pinned
 *  explicitly so the suite does not depend on the default flip. */
async function multiBootFixture(run: (dir: string, makeStore: () => SessionStore) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3831b-"));
    const dir = path.join(root, "sessions");
    const previous = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    // Object wrapper: a bare `let` captured by the makeStore closure gets
    // narrowed to its initial null by control-flow analysis.
    const live = { store: null as SessionStore | null };
    try {
        await run(dir, () => {
            live.store?.closeQuietly();
            _resetSessionsForTest(256, 512 * 1024 * 1024);
            live.store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            _setStoreForTest(live.store);
            return live.store;
        });
    } finally {
        live.store?.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previous;
        rmSync(root, { recursive: true, force: true });
    }
}

/** A non-orphan folded session under a derived id with a native label: every
 *  blockContents key has a state.blocks slot, so the unified ingest accepts
 *  it (the orphan-skipped shapes are sub-defect a's territory, #3819). */
function labeledFoldedSession(id: string, label: string) {
    const session = createSession(id, { label });
    session.state.messageRefs.byRaw["old-message"] = "m00001";
    session.state.messageRefs.byRef["m00001"] = "old-message";
    session.state.blocks.push({
        blockId: "b1",
        runId: "r1",
        tier: 1,
        summary: "folded summary",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 10,
        createdAt: 1000,
        survivedCount: 0,
        generation: "young",
        active: true,
    });
    session.blockContents.set("b1", { one: null, full: { text: "legacy original\r\n", count: 1 } });
    return session;
}

test("label adoption migrates the pre-adoption index row instead of minting a duplicate (#3831)", async () => {
    await multiBootFixture(async (dir, makeStore) => {
        const store = makeStore();
        const session = labeledFoldedSession("old-derived-id", "ses_native_id");
        await store.writeNow(session);
        assert.deepEqual(indexRows(store), ["old-derived-id"], "pre-adoption: sole row under the derived id");
        const file = path.join(dir, relPathFor(session.id));
        const before = readFileSync(file);
        const loaded = await store.boot({ maxSessions: 8, maxBytes: 40_000 });
        const adopted = store.loadSync("ses_native_id");
        assert.equal(adopted?.id, "ses_native_id");
        assert.deepEqual(adopted?.blockContents.get("b1"), session.blockContents.get("b1"));
        assert.deepEqual(indexRows(store), ["ses_native_id"], "adoption converged the row; no duplicate under the old id");
        assert.ok(loaded.has("ses_native_id") && !loaded.has("old-derived-id"), "boot map carries the label, not the dead id");
        assert.deepEqual(readFileSync(file), before, "#2803: the historical file stays byte-stable");
    });
});

test("second boot keeps one row per adopted session — the twin file never re-imports (#3831)", async () => {
    await multiBootFixture(async (dir, makeStore) => {
        const store = makeStore();
        const session = labeledFoldedSession("old-derived-id", "ses_native_id");
        await store.writeNow(session);
        const file = path.join(dir, relPathFor(session.id));
        const before = readFileSync(file);
        await store.boot({ maxSessions: 8, maxBytes: 40_000 });
        const adopted = store.loadSync("ses_native_id");
        adopted!.stats.requests = 8;
        await store.writeNow(adopted!); // canonical L.json written beside X.json
        assert.ok(readFileSync(path.join(dir, relPathFor("ses_native_id"))), "canonical copy exists after the post-adoption save");

        const store2 = makeStore();
        const loaded = await store2.boot({ maxSessions: 8, maxBytes: 40_000 });
        assert.deepEqual(indexRows(store2), ["ses_native_id"], "no resurrection of the pre-adoption row on boot 2");
        assert.ok(loaded.has("ses_native_id") && !loaded.has("old-derived-id"));
        assert.equal(loaded.get("ses_native_id")?.stats.requests, 8, "boot 2 serves the fresh label entry");
        assert.deepEqual(readFileSync(file), before, "#2803: the historical file is still byte-stable");
    });
});

test("boot heals a pre-existing adoption duplicate minted by pre-fix code (#3831)", async () => {
    await multiBootFixture(async (dir, makeStore) => {
        const store = makeStore();
        const session = labeledFoldedSession("old-derived-id", "ses_native_id");
        await store.writeNow(session);
        // Simulate the pre-fix adoption: the label row was imported from the
        // remapped payload while the old-id row was left behind.
        const raw = JSON.parse(readFileSync(path.join(dir, relPathFor(session.id)), "utf8")) as { payload: Record<string, unknown> };
        assert.ok(shadowOf(store)!.importRecord({ ...raw.payload, id: "ses_native_id" }), "label row imports");
        assert.deepEqual(indexRows(store), ["old-derived-id", "ses_native_id"], "duplicate state reconstructed");

        const store2 = makeStore();
        await store2.boot({ maxSessions: 8, maxBytes: 40_000 });
        assert.deepEqual(indexRows(store2), ["ses_native_id"], "stale pre-adoption row healed at boot");
        assert.equal(store2.loadSync("ses_native_id")?.id, "ses_native_id", "label resume still works after healing");
    });
});

test("a sole pre-adoption row survives boot until it is actually adopted (#3831)", async () => {
    await multiBootFixture(async (_dir, makeStore) => {
        const store = makeStore();
        const session = createSession("pending-id", { label: "ses_pending" });
        session.state.messageRefs.byRaw["pending-message"] = "m00001";
        session.state.messageRefs.byRef["m00001"] = "pending-message";
        await store.writeNow(session);
        assert.deepEqual(indexRows(store), ["pending-id"]);

        const store2 = makeStore();
        await store2.boot({ maxSessions: 8, maxBytes: 40_000 });
        assert.deepEqual(indexRows(store2), ["pending-id"], "heal must not touch a row whose label owns no row");
        const resumed = store2.loadSync("ses_pending");
        assert.equal(resumed?.id, "ses_pending", "label resume works off the sole row");
        assert.deepEqual(indexRows(store2), ["ses_pending"], "the resume itself adopts and converges");
    });
});

test("plain sessions (id === label) are untouched by the convergence paths (#3831)", async () => {
    await multiBootFixture(async (_dir, makeStore) => {
        const store = makeStore();
        for (const n of [0, 1]) {
            const s = createSession(`plain-${n}`, { label: `plain-${n}` });
            s.stats.requests = n + 1;
            await store.writeNow(s);
        }
        const store2 = makeStore();
        const loaded = await store2.boot({ maxSessions: 8, maxBytes: 40_000 });
        assert.deepEqual(indexRows(store2), ["plain-0", "plain-1"], "exactly one row per plain session");
        assert.ok(loaded.has("plain-0") && loaded.has("plain-1"));
        assert.equal(store2.loadSync("plain-0")?.stats.requests, 1);
    });
});
