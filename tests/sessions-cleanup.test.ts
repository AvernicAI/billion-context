import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { cacheBlockContent } from "../src/session.ts";
import { SessionStore, relPathFor } from "../src/persist.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.ts";
import { parseDuration, runSessionsCommand } from "../src/sessions-cleanup.ts";
import { rmrf } from "./tmp-rm.ts";

// #3830: supported session cleanup (bili sessions ls/rm/prune + VACUUM).
// Acceptance coverage: rm removes the JSON envelope AND every index.db row and
// releases CAS refcounts (blob count back to baseline), VACUUM shrinks the
// file; residency refusal and pinned-checkpoint refusal hold without --force
// and yield to it; legacy mode degrades to JSON-only deletion; prune honors
// the age cutoff.

const PROTO = "responses";
const ORIGIN = "https://api.openai.com/v1";

function makeSession(id: string, title: string, lastSeenOffsetMs = 0): Session {
    const now = Date.now();
    return {
        id,
        meta: { protocol: PROTO, upstreamOrigin: ORIGIN, title },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: now - 86_400_000 - lastSeenOffsetMs,
        lastSeen: now - lastSeenOffsetMs,
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function withBlock(s: Session, blockId: string, summary: string, fullText: string): void {
    s.state.blocks.push({
        blockId, runId: `r-${blockId}`, tier: 1, topic: `${blockId} topic`,
        summary, directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 4200, createdAt: Date.now(), survivedCount: 2, generation: "young", active: true,
    });
    cacheBlockContent(s, blockId, {
        one: { text: summary, count: 1 },
        full: { text: fullText, count: 2 },
    });
    s.lastMessages = [
        { id: "m1", role: "user", contentType: "text", text: `hello ${s.id}` },
        { id: "m2", role: "assistant", contentType: "text", text: `hi from ${s.id}` },
    ];
}

/** Writes N distinct sessions into dir through the real persistence path
 *  (JSON envelope + unified sidecar double-write) and closes the store,
 *  exactly like a finished proxy process would. */
async function seed(dir: string, ids: Array<{ id: string; ageMs?: number; big?: boolean }>): Promise<void> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    for (const spec of ids) {
        const s = makeSession(spec.id, `title of ${spec.id}`, spec.ageMs ?? 0);
        withBlock(s, `b0-${spec.id}`, `summary of ${spec.id}`, spec.big ? `original conversation body of ${spec.id}\n`.repeat(4096) : `short original of ${spec.id}`);
        await store.writeNow(s);
    }
    store.closeQuietly();
}

/** Makes a freshly seeded session look genuinely old by aging every source
 *  enumerateSessions takes its max() over: the unified row's updated_at (last
 *  ingest) and the envelope's savedAt — BOTH the envelope-level stamp and
 *  payload.savedAt, because buildSession restores lastSeen from the PAYLOAD
 *  copy (#404), not the envelope one. writeNow stamps all of them with
 *  Date.now(), so patching any subset leaves a fresh value winning. */
function ageSession(dir: string, id: string, ageMs: number): void {
    const t = Date.now() - ageMs;
    const db = dbHandle(dir);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(t, id);
    db.close();
    for (const rel of [relPathFor(id, PROTO, ORIGIN), relPathFor(id)]) {
        const file = path.join(dir, rel);
        if (!existsSync(file)) continue;
        const env = JSON.parse(readFileSync(file, "utf8"));
        env.savedAt = t;
        if (env.payload) env.payload.savedAt = t;
        writeFileSync(file, JSON.stringify(env));
        break;
    }
}

function dbHandle(dir: string): SqliteDatabase {
    return openSqliteDatabase(path.join(dir, "index.db")).db;
}

function count(db: SqliteDatabase, table: string, where?: string, param?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ""}`;
    const row = where ? db.prepare(sql).get(param) as { n: number } : db.prepare(sql).get() as { n: number };
    return row.n;
}

interface EnvGuard { restore(): void }

function guardEnv(vars: Record<string, string | undefined>): EnvGuard {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return {
        restore(): void {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        },
    };
}

interface FakeInstance {
    close(): Promise<void>;
}

/** Registers a LIVE instance marker (pid = this process, always alive) whose
 *  origin points at a local HTTP server serving /__bili/sessions — the exact
 *  surface runSessionsCommand probes for residency. */
async function startFakeInstance(stateHome: string, payload: () => unknown): Promise<FakeInstance> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/sessions") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(payload()));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    mkdirSync(path.join(stateHome, "billion-context", "instances"), { recursive: true });
    writeFileSync(path.join(stateHome, "billion-context", "instances", "fake-test.json"), JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        instanceId: "fake-test",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
    }));
    return {
        async close(): Promise<void> {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

test("parseDuration accepts s/m/h/d/w and rejects garbage", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("45m"), 45 * 60_000);
    assert.equal(parseDuration("12h"), 12 * 3_600_000);
    assert.equal(parseDuration("30d"), 30 * 86_400_000);
    assert.equal(parseDuration("2w"), 14 * 86_400_000);
    assert.throws(() => parseDuration("30"), /invalid duration/);
    assert.throws(() => parseDuration("x30d"), /invalid duration/);
    assert.throws(() => parseDuration("-5d"), /invalid duration/);
});

test("sessions ls lists seeded sessions with sizes under shadow mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-ls-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-ls-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    try {
        await seed(dir, [{ id: "ls-one" }, { id: "ls-two" }]);
        const plain = await runSessionsCommand({ sub: "ls", dir, withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(plain.code, 0);
        assert.match(plain.text, /ls-one/);
        assert.match(plain.text, /ls-two/);
        const sized = await runSessionsCommand({ sub: "ls", dir, withSizes: true, force: false, vacuum: true, json: false });
        assert.equal(sized.code, 0);
        assert.match(sized.text, /json=\d+(\.\d+)?(B|KiB|MiB)/);
        assert.match(sized.text, /db=/);
        assert.match(sized.text, /total:/);
        assert.match(sized.text, /index\.db /);
        const j = JSON.parse((await runSessionsCommand({ sub: "ls", dir, withSizes: true, force: false, vacuum: true, json: true })).text);
        assert.equal(j.sessions.length, 2);
        assert.ok(j.sessions[0].jsonBytes > 0);
        assert.ok(j.sessions[0].dbStats.rows.messages >= 2);
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("sessions rm removes envelope + every index row, releases CAS blobs, VACUUM shrinks the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-rm-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-rm-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    // Live instance reporting rm-target as idle (seen 2h ago): the residency
    // check below must RUN against it, not be skipped.
    let payload: unknown = { sessions: [{ id: "rm-target", live: false, lastSeen: new Date(Date.now() - 2 * 3_600_000).toISOString() }] };
    const inst = await startFakeInstance(stateHome, () => payload);
    try {
        await seed(dir, [{ id: "rm-target", big: true }]);
        const envelope = path.join(dir, relPathFor("rm-target", PROTO, ORIGIN));
        assert.ok(existsSync(envelope), "envelope written");
        const dbBefore = dbHandle(dir);
        const baseline = count(dbBefore, "content");
        assert.ok(baseline > 0, "CAS blobs present before delete");
        assert.ok(count(dbBefore, "messages", "session_id = ?", "rm-target") >= 2);
        assert.ok(count(dbBefore, "blocks", "session_id = ?", "rm-target") >= 1);
        const sizeBefore = statSync(path.join(dir, "index.db")).size;
        dbBefore.close();

        const res = await runSessionsCommand({ sub: "rm", dir, target: "rm-target", withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(res.code, 0);
        assert.match(res.text, /deleted session rm-target/);
        assert.doesNotMatch(res.text, /note: could not verify/);
        assert.doesNotMatch(res.text, /skipping the residency check/);
        assert.match(res.text, /VACUUM: index\.db /);
        assert.match(res.text, /→/);

        assert.ok(!existsSync(envelope), "expected file absent");
        assert.ok(!existsSync(path.join(dir, relPathFor("rm-target"))), "expected file absent");
        const dbAfter = dbHandle(dir);
        assert.equal(count(dbAfter, "sessions", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "messages", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "blocks", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "dead_refs", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "refs", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "ccr_entries", "session_id = ?", "rm-target"), 0);
        assert.equal(count(dbAfter, "conversations", "session_id = ?", "rm-target"), 0);
        // Single-session corpus: every CAS blob was exclusively owned by
        // rm-target, so refcount release must leave the table empty — the
        // acceptance line "CAS blob count really decreased".
        assert.ok(baseline > 0, "had blobs to release");
        assert.equal(count(dbAfter, "content"), 0);
        const sizeAfter = statSync(path.join(dir, "index.db")).size;
        dbAfter.close();
        assert.ok(sizeAfter < sizeBefore, `VACUUM did not shrink index.db (${sizeAfter} >= ${sizeBefore})`);
    } finally {
        await inst.close();
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("sessions rm refuses a resident or recently-active session, --force overrides", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-active-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-active-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    let payload: unknown = { sessions: [] };
    try {
        const inst = await startFakeInstance(stateHome, () => payload);
        try {
            await seed(dir, [{ id: "act-resident" }, { id: "act-recent" }, { id: "act-idle" }]);

            payload = { sessions: [{ id: "act-resident", live: true, lastSeen: new Date().toISOString() }] };
            const refused = await runSessionsCommand({ sub: "rm", dir, target: "act-resident", withSizes: false, force: false, vacuum: true, json: false });
            assert.equal(refused.code, 1);
            assert.match(refused.text, /refused to delete act-resident/);
            assert.match(refused.text, /resident in memory/);
            assert.ok(existsSync(path.join(dir, relPathFor("act-resident", PROTO, ORIGIN))), "resident session must survive refusal");

            payload = { sessions: [{ id: "act-recent", live: false, lastSeen: new Date().toISOString() }] };
            const recent = await runSessionsCommand({ sub: "rm", dir, target: "act-recent", withSizes: false, force: false, vacuum: true, json: false });
            assert.equal(recent.code, 1);
            assert.match(recent.text, /active within the last 10 minutes/);

            // Idle (not resident, seen long ago) deletes cleanly.
            payload = { sessions: [{ id: "act-idle", live: false, lastSeen: new Date(Date.now() - 2 * 3_600_000).toISOString() }] };
            const idle = await runSessionsCommand({ sub: "rm", dir, target: "act-idle", withSizes: false, force: false, vacuum: true, json: false });
            assert.equal(idle.code, 0);
            assert.ok(!existsSync(path.join(dir, relPathFor("act-idle", PROTO, ORIGIN))), "expected file absent");

            // --force overrides residency.
            payload = { sessions: [{ id: "act-resident", live: true, lastSeen: new Date().toISOString() }] };
            const forced = await runSessionsCommand({ sub: "rm", dir, target: "act-resident", withSizes: false, force: true, vacuum: true, json: false });
            assert.equal(forced.code, 0);
            assert.ok(!existsSync(path.join(dir, relPathFor("act-resident", PROTO, ORIGIN))), "expected file absent");
        } finally {
            await inst.close();
        }
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("sessions rm refuses pinned checkpoints, --force deletes but keeps the pinned row", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-pin-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-pin-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    try {
        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        const s = makeSession("pin-target", "pinned");
        withBlock(s, "b0-pin", "summary pin", "body pin");
        await store.writeNow(s);
        store.createReplica("pin-target", { label: "pin-a", pinned: true });
        const preStats = store.unifiedSessionStorageStats("pin-target");
        assert.ok(preStats);
        assert.equal(preStats.rows.pinnedCheckpoints, 1);
        const dbPre = dbHandle(dir);
        const cpRow = dbPre.prepare("SELECT state_hash FROM checkpoints WHERE session_id = ? AND pinned = 1").get("pin-target") as { state_hash: string };
        const blobLen = (dbPre.prepare("SELECT byte_len AS b FROM content WHERE hash = ?").get(cpRow.state_hash) as { b: number }).b;
        // Pinned state blobs survive deletion by design, so they must NOT be
        // counted as CAS bytes the delete would free (ls --with-sizes attribution).
        assert.ok(preStats.casExclusiveBytes < blobLen, `exclusive ${preStats.casExclusiveBytes} should exclude the pinned blob (${blobLen})`);
        dbPre.close();
        store.closeQuietly();

        const refused = await runSessionsCommand({ sub: "rm", dir, target: "pin-target", withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(refused.code, 1);
        assert.match(refused.text, /pinned checkpoint\(s\) reference this session/);
        assert.ok(existsSync(path.join(dir, relPathFor("pin-target", PROTO, ORIGIN))));

        const forced = await runSessionsCommand({ sub: "rm", dir, target: "pin-target", withSizes: false, force: true, vacuum: true, json: false });
        assert.equal(forced.code, 0);
        assert.match(forced.text, /pinned checkpoint\(s\) kept/);
        assert.ok(!existsSync(path.join(dir, relPathFor("pin-target", PROTO, ORIGIN))), "expected file absent");

        const db = dbHandle(dir);
        assert.equal(count(db, "messages", "session_id = ?", "pin-target"), 0);
        // Pinned checkpoints hold their CAS refcount and outlive deleteSession
        // by design (schema.ts) — the forced delete must not touch them.
        assert.equal(count(db, "checkpoints", "session_id = ? AND pinned = 1", "pin-target"), 1);
        db.close();
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("sessions rm reports an unknown id instead of claiming success", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-ghost-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-ghost-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    try {
        await seed(dir, [{ id: "someone-else" }]);
        await assert.rejects(
            runSessionsCommand({ sub: "rm", dir, target: "no-such-session", withSizes: false, force: false, vacuum: true, json: false }),
            /not found/,
        );
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("legacy mode degrades to JSON-only deletion", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-legacy-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-legacy-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "legacy", XDG_STATE_HOME: stateHome });
    try {
        await seed(dir, [{ id: "leg-one" }]);
        assert.ok(!existsSync(path.join(dir, "index.db")), "expected file absent");
        const res = await runSessionsCommand({ sub: "rm", dir, target: "leg-one", withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(res.code, 0);
        assert.match(res.text, /deleted session leg-one/);
        assert.doesNotMatch(res.text, /VACUUM/);
        assert.ok(!existsSync(path.join(dir, relPathFor("leg-one", PROTO, ORIGIN))), "expected file absent");
        assert.ok(!existsSync(path.join(dir, "index.db")), "expected file absent");
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("full mode with jsonWriter=off deletes index-only sessions (rows only)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-full-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-full-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "off", XDG_STATE_HOME: stateHome });
    try {
        await seed(dir, [{ id: "full-only" }]);
        assert.ok(!existsSync(path.join(dir, relPathFor("full-only", PROTO, ORIGIN))), "expected envelope absent");
        assert.ok(!existsSync(path.join(dir, relPathFor("full-only"))), "expected envelope absent");
        const dbBefore = dbHandle(dir);
        assert.ok(count(dbBefore, "messages", "session_id = ?", "full-only") >= 1, "expected index rows present");
        dbBefore.close();

        const res = await runSessionsCommand({ sub: "rm", dir, target: "full-only", withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(res.code, 0);
        assert.match(res.text, /deleted session full-only/);
        const dbAfter = dbHandle(dir);
        assert.equal(count(dbAfter, "sessions", "session_id = ?", "full-only"), 0);
        assert.equal(count(dbAfter, "messages", "session_id = ?", "full-only"), 0);
        assert.equal(count(dbAfter, "blocks", "session_id = ?", "full-only"), 0);
        dbAfter.close();
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("prune deletes only sessions older than the cutoff", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-prune-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-prune-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    try {
        await seed(dir, [
            { id: "old-sess", ageMs: 40 * 86_400_000 },
            { id: "fresh-sess", ageMs: 0 },
        ]);
        ageSession(dir, "old-sess", 40 * 86_400_000);
        const res = await runSessionsCommand({ sub: "prune", dir, olderThanMs: parseDuration("30d"), withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(res.code, 0);
        assert.match(res.text, /1 deleted, 0 refused/);
        assert.match(res.text, /deleted\s+old-sess/);
        assert.doesNotMatch(res.text, /deleted\s+fresh-sess/);
        assert.ok(!existsSync(path.join(dir, relPathFor("old-sess", PROTO, ORIGIN))), "expected file absent");
        assert.ok(existsSync(path.join(dir, relPathFor("fresh-sess", PROTO, ORIGIN))));

        const again = await runSessionsCommand({ sub: "prune", dir, olderThanMs: parseDuration("30d"), withSizes: false, force: false, vacuum: true, json: false });
        assert.equal(again.code, 0);
        assert.match(again.text, /nothing to prune/);
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});

test("prune reports refusals per session and exits non-zero when nothing was deleted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cleanup-prune-refuse-"));
    const stateHome = mkdtempSync(path.join(tmpdir(), "bili-cleanup-prune-refuse-state-"));
    const g = guardEnv({ BILI_STORAGE_UNIFIED: "shadow", XDG_STATE_HOME: stateHome });
    let payload: unknown = { sessions: [] };
    try {
        const inst = await startFakeInstance(stateHome, () => payload);
        try {
            await seed(dir, [{ id: "old-live", ageMs: 40 * 86_400_000 }]);
            ageSession(dir, "old-live", 40 * 86_400_000);
            payload = { sessions: [{ id: "old-live", live: true, lastSeen: new Date().toISOString() }] };
            const res = await runSessionsCommand({ sub: "prune", dir, olderThanMs: parseDuration("30d"), withSizes: false, force: false, vacuum: true, json: false });
            assert.equal(res.code, 1);
            assert.match(res.text, /0 deleted, 1 refused/);
            assert.match(res.text, /REFUSED\s+old-live/);
            assert.match(res.text, /resident in memory/);
            assert.ok(existsSync(path.join(dir, relPathFor("old-live", PROTO, ORIGIN))));
        } finally {
            await inst.close();
        }
    } finally {
        g.restore();
        rmrf(dir);
        rmrf(stateHome);
    }
});
