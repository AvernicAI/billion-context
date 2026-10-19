/**
 * #3437: DIGEST DRIFT lines must name WHICH parts diverged.
 *
 * A bare whole-view hash mismatch is unclassifiable in the field: fold-related
 * rewrites below the boundary (expected self-heal), a lossy DB round-trip
 * (defect), and unmasked provenance stamps (canonicalize gap) all look
 * identical when the log only says "unified replay != legacy load view". The
 * cold-start capture of 2026-10-19 (first verify after boot drifted on an
 * 11.5k-message session) sat in exactly that blind spot. These tests pin the
 * field-level breakdown: the helper's bucket mapping, and the wiring through
 * record()'s sampled verify into the actual log line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow, shadowDigestDivergence } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { setLogCapture } from "../src/logger.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-drift-parts-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"], pluginSnapshot?: LegacySessionLike["pluginSnapshot"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
        pluginSnapshot,
    };
}

interface StatsView {
    ingests: number;
    deltaIngests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

function baseView(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "s1",
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 3 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
            tokenSnapshot: { m00001: 5 },
        },
        blockContents: new Map(),
        lastMessages: [],
        lastMessagesFolded: false,
        ...over,
    };
}

test("divergence: identical views report nothing", () => {
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView()), []);
});

test("divergence: a single differing top-level key names exactly that key", () => {
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView({ stats: { requests: 4 } })), ["stats"]);
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView({ meta: { protocol: "openai" } })), ["meta"]);
});

test("divergence: state subfields resolve individually, sorted", () => {
    const over = { state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1, tokenSnapshot: { m00001: 9 }, nudge: { last: 1 } } };
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView(over)), ["state.nudge", "state.tokenSnapshot"]);
});

test("divergence: Maps compare by content, absent vs undefined keys are equal", () => {
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView({ blockContents: new Map([["b1", { one: null, full: {} }]]) })), ["blockContents"]);
    assert.deepEqual(shadowDigestDivergence(baseView(), baseView({ pluginSnapshot: undefined })), []);
    assert.deepEqual(shadowDigestDivergence(undefined, undefined), []);
});

test("record(): the sampled-verify drift log line names the divergent bucket", () => {
    const dir = tmpdir("bili-drift-parts-rec-");
    const captured: { level: string; msg: string }[] = [];
    try {
        const { shadow, store } = openShadow(dir);
        setLogCapture((level, msg) => captured.push({ level, msg }));
        try {
            // 21 appends: save 1 full (watermark set), saves 2..21 delta —
            // same shape as the watermark suite's sampled-verify case.
            let k = 5;
            shadow.record(mkLegacy("dp-rec", Array.from({ length: k }, (_, i) => msg(i))));
            assert.equal(stats(shadow).verifySamples, 1, "first ingest verifies");

            // Tamper the CAS body under a trusted-prefix row the delta path
            // will NOT rewrite — only the sampled read-back can see it, and
            // the read-back parses those bytes into lastMessages.
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                const row = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get("dp-rec") as { content_hash: string } | undefined;
                assert.ok(row, "row to tamper must exist");
                conn
                    .prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                    .run(Buffer.from(JSON.stringify({ id: "tampered", role: "user", contentType: "text", text: "tampered" }), "utf8"), row.content_hash);
            } finally {
                conn.close();
            }

            for (let i = 0; i < 20; i++) {
                k += 1;
                shadow.record(mkLegacy("dp-rec", Array.from({ length: k }, (_, j) => msg(j))));
            }
            const s = stats(shadow);
            assert.equal(s.verifyDrift, 1, "the sampled save at n=21 must catch the CAS drift");

            const driftLine = captured.find((l) => l.msg.includes("DIGEST DRIFT"));
            assert.ok(driftLine, "the drift must be logged");
            const m = driftLine!.msg.match(/divergent parts: (.+?) — dropped/);
            assert.ok(m, "the drift line must name the divergent parts");
            assert.deepEqual(m![1].split(", ").filter(Boolean), ["lastMessages"], "CAS-byte tamper under a tail row diverges exactly the lastMessages bucket");
        } finally {
            setLogCapture(null);
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
