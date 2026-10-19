import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, _resetSessionsForTest } from "../src/session.ts";

// #3831 hermeticity: pin the config tier so a machine-level storage.unified
// cannot leak into these fixtures (same pattern as storage-unified.test.ts).
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-issue3831-")),
    "billion-context.json",
);

/** Full-mode fixture: the defect only manifests when the unified index is
 *  the primary read source, so every store here boots under explicit full. */
async function fullFixture(run: (dir: string, store: SessionStore) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-issue3831-"));
    const dir = path.join(root, "sessions");
    const modeBefore = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    _setStoreForTest(store);
    try { await run(dir, store); }
    finally {
        store.closeQuietly();
        if (modeBefore === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = modeBefore;
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

test("full-mode reload restores archived originals the unified view drops (#3831)", async () => fullFixture(async (_dir, store) => {
    // Zombie-reaped fold shape (#2695): state.blocks empty, blockContents
    // still holding the archived original — legitimate persisted state.
    const session = createSession("ses_orphan", { label: "ses_orphan" });
    session.state.messageRefs.byRaw["old-message"] = "m00001";
    session.state.messageRefs.byRef["m00001"] = "old-message";
    session.blockContents.set("b1", { one: null, full: { text: "archived original\r\n", count: 1 } });
    await store.writeNow(session);
    const booted = await store.boot({ maxSessions: 8, maxBytes: 40000 });
    // Boot warm path (buildForLoadAll): the warmed session must carry the
    // original bytes, not the lossy view.
    assert.deepEqual(booted.get("ses_orphan")?.blockContents.get("b1"), session.blockContents.get("b1"));
    // Cold path (loadSync): same guarantee after the index row exists.
    const loaded = store.loadSync("ses_orphan");
    assert.equal(loaded?.id, "ses_orphan");
    assert.deepEqual(loaded?.state.messageRefs, session.state.messageRefs);
    assert.deepEqual(loaded?.blockContents.get("b1"), { one: null, full: { text: "archived original\r\n", count: 1 } });
}));

test("full mode without orphaned originals keeps serving the unified index (#3831 negative)", async () => fullFixture(async (dir, store) => {
    // Gate discipline (#3617): the #3831 escape hatch must NOT trigger for a
    // session whose record carries no orphaned contents — the index view
    // stays the source of truth, even once the legacy envelope is gone.
    const session = createSession("ses_plain", { label: "ses_plain" });
    session.state.messageRefs.byRaw["plain-message"] = "m00001";
    session.state.messageRefs.byRef["m00001"] = "plain-message";
    session.stats.requests = 7;
    await store.writeNow(session);
    await store.boot({ maxSessions: 8, maxBytes: 40000 });
    rmSync(path.join(dir, relPathFor(session.id)), { force: true });
    const loaded = store.loadSync("ses_plain");
    assert.equal(loaded?.id, "ses_plain");
    assert.equal(loaded?.stats.requests, 7);
    assert.deepEqual(loaded?.state.messageRefs, session.state.messageRefs);
}));
