// #3874: the dsh native-compaction attribution used to be a FOLD predicate, not
// an existence test. In the openai lane the frame read was wrapped in
// `blocks.some(b => b.active)` AND the inner `dshGap &&` check, so a session
// whose fold state was already retired (blocks present but none active — the
// state syncBlocks leaves behind after an earlier compacted replay, and the
// state a session sits in when dsh compacts before bili ever re-folds) never
// entered the attribution branch at all. The compacted replay then fell
// through to detectUnannouncedHistoryRewrite, which classified dsh's OWN
// landing as "another compressor" (unannounced-rewrite) and lit the banner.
//
// The fix reads the checkpoint framing FIRST (existence test) and let fold
// coverage decide only whether a rebase is worthwhile; a frame arriving with
// no fold state is recorded once as native-compaction, and the rewrite
// detector stands down for that request.
//
// Red-before-green: with the pre-#3874 gate this test records
// `unannounced-rewrite` and no `native-compaction`; the assertions below fail.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { WEB_CLIENT } from "../src/web/client.ts";

const MODEL = "deepseek-flash";

type Rig = { proxyPort: number; upstreamUrl: string; bodies: string[]; close: () => Promise<void> };

async function startRig(injectTool: boolean): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const promptTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}
function piHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv };
}

// 24 messages: above REWRITE_MIN_KNOWN_REFS (20) so the pre-fix fall-through
// into detectUnannouncedHistoryRewrite is reachable, which is exactly the
// mis-attribution this issue is about. The kernel protects the last 5, so
// folding m00001–m00017 covers 17 ids (> the 8-id floor).
const SEED_LEN = 24;
function seedInput() {
    return Array.from({ length: SEED_LEN }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(120),
    }));
}

function checkpointMessage() {
    return {
        role: "user",
        content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- backfill the billing exporter, then verify`,
    };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string): Promise<void> {
    const r1 = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: MODEL, messages: seedInput() }),
    });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists");
    const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00017", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

// The compacted replay: a fresh checkpoint, a retained tail bili has never seen
// (new bytes → new ids, as dsh re-serializes the tail), plus the last two
// messages byte-identical so `knownIncoming > 0` — the pre-fix code needs that
// to mis-classify the landing as an unannounced rewrite.
function compactedReplay() {
    const seed = seedInput();
    return [
        checkpointMessage(),
        ...Array.from({ length: 9 }, (_, k) => ({ role: k % 2 === 0 ? "user" : "assistant", content: `TAIL_AFTER_COMPACT_${k}_` + "z".repeat(900) })),
        seed[seed.length - 2],
        seed[seed.length - 1],
    ];
}

test("#3874 e2e openai: dsh frame with NO fold state is attributed to dsh, not to an unannounced rewrite", async () => {
    const rig = await startRig(true);
    const conv = "dsh3874-openai-nofold";
    try {
        await seedAndFold(rig, conv);
        const s0 = getSession(conv)!;
        // The state that defeats the pre-fix gate: blocks still exist (so
        // detectUnannouncedHistoryRewrite is armed) but none is active.
        for (const b of s0.state.blocks) b.active = false;
        assert.ok(s0.state.blocks.length > 0, "precondition: a retired block still exists");
        assert.equal(conflictEventsOf(s0).filter((e) => e.kind === "native-compaction").length, 0, "precondition: no attribution yet");

        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: compactedReplay() }),
        });
        assert.equal(r.status, 200, "compacted replay succeeds");
        await r.text();

        const s = getSession(conv)!;
        const events = conflictEventsOf(s);
        assert.ok(events.some((e) => e.kind === "native-compaction"), `attributed to dsh native compaction (got ${JSON.stringify(events.map((e) => e.kind))})`);
        assert.ok(
            !events.some((e) => e.kind === "unannounced-rewrite"),
            `must NOT be double-recorded as an unannounced rewrite (got ${JSON.stringify(events.map((e) => e.kind))})`,
        );
        assert.equal(s.metadata.dshNativeCompactionLanded, true, "landing flag recorded (dedupe for later replays)");
        assert.equal(
            events.filter((e) => e.kind === "native-compaction").length,
            1,
            "recorded exactly once (the marker re-rides every replay)",
        );
        // Nothing of ours existed to rebase, so no phantom reset was performed.
        assert.ok(
            events.every((e) => !e.detail.includes("ACP state rebased")),
            `no rebase claimed when there was no fold state (got ${JSON.stringify(events.map((e) => e.detail))})`,
        );
    } finally {
        await rig.close();
    }
});

test("#3874 e2e openai: the second replay of the same checkpoint does not re-record (flag is the dedupe)", async () => {
    const rig = await startRig(true);
    const conv = "dsh3874-openai-nofold-twice";
    try {
        await seedAndFold(rig, conv);
        for (const b of getSession(conv)!.state.blocks) b.active = false;
        for (let i = 0; i < 2; i++) {
            const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.upstreamUrl}/v1/chat/completions`, {
                method: "POST",
                headers: dshHeaders(conv),
                body: JSON.stringify({ model: MODEL, messages: compactedReplay() }),
            });
            assert.equal(r.status, 200, `replay ${i + 1} succeeds`);
            await r.text();
        }
        const events = conflictEventsOf(getSession(conv)!);
        assert.equal(
            events.filter((e) => e.kind === "native-compaction").length,
            1,
            `one attribution for two replays (got ${JSON.stringify(events.map((e) => e.kind))})`,
        );
        assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "still never an unannounced rewrite");
    } finally {
        await rig.close();
    }
});

test("#3874 e2e negative: the same frame on a NON-dsh lane is not attributed to dsh", async () => {
    const rig = await startRig(true);
    const conv = "dsh3874-pi-nofold";
    try {
        const r1 = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: piHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: seedInput() }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00017", summary: FOLD_SUMMARY }] } }),
        });
        assert.ok(((await r2.json()) as { ok: boolean }).ok, "fold accepted on the pi lane");
        const s0 = getSession(conv)!;
        assert.equal(s0.metadata["pluginAgent"], "pi", "precondition: bound to the pi lane");
        for (const b of s0.state.blocks) b.active = false;
        const before = conflictEventsOf(s0).length;

        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: piHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: compactedReplay() }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const after = conflictEventsOf(getSession(conv)!);
        assert.ok(
            !after.some((e) => e.kind === "native-compaction"),
            `dsh attribution must not fire outside the dsh lane (got ${JSON.stringify(after.map((e) => e.kind))})`,
        );
        assert.ok(!getSession(conv)!.metadata.dshNativeCompactionLanded, "no landing flag outside the dsh lane");
        assert.ok(after.length >= before, "ledger untouched-or-appended, never rewritten");
    } finally {
        await rig.close();
    }
});

// The banner is the symptom #3874 was filed for: a lone `native-compaction`
// entry must stand down (neutralOnly), i.e. the alarm is not "landed".
test("#3874 banner: a ledger naming only native-compaction stands down (no alarm)", () => {
    const s = WEB_CLIENT.indexOf('"use strict";');
    const e = WEB_CLIENT.indexOf("window.bili_conflictLine = bili_conflictLine;");
    assert.ok(s >= 0 && e > s, "conflict-banner helpers present in WEB_CLIENT");
    const src = WEB_CLIENT.slice(s, e) + "\nreturn { severity: bili_conflictSeverity };";
    const { severity } = new Function(src)() as {
        severity: (c: Record<string, unknown>) => { landed: boolean; neutralOnly: boolean; signalN: number; hasConfirmed: boolean };
    };
    const out = severity({ events: 1, sessions: 1, kinds: { "native-compaction": 1 }, latest: [{ kind: "native-compaction", detail: "dsh native compaction: no fold state yet (nothing to rebase); landing attributed (#3874)" }] });
    assert.equal(out.signalN, 0, "handled native landing is not an unexplained signal");
    assert.equal(out.hasConfirmed, false, "a handled landing is not confirmed evidence");
    assert.equal(out.neutralOnly, true, "fully-handled ledger stands down");
    assert.equal(out.landed, false, "banner must not pop");
});
