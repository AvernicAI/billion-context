import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { LazyBlockContents, _resetSessionsForTest, getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetDiskCacheForTest, buildBlockContent, buildMessageContent, buildSessionDetail } from "../src/web/sessions-data.ts";
import { MESSAGES } from "../src/web/i18n.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { runWebClient } from "./web-trajectory-harness.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "bili-blocks-tree-sess-"));
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-blocks-tree-")), "no-config.json");

// #3917: the compression-tree lane is read-only web diagnostics — no store, no
// disk, every fixture is an in-memory live session.
_setStoreForTest(new SessionStore({ enabled: false }));

function mkBlock(
    blockId: string,
    tier: number,
    summary: string,
    direct: string[],
    effective: string[],
    kids: string[] = [],
    span?: [string, string],
): CompressionBlock {
    return {
        blockId,
        runId: "run-1",
        tier: tier as CompressionBlock["tier"],
        summary,
        directMessageIds: direct,
        effectiveMessageIds: effective,
        directBlockIds: kids,
        compressedTokens: 1000 * tier,
        createdAt: 1_700_000_000_000 - 1000 * tier,
        survivedCount: 0,
        generation: "young",
        active: true,
        ...(span ? { startRef: span[0], endRef: span[1] } : {}),
    };
}

function seedSession(id: string, blocks: CompressionBlock[]): ReturnType<typeof getSession> {
    _resetSessionsForTest();
    const s = getSession(id, { protocol: "openai" });
    s.state = createInitialState();
    s.state.blocks = blocks;
    s.blockContents = new LazyBlockContents(id, {}, () => null);
    return s;
}

test("#3917: detail carries fold-parent links and summary accounting for the tree", async () => {
    const t1 = mkBlock("b1", 1, "## T1 summary\n- point one", ["rm1", "rm2"], ["rm1", "rm2"], [], ["m00001", "m00002"]);
    const t2 = mkBlock("b2", 2, "T2 summary", ["rm3"], ["rm1", "rm2", "rm3"], ["b1"], ["m00001", "m00003"]);
    seedSession("tree-1", [t1, t2]);
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-1");
    assert.ok(d, "live session resolves");
    const byId = new Map(d.blockDetails.map((b) => [b.blockId, b]));
    const b1 = byId.get("b1")!;
    const b2 = byId.get("b2")!;
    assert.equal(b1.parentBlockId, "b2", "the folded child points at the block that absorbed it");
    assert.equal(b2.parentBlockId, undefined, "a root has no fold parent");
    assert.deepEqual(b2.directBlockIds, ["b1"], "children survive in the payload so the tree can nest");
    assert.equal(b1.effectiveMessageCount, 2);
    assert.equal(b1.directMessageCount, 2);
    assert.equal(b1.summaryTokens, defaultCountTokens(t1.summary), "summary tokens are the kernel's own count");
    assert.equal(b1.summaryBytes, Buffer.byteLength(t1.summary));
    assert.equal(b2.startRef, "m00001");
    assert.equal(b2.endRef, "m00003");
    assert.equal(b1.active, true);
});

test("#3917: buildBlockContent serves one/full views and reports honest misses", async () => {
    const s = seedSession("tree-content", [mkBlock("b1", 1, "s", ["m1"], ["m1"])]);
    s.blockContents.set("b1", { one: { text: "one-body", count: 1 }, full: { text: "full-body-longer", count: 3 } });

    const one = await buildBlockContent("tree-content", "b1", "one");
    assert.ok(one.ok);
    assert.equal(one.text, "one-body");
    assert.equal(one.count, 1);
    assert.equal(one.view, "one");
    assert.equal(one.bytes, Buffer.byteLength("one-body"));
    assert.equal(one.totalBytes, one.bytes);
    assert.equal(one.truncated, false);

    const full = await buildBlockContent("tree-content", "b1", "full");
    assert.ok(full.ok);
    assert.equal(full.text, "full-body-longer");
    assert.equal(full.count, 3);

    assert.deepEqual(await buildBlockContent("tree-content", "missing", "one"), { ok: false, reason: "unknown-block" });
    assert.deepEqual(await buildBlockContent("no-such-session", "b1", "one"), { ok: false, reason: "unknown-session" });

    s.state.blocks.push(mkBlock("b2", 1, "no snapshot", [], []));
    assert.deepEqual(await buildBlockContent("tree-content", "b2", "one"), { ok: false, reason: "no-content-snapshot" });
});

test("#3917: an oversized block truncates at the byte cap and still reports the full size", async () => {
    const s = seedSession("tree-big", [mkBlock("b1", 1, "s", ["m1"], ["m1"])]);
    const huge = "x".repeat(2 * 1024 * 1024 + 64);
    s.blockContents.set("b1", { one: { text: huge, count: 9 }, full: { text: huge, count: 9 } });
    const r = await buildBlockContent("tree-big", "b1", "full");
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 2 * 1024 * 1024);
    assert.equal(r.totalBytes, huge.length);
    assert.equal(r.text.length, 2 * 1024 * 1024);
});

test("#3917: a block stored before directBlockIds existed neither throws nor nests", async () => {
    const legacy = mkBlock("b1", 1, "s", ["m1"], ["m1"]);
    delete (legacy as { directBlockIds?: string[] }).directBlockIds;
    delete (legacy as { effectiveMessageIds?: string[] }).effectiveMessageIds;
    delete (legacy as { directMessageIds?: string[] }).directMessageIds;
    seedSession("tree-legacy", [legacy]);
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-legacy");
    assert.ok(d, "a partial legacy block still renders");
    const b1 = d.blockDetails[0];
    assert.deepEqual(b1.directBlockIds, []);
    assert.equal(b1.effectiveMessageCount, 0);
    assert.equal(b1.directMessageCount, 0);
    assert.deepEqual(b1.directMessageRefs, []);
    assert.equal(b1.parentBlockId, undefined);
});

test("#3917: message leaves name each folded message and serve its text lazily", async () => {
    const s = seedSession("tree-msgs", [mkBlock("b1", 1, "s", ["rm1", "rm2"], ["rm1", "rm2"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002" }, byRef: { m00001: "rm1", m00002: "rm2" } };
    s.lastMessages = [
        { id: "rm1", role: "user", contentType: "text", text: "hello   there\nworld" },
        { id: "rm2", role: "assistant", contentType: "text", text: "hi" },
    ];
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-msgs");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m00001", role: "user", preview: "hello there world" },
        { ref: "m00002", role: "assistant", preview: "hi" },
    ]);
    const one = await buildMessageContent("tree-msgs", "m00001");
    assert.ok(one.ok);
    assert.equal(one.role, "user");
    assert.equal(one.text, "hello   there\nworld", "the leaf serves the message verbatim, whitespace intact");
    assert.equal(one.totalBytes, Buffer.byteLength("hello   there\nworld"));
    assert.deepEqual(await buildMessageContent("tree-msgs", "m99999"), { ok: false, reason: "unknown-message" });
    assert.deepEqual(await buildMessageContent("no-such-session", "m00001"), { ok: false, reason: "unknown-session" });
});

test("#3917: a folded message the host pruned reports a miss instead of a guess", async () => {
    const s = seedSession("tree-pruned", [mkBlock("b1", 1, "s", ["rm1"], ["rm1"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001" }, byRef: { m00001: "rm1" } };
    s.lastMessages = [];
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-pruned");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [{ ref: "m00001", missing: true }], "the ref survives even when its bytes are gone");
    assert.equal(d.blockDetails[0].directMessageCount, 1, "but the count still says one message was folded");
    assert.equal(d.blockDetails[0].directMessageRefs.length, 1, "and its ref is still named");
    assert.deepEqual(await buildMessageContent("tree-pruned", "m00001"), { ok: false, reason: "unknown-message" });
});

test("#3917: the tree's strings exist in both locales with identical placeholders", () => {
    const keys = [
        "det.tab_overview",
        "det.tab_blocks",
        "det.tab_handoff",
        "det.tree_total",
        "det.tree_active",
        "det.tree_split",
        "det.tree_msgs",
        "det.tree_direct",
        "det.tree_orig_one",
        "det.tree_orig_full",
        "det.tree_orig_meta",
        "det.tree_orig_truncated",
        "det.tree_orig_missing",
        "det.tree_msgs_unavailable",
        "det.tree_msg_gone",
        "det.tree_hint",
        "det.tree_view_list",
        "det.tree_view_graph",
        "det.tree_graph_hint",
        "det.tree_graph_legend",
    ];
    const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
    for (const key of keys) {
        const zh = MESSAGES["zh-CN"][key];
        const en = MESSAGES.en[key];
        assert.ok(zh, `zh-CN missing ${key}`);
        assert.ok(en, `en missing ${key}`);
        assert.equal(placeholders(zh), placeholders(en), `${key} placeholder drift`);
    }
});

test("#3917: the web client bundle stays parseable JS after the tree additions", () => {
    assert.doesNotThrow(() => new vm.Script(WEB_CLIENT), "WEB_CLIENT must compile as a standalone script");
    assert.match(WEB_CLIENT, /function buildTreePane\(blocks\)/);
    assert.match(WEB_CLIENT, /\/block-content\?blockId=/);
    // the graph reading of the same folds: layered boxes + list⇄graph switch
    assert.match(WEB_CLIENT, /function buildGraphSvg\(blocks\)/);
    assert.match(WEB_CLIENT, /function blockGraphLayout\(blocks,\s*vertical\)/);
    assert.match(WEB_CLIENT, /"g-node tier-" \+/);
    assert.match(WEB_CLIENT, /data-mode="graph"/);
    assert.match(WEB_CLIENT, /id="tree-graph"/);
    assert.match(WEB_CLIENT, /\.block-node\[data-bid=/);
});

// #4173: fit-to-card shrinks a wide tree until boxes become sub-pixel dots
// (the reported session: 161 leaves → 21558px wide, fit 0.052). When the scale
// would drop below 0.5 the graph flips portrait at natural box size instead.
interface GraphLayout {
    nodes: Array<{ b: Record<string, unknown>; x: number; y: number; s: number }>;
    links: Array<[unknown, unknown]>;
    width: number;
    height: number;
    vertical: boolean;
}

function cb(id: string, parent?: string, tier = 1): Record<string, unknown> {
    return { blockId: id, parentBlockId: parent, tier, active: true, compressedTokens: 1000, summaryTokens: 100 };
}

function loadGraphSeams(): { layout: (blocks: unknown[], vertical?: boolean) => GraphLayout; svgOf: (blocks: unknown[]) => string } {
    const { window: win } = runWebClient({ hash: "#/sessions", fetchImpl: () => new Promise(() => {}) });
    const layout = win.bili_blockGraphLayout as (blocks: unknown[], vertical?: boolean) => GraphLayout;
    const svgOf = win.bili_buildGraphSvg as (blocks: unknown[]) => string;
    assert.equal(typeof layout, "function", "layout seam exposed on window");
    assert.equal(typeof svgOf, "function", "svg seam exposed on window");
    return { layout, svgOf };
}

test("#4173: a wide tree flips portrait at natural size instead of shrinking to sub-pixel", () => {
    const { layout, svgOf } = loadGraphSeams();
    const blocks: Array<Record<string, unknown>> = [cb("R", undefined, 2)];
    for (let i = 0; i < 30; i++) blocks.push(cb("C" + i, "R"));
    for (let i = 0; i < 30; i++) for (let j = 0; j < 5; j++) blocks.push(cb("L" + i + "_" + j, "C" + i));

    // horizontal geometry reproduces the reported mechanism: 150 leaves × 134px
    // − 16 gap = 20084px wide, depth 2 → 204px tall
    const flat = layout(blocks, false);
    assert.equal(flat.width, 20084);
    assert.equal(flat.height, 204);
    assert.equal(flat.nodes.length, 181);
    assert.equal(flat.links.length, 180);

    // 20112px would need fit 0.056 (< 0.5) → portrait: depth along x, siblings along y
    const svg = svgOf(blocks);
    assert.match(svg, /class="g-svg g-svg-natural"/);
    assert.match(svg, /viewBox="0 0 414 7216"/);
    assert.match(svg, /width="414"/);
    assert.match(svg, /height="7216"/);
    assert.equal((svg.match(/class="g-edge"/g) || []).length, 180, "every fold still linked");
    assert.equal((svg.match(/g class="g-node/g) || []).length, 181, "every block still drawn");
    // root → first-child edge: root at (0, 3576), child C0 at (134, 96), pad 14
    assert.ok(svg.includes('d="M132 3608 C140 3608 140 128 148 128"'), "portrait edge runs between level columns");
});

test("#4173: narrow and medium trees keep their original fit-to-card rendering", () => {
    const { svgOf } = loadGraphSeams();

    const five = [cb("a"), cb("b"), cb("c"), cb("d"), cb("e")];
    const svg5 = svgOf(five);
    assert.ok(!svg5.includes("g-svg-natural"), "5 leaves need no scaling at all");
    assert.match(svg5, /viewBox="0 0 682 64"/);
    assert.match(svg5, /width="682"/);

    const ten = [...Array(10)].map((_, i) => cb("m" + i));
    const svg10 = svgOf(ten);
    assert.ok(!svg10.includes("g-svg-natural"), "10 leaves still fit-to-card (fit 0.83 ≥ 0.5)");
    assert.match(svg10, /viewBox="0 0 1352 64"/);
    assert.match(svg10, /width="1120"/);
    assert.match(svg10, /height="53"/);
});

test("#4173: the orientation flip sits exactly at the 0.5 readability floor", () => {
    const { svgOf } = loadGraphSeams();

    const sixteen = [...Array(16)].map((_, i) => cb("k" + i));
    const svg16 = svgOf(sixteen);
    assert.ok(!svg16.includes("g-svg-natural"), "16 leaves: fit 0.52 still readable, stays landscape");
    assert.match(svg16, /width="1120"/);

    const seventeen = [...Array(17)].map((_, i) => cb("k" + i));
    const svg17 = svgOf(seventeen);
    assert.match(svg17, /class="g-svg g-svg-natural"/, "17 leaves: fit 0.49 crosses the floor");
    assert.match(svg17, /viewBox="0 0 146 832"/);
});
