// #3756: snapshot render — proxy-lane outbound rendered from the server-side
// canonical history instead of the client's resent bytes.
//
// Contract staked BEFORE the implementation (打桩):
//
//  1. steady state: the outbound prefix (covered region rendered as summary
//     anchors + uncovered snapshot rows) is byte-stable turn over turn;
//  2. seed upgrade (a codec/identity change re-mints every message id on
//     identical content — the #3752/#3658 regression class): the outbound
//     prefix stays byte-identical, the block survives, no destroy verdict;
//  3. client-side deletion/checkpointing of the covered region is ignored
//     (server-authoritative prefix), the checkpoint itself rides the tail;
//  4. rewind: dropped tail messages do not come back;
//  5. protocol switch mid-session: same session, anchors render, stable;
//  6. rollout off (default): the legacy path keeps today's behavior — the
//     upgrade scenario demonstrably churns (the bug this lane fixes);
//  7. storage unavailable: D quietly falls back to the legacy path.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-snap-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { __setMessageIdSaltForTests } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// 23 messages × ~1.5k chars (~375 tokens each): total ~9k tokens stays under
// the 15k window (no preflight); the default protection zone (preserveRecent
// 3 + 5000-token walk ≈ 14 messages) leaves the first ~9 compressible, so the
// m00001..m00008 range lands intact. The transcript ENDS ON A USER message —
// every turn's streamed reply then appends exactly one assistant message and
// the alternation never breaks (cache-friendly client discipline).
function conversation(tail: { role: string; content: string }[] = []): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 23; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return [...out, ...tail];
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    openaiUrl: string;
    anthropicUrl: string;
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>, storeEnabled: boolean): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (n === 1) {
                // turn 1 request: the model folds the oldest range and stops.
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                // turn 1 re-request (folded view) and later client turns: plain text.
                const text = n === 2 ? "done compressing" : `ok ${n}`;
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = mkdtempSync(path.join(tmpdir(), "bili-snap-store-"));
    const store = storeEnabled ? new SessionStore({ enabled: true, dir, debounceMs: 0 }) : new SessionStore({ enabled: false });
    _setStoreForTest(store);
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
        modelContextLimit: 15_000,
        kernelConfig: defaultConfig(15_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: Boolean(process.env.SNAP_DEBUG),
        debug: Boolean(process.env.SNAP_DEBUG),
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        proxy,
        upstream,
        bodies,
        openaiUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        anthropicUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        __setMessageIdSaltForTests(null);
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        store.closeQuietly();
        void rmrf(dir);
    }
}

type Msg = { role: string; content: string };

async function turn(h: Harness, url: string, label: string, messages: unknown[], history: Msg[] | null = null, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label, ...extraHeaders },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    const body = await r.text();
    await new Promise((res) => setTimeout(res, 60)); // let debounced=0 writes land
    void history; // (history appended below after body parse)
    // realistic client: fold the assistant's visible reply into the transcript
    if (history) {
        for (const m of extractAssistantText(body)) history.push(m);
    }
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

/** One assistant transcript entry per response: all plain-text content deltas
 *  concatenated (cache-friendly-proxy client discipline — the stateless client
 *  sees the model text plus any streamed 📦 receipt line as one reply). */
function extractAssistantText(body: string): Msg[] {
    let text = "";
    for (const block of body.trim().split("\n\n")) {
        if (!block.startsWith("data: ")) continue;
        const data = block.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
            const delta = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta;
            const c = delta?.content;
            if (typeof c === "string") text += c;
        } catch { /* keep scanning */ }
    }
    return text ? [{ role: "assistant", content: text }] : [];
}

/** outbound openai messages from the i-th upstream hit */
function sent(bodies: string[], i: number): { role: string; content: unknown }[] {
    return JSON.parse(bodies[i]).messages as { role: string; content: unknown }[];
}

function textOf(m: { role: string; content: unknown }): string {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** Count anchor-shaped renders (the receipt echo also contains the summary
 *  head; only the section marker counts as an anchor copy). */
function anchorCount(s: string): number {
    return s.split("[Compressed conversation section]").length - 1;
}

/** The stable-prefix comparator: the serialized message stream of `a` up to
 *  its tail must equal `b` element-wise. tailLen = how many trailing messages
 *  of `a` are new (the live tail). */
function assertPrefixStable(a: { role: string; content: unknown }[], b: { role: string; content: unknown }[], tailLenA: number, note: string): void {
    const pa = a.slice(0, a.length - tailLenA);
    assert.ok(b.length >= pa.length, `${note}: other view at least as long (${b.length} < ${pa.length})`);
    for (let i = 0; i < pa.length; i++) {
        assert.equal(JSON.stringify(pa[i]), JSON.stringify(b[i]), `${note}: prefix diverges at outbound message ${i}`);
    }
}

async function armBlock(h: Harness, label: string): Promise<void> {
    const r = await turn(h, h.openaiUrl, label, conversation());
    assert.equal(r.status, 200, r.body);
    const s = h.sessionOf(label);
    assert.ok(s, "session exists");
    assert.ok(s!.state.blocks.some((b) => b.active), "setup created an active block");
}

test("D on: steady state — anchor rendered once, covered rows absent, prefix byte-stable", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-steady", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-steady")!.state.blocks.some((b) => b.active), "block armed");
        // turn 2: transcript + a live tail of 2
        const tail = [
            { role: "user", content: "Message 24 tail question. " + "TAIL_A_".repeat(80) },
        ];
        const full2 = [...history, ...tail];
        const r2 = await turn(h, h.openaiUrl, "s-steady", full2, history);
        assert.equal(r2.status, 200, r2.body);
        const out2 = sent(h.bodies, r2.idx);
        const joined2 = out2.map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "summary anchor rendered");
        assert.equal(anchorCount(joined2), 1, "exactly one anchor copy");
        assert.ok(!joined2.includes("WORK_1_content_"), "covered row 1 suppressed");
        assert.ok(!joined2.includes("WORK_7_content_"), "covered row 7 suppressed");
        assert.ok(joined2.includes("TAIL_A_"), "live tail present");
        // turn 3: identical transcript + one more tail message → whole prefix
        // (incl. everything before the new message) byte-identical to turn 2.
        const r3 = await turn(h, h.openaiUrl, "s-steady", [...history, { role: "user", content: "Message 26 follow-up. " + "TAIL_C_".repeat(80) }], history);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        // tail = the new user message + the assistant run that absorbed the
        // turn-2 reply (#3658 openai assistant run-merge discipline).
        assertPrefixStable(out3, out2, 2, "steady-state");
        const s = h.sessionOf("s-steady")!;
        assert.ok((s.metadata["snapshotRenderTurns"] as number) >= 2, "D observability latch counted turns");
    }, true);
});

test("D on: identity-seed upgrade — outbound prefix byte-identical, block alive, no destroy verdict", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-upg", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-upg")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "UPG_A_".repeat(80) }];
        const r2 = await turn(h, h.openaiUrl, "s-upg", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        const out2 = sent(h.bodies, r2.idx);
        // simulate the #3752/#3658 regression class: every id re-mints on the
        // SAME byte-identical content. The client resends the same history.
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turn(h, h.openaiUrl, "s-upg", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        const joined3 = out3.map(textOf).join("\n");
        assert.ok(joined3.includes(SUMMARY), "anchor still rendered after id re-mint");
        assert.ok(!joined3.includes("WORK_1_content_"), "covered rows still suppressed (no duplicate render)");
        assert.ok(joined3.includes("UPG_A_"), "tail present");
        assert.equal(anchorCount(joined3), 1, "exactly one anchor copy");
        // prefix (everything except the live tail) byte-identical to pre-upgrade
        assertPrefixStable(out3, out2, 1, "seed-upgrade");
        const s = h.sessionOf("s-upg")!;
        assert.ok(s.state.blocks.some((b) => b.active), "block survived the upgrade");
        assert.equal(s.metadata["foldDriftEscalated"], undefined, "no destroy verdict");
    }, true);
});

test("D on: client drops/checkpoints the covered region — server-authoritative prefix, client checkpoint ignored", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-drop", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-drop")!.state.blocks.some((b) => b.active), "block armed");
        // dsh-style checkpoint: first 10 messages replaced by one summary message
        const dropped = [
            { role: "user", content: "Earlier context was summarized by the client checkpoint: setup work happened." },
            ...history.slice(10),
            { role: "user", content: "Continuing after checkpoint. " + "KEEP_A_".repeat(80) },
        ];
        const r2 = await turn(h, h.openaiUrl, "s-drop", dropped, null);
        const out2 = sent(h.bodies, r2.idx);
        const joined2 = out2.map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "anchor rendered from server state");
        assert.ok(!joined2.includes("WORK_1_content_"), "client's idea of the covered region does not resurrect rows");
        assert.ok(joined2.includes("WORK_10_content_"), "uncovered snapshot rows render");
        // Server-authoritative head (#3756 doctrine): the client's checkpoint
        // replacement sits BELOW the chain join, so it never renders — the
        // covered region belongs to the server's own summary (anchor), and
        // the uncovered head renders from the transcript rows it replaced.
        assert.ok(!joined2.includes("client checkpoint"), "client-side checkpoint of the head is ignored (server-authoritative)");
        assert.equal(anchorCount(joined2), 1, "exactly one anchor copy");
        // next turn: the transcript view has adopted the client's checkpoint
        // shape (one-turn adoption lag, documented in the engine header);
        // the anchor still renders from block state, covered rows stay gone.
        const r3 = await turn(h, h.openaiUrl, "s-drop", [...dropped, { role: "user", content: "And one more. " + "KEEP_B_".repeat(80) }], null);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        const joined3 = out3.map(textOf).join("\n");
        assert.ok(joined3.includes(SUMMARY), "anchor still rendered after checkpoint adoption");
        assert.ok(!joined3.includes("WORK_1_content_"), "covered rows stay suppressed after adoption");
        // steady after the edit: the next turn is byte-stable on the prefix
        const r4 = await turn(h, h.openaiUrl, "s-drop", [...dropped, { role: "user", content: "And one more. " + "KEEP_B_".repeat(80) }, { role: "user", content: "Final follow. " + "KEEP_C_".repeat(80) }], null);
        assert.equal(r4.status, 200, r4.body);
        const out4 = sent(h.bodies, r4.idx);
        assertPrefixStable(out4, out3, 1, "client-checkpoint");
    }, true);
});

test("D on: rewind — dropped tail messages do not come back", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-rw", history, history);
        assert.equal(r1.status, 200, r1.body);
        const r2 = await turn(h, h.openaiUrl, "s-rw", [...history, { role: "user", content: "Rewind target question. " + "RW_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        // client rewinds the last exchange and asks something else
        const rewound = [...conversation(), { role: "user", content: "Different question instead. " + "RW_B_".repeat(80) }];
        const r3 = await turn(h, h.openaiUrl, "s-rw", rewound);
        assert.equal(r3.status, 200, r3.body);
        const joined3 = sent(h.bodies, r3.idx).map(textOf).join("\n");
        assert.ok(!joined3.includes("RW_A_"), "rewound message not rendered");
        assert.ok(joined3.includes("RW_B_"), "new question present");
        assert.ok(joined3.includes(SUMMARY), "anchor still rendered");
    }, true);
});

test("D on: protocol switch mid-session — anchors render on the new wire, session not forked", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-switch", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-switch")!.state.blocks.some((b) => b.active), "block armed");
        // next turn arrives on the anthropic wire, same session header
        const msgs = [...history, { role: "user", content: "Switched protocol. " + "SW_A_".repeat(80) }].map((m) => ({
            role: m.role,
            content: [{ type: "text", text: m.content }],
        }));
        const r2 = await turn(h, h.anthropicUrl, "s-switch", msgs, null, { "anthropic-version": "2023-06-01" });
        assert.equal(r2.status, 200, r2.body);
        const joined2 = sent(h.bodies, r2.idx).map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "anchor renders on the anthropic wire");
        assert.ok(!joined2.includes("WORK_1_content_"), "covered rows suppressed after the switch");
        assert.ok(joined2.includes("SW_A_"), "tail present");
        const s = h.sessionOf("s-switch");
        assert.ok(s, "session survived the protocol switch (not forked away)");
    }, true);
});

test("D off (default): the seed-upgrade scenario churns — documents the bug this lane fixes", async () => {
    delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-legacy", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-legacy")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "UPG_A_".repeat(80) }];
        const r2 = await turn(h, h.openaiUrl, "s-legacy", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turn(h, h.openaiUrl, "s-legacy", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const joined3 = sent(h.bodies, r3.idx).map(textOf).join("\n");
        // legacy: coverage matching by id fails wholesale → raw rows re-render
        // (or the block deactivates). Either way the covered content leaks back.
        const leaked = joined3.includes("WORK_0_content_") || !joined3.includes(SUMMARY);
        assert.ok(leaked, "legacy path churns on identity re-mint (the #3752 regression class)");
        assert.equal(h.sessionOf("s-legacy")!.metadata["snapshotRenderTurns"], undefined, "no D latch");
    }, true);
});

test("D on but storage unavailable: legacy fallback, request still served", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-nostore", history, history);
        assert.equal(r1.status, 200, r1.body);
        const s = h.sessionOf("s-nostore");
        assert.ok(s!.state.blocks.some((b) => b.active), "block armed in memory");
        const r2 = await turn(h, h.openaiUrl, "s-nostore", [...history, { role: "user", content: "Still works. " + "NS_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        const joined2 = sent(h.bodies, r2.idx).map(textOf).join("\n");
        assert.ok(joined2.includes("NS_A_"), "served");
        assert.equal(h.sessionOf("s-nostore")!.metadata["snapshotRenderTurns"], undefined, "D inactive without rows");
    }, false);
});
