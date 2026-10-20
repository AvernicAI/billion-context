// #3977 pins (先打桩): characterization tests locking the CURRENT observable
// behavior of the three escape hatches that #3846's evidence store guards but
// no test yet pins, plus the calibration-loop boundary that step 4 of the
// ledger migration will intentionally flip.
//
// These pins are the guardrail for the pure-extraction PR (size-evidence
// ledger + preflight verdict state machine): every assertion here must stay
// byte-identical through steps 1-3 of the migration. Assertions marked
// "@flip-target" are the deliberate behavior change of step 4
// (learnFromOutcome) and will be inverted in that PR, not before.
//
//   P-IMG-a  control: the image-arbitration hatch forwards an over-window
//            image-dominated payload with NO local evidence (upstream bills).
//   P-IMG-b  edge: the same payload AFTER a scoped local 413 stays refused —
//            zero upstream calls (the #3846 guard on the image hatch).
//   P-DIV    edge: a payload that FOLDS under the window after a local 413 —
//            current post-refusal fold semantics, observed and pinned.
//   P-LEARN  boundary (FLIPPED in step 4b): two agreeing 400s that STATE the
//            rejected payload's counts ("N in the messages") publish a k-hat
//            and flip an under-window payload from forward-direct to
//            fold-first; a window-only 400 arms but never teaches.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

// ~400KB of varying ASCII core text: ~100K tokens at chars/4 — 5x the 20K
// window, robust across the k̂ clamp — and placed in the SYSTEM message so it
// is wire overhead: folding can never remove it (the #3846 refusal shape).
function bigSystem(): string {
    let out = "";
    for (let i = 0; i < 400_000; i += 64) {
        out += `oversized non-foldable system load segment ${Math.floor(i / 64)}: ` + "x".repeat(40);
    }
    return out.slice(0, 400_000);
}

// A ~100KB base64 data-URL image: ~25K tokens under bytes billing, so a small
// text channel (~2.5K tokens) plus this image clears the 20K window on the
// image estimate alone.
function imageContent(): unknown {
    return [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(100_000)}` } },
    ];
}

// Six alternating turns of ~12KB user/assistant text (~3K tokens each) —
// plenty of compressible ranges — plus a tail question.
function foldableHistory(): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 6; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} load: ` + `y${i}`.repeat(6_000) });
    }
    messages.push({ role: "user", content: "final question" });
    return messages;
}

// The P-LEARN detour payload: a ~60KB base64 image plus ~24KB of core text
// so the prepare-time estimate (~21.7K tokens: the local estimator bills the
// base64 chars/4 like text) clears the CALIBRATION_MIN_ESTIMATE=2000 gate.
// The upstream bills the image FAR above the local chars/4 caliber (the
// #3900 production story: stated 60000 vs local ≈ 21.7K → ratio ≈ 2.8, inside
// the plausibility band [0.2, 5]). Detour 2 rides because the recovery
// request retires detour 1's arm (#1110), not because of these sizes.
function detourContent(): unknown {
    return [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(60_000)}` } },
        { type: "text", text: "detour load: " + "z".repeat(24_000) },
    ];
}

// The P-LEARN flip payload: six foldable ~8KB turns ≈ 12K raw tokens — UNDER
// the 20K window raw (forwards directly unlearned, see the control), but OVER
// it once the learned k-hat (≈2.8) calibrates the estimate → fold-first.
function underWindowFoldable(): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 6; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `flip turn ${i} load: ` + `w${i}`.repeat(4_000) });
    }
    messages.push({ role: "user", content: "final question" });
    return messages;
}

type Call = { summary: boolean; stream: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// Upstream that can be flipped to answer the NEXT forwarded request with a
// 400. Two shapes: the window-only body (no per-part counts — arms but never
// teaches) and the #3900/#3738 stated-count body ("N in the messages, K in the
// completion") that step 4b's learnFromOutcome consumes.
function makeUpstream(): { server: http.Server; calls: Call[]; arm400: () => void; arm400Stated: () => void } {
    const calls: Call[] = [];
    let arm400 = false;
    let armStated = false;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, stream: !isSummary && !!parsed.stream, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                    return;
                }
                if (armStated) {
                    armStated = false;
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "This model's maximum context length is 20000 tokens. However, you requested 70000 tokens (60000 in the messages, 10000 in the completion). Please reduce the length of the messages or completion.", type: "invalid_request_error" } }));
                    return;
                }
                if (arm400) {
                    arm400 = false;
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "This model's maximum context length is 20000 tokens. However, your messages resulted in 1198269 tokens. Please reduce the length of the messages.", type: "invalid_request_error" } }));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
            }
        });
    });
    return { server, calls, arm400: () => { arm400 = true; }, arm400Stated: () => { armStated = true; } };
}

type Upstream = ReturnType<typeof makeUpstream>;

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string> };

async function listen(u: Upstream): Promise<number> {
    u.server.listen(0, "127.0.0.1");
    await once(u.server, "listening");
    return (u.server.address() as { port: number }).port;
}

async function setup(routes: Record<string, object>): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const firstKey = Object.keys(routes)[0]!;
    const proxy = await startServer(proxyOptions(routes));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/${firstKey}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
        },
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close")]);
        },
    };
}

const post = (ctx: Ctx, body: Record<string, unknown>) =>
    fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body: JSON.stringify(body) });

const streamCalls = (calls: Call[]) => calls.filter((c) => c.stream).length;

// Seed a fitting baseline, then land the scoped local 413 (bigSystem is wire
// overhead: nothing foldable, deterministic refusal) — the #3846 evidence.
async function seedAndRefuse(ctx: Ctx, sessionId: string, model = "gpt-test"): Promise<string> {
    ctx.headers["x-acp-session"] = sessionId;
    const rSeed = await post(ctx, { model, stream: true, messages: [{ role: "user", content: "hello" }] });
    assert.equal(rSeed.status, 200, "the fitting seed forwards");
    await rSeed.text();

    const rBig = await post(ctx, { model, stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
    assert.equal(rBig.status, 413, "oversized non-foldable payload is refused locally");
    const body = await rBig.text();
    assert.match(body, /NOT forwarded/, "the verdict says the payload did not ride");
    return body;
}

test("pin #3977 P-IMG-a: image-dominated over-window payload with NO local evidence forwards for upstream arbitration (#496/#1800)", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        ctx.headers["x-acp-session"] = "p3977-img-a";
        const rSeed = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();

        const rImg = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: imageContent() }] });
        assert.equal(rImg.status, 200, "image-dominated payload rides: the upstream arbitrates billing");
        await rImg.text();
        assert.equal(streamCalls(up.calls), 2, "the image payload reached the upstream");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("pin #3977 P-IMG-b: after a scoped local 413 the SAME image payload stays refused — the image hatch consults the evidence (#3846 guard)", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "p3977-img-b");
        assert.equal(streamCalls(up.calls), 1, "only the seed reached the upstream");

        const rImg = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: imageContent() }] });
        assert.equal(rImg.status, 413, "the scoped refusal outranks the image-arbitration bet");
        const body = await rImg.text();
        assert.match(body, /NOT forwarded/, "the verdict says the payload did not ride");
        assert.equal(streamCalls(up.calls), 1, "zero new upstream calls — the hatch never re-bets");

        const s = getSession("p3977-img-b")!;
        const refusals = s.metadata.localRefusals as unknown[];
        assert.ok(Array.isArray(refusals) && refusals.length === 1, "the evidence store still holds exactly one scoped record");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("pin #3977 P-DIV: after a scoped local 413, a payload that folds under the window — current post-refusal fold semantics, observed and locked", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "p3977-div");
        assert.equal(streamCalls(up.calls), 1, "only the seed reached the upstream");

        // Foldable history (~6 x 3K tokens = ~18K core tokens, compressible) —
        // the walk can fold it under the 20K window.
        const rFold = await post(ctx, { model: "gpt-test", stream: true, messages: foldableHistory() });
        const foldBody = await rFold.text();
        // OBSERVED on the integration branch (550860ed): the payload folds
        // under the window and the POST-FOLD view forwards (200). The scoped
        // refusal closes the forward-once ESCAPE hatches (probe/image/#1839),
        // not the legitimate folded forward — pinning exactly that boundary.
        assert.equal(rFold.status, 200, "the folded post-refusal payload forwards");
        assert.ok(up.calls.some((c) => c.summary), "the walk really folded (a summarization call ran)");
        assert.equal(streamCalls(up.calls), 2, "seed + folded forward are the only rides");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("pin #3977 P-LEARN (step-4 flip): two agreeing stated-count 400s teach the ring and flip an under-window payload to fold-first; a window-only 400 never teaches", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        // ---------------- control session: a window-only 400 arms but teaches
        // nothing. (One detour is the honest control: the second would be
        // locally 413'd by the arm it just set — that refusal is itself the
        // emergency shrink working, not a learning event.)
        ctx.headers["x-acp-session"] = "p3977-learn-ctl";
        const rSeedC = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeedC.status, 200, "control seed forwards");
        await rSeedC.text();
        up.arm400();
        const rCtl1 = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: detourContent() }] });
        assert.equal(rCtl1.status, 400, "control detour rides and gets the window-only 400");
        await rCtl1.text();
        const ctlSession = getSession("p3977-learn-ctl");
        // A later out-of-band usage settle may legitimately have created an
        // EMPTY ring (current settleUsageReport semantics); the pin is that no
        // SAMPLE was ever collected and nothing was published from the 400.
        assert.ok(!ctlSession?.stats.calibrationRing || ctlSession.stats.calibrationRing.values.length === 0, `window-only 400s never collect a sample (ring ${JSON.stringify(ctlSession?.stats.calibrationRing)})`);
        assert.equal(ctlSession?.stats.calibratedEstimate, undefined, "window-only 400s publish nothing");
        const summariesBeforeCtl = up.calls.filter((c) => c.summary).length;
        const rCtlB = await post(ctx, { model: "gpt-test", stream: true, messages: underWindowFoldable() });
        assert.equal(rCtlB.status, 200, "control under-window payload forwards");
        await rCtlB.text();
        assert.equal(up.calls.filter((c) => c.summary).length, summariesBeforeCtl, "control: no fold happened — the arm alone changes nothing below the window");

        // ---------------- learn session: two agreeing stated-count 400s
        ctx.headers["x-acp-session"] = "p3977-learn";
        const rSeed = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();
        // Detour FIRST (before any local refusal exists — P-IMG-b proved the
        // evidence would block the ride): the image payload rides by
        // arbitration and the upstream answers with the #3738-shaped 400 whose
        // body STATES the rejected payload's own counts. Two of them = two
        // agreeing samples = a published k-hat.
        for (let i = 0; i < 2; i++) {
            up.arm400Stated();
            const rImg = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: detourContent() }] });
            const imgBody = await rImg.text();
            assert.equal(rImg.status, 400, `stated-count detour ${i + 1} rides and is answered with the counted 400 — got: ${imgBody.slice(0, 400)}`);
            // #1110 recovery between detours: a successful usage report
            // retires the one-shot arm, else detour 2 is locally 413'd by the
            // very baseline detour 1 armed (#3450/#3738 — the emergency shrink
            // doing its job). The tiny payload's settle never touches the ring
            // (pendingEst < CALIBRATION_MIN_ESTIMATE).
            const rRec = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "recovery ping" }] });
            assert.equal(rRec.status, 200, `recovery ${i + 1} forwards and retires the arm`);
            await rRec.text();
        }
        const learnSession = getSession("p3977-learn");
        const ring = learnSession?.stats.calibrationRing;
        assert.ok(ring && ring.values.length === 2, `the ring collected both samples (${JSON.stringify(ring?.values)})`);
        const k = learnSession?.stats.calibratedEstimate;
        assert.ok(typeof k === "number" && k >= 2 && k <= 2.5, `k-hat published from the stated counts (got ${k})`);
        assert.equal(learnSession?.stats.calibratedEstimateModel, "gpt-test", "published factor is model-keyed");

        // THE FLIP: the same under-window payload that forwarded directly in
        // the control session now judges OVER the window once calibrated —
        // preflight folds it first and the forward happens after the summary.
        const summariesBefore = up.calls.filter((c) => c.summary).length;
        const rB = await post(ctx, { model: "gpt-test", stream: true, messages: underWindowFoldable() });
        assert.equal(rB.status, 200, "the calibrated over-window payload folds and forwards");
        await rB.text();
        assert.ok(up.calls.filter((c) => c.summary).length > summariesBefore, "the fold ran a real summary call first (fold-first, no forward-then-refold)");

        // The oversized NON-FOLDABLE payload stays refused — and the dead-end
        // replay (second identical request) returns the stored title verbatim.
        const rBig1 = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig1.status, 413, "oversized payload still refused locally");
        const title1 = await rBig1.text();
        const rBig2 = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig2.status, 413, "still refused locally");
        const title2 = await rBig2.text();
        assert.equal(title1, title2, "the dead-end replay returns the stored refusal verbatim");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

// P-LEARN's companion edge (review fix 19bea679, upgraded for the step-4b
// flip): the refusal TITLE is where a one-time uptake of the 400 would show.
// Two directions, both pinned against a session that NEVER saw any 400:
//   (i)  a window-only 400 (no per-part counts) never teaches — byte-identical
//        title, exactly the pre-flip world the original pin captured;
//   (ii) TWO agreeing stated-count 400s publish k-hat and the treated title's
//        estimate numbers move AWAY from the control — the flip, observed.
test("pin #3977 P-LEARN-b: a window-only 400 never moves the refusal title; two stated-count 400s do (k-hat recalibrates the quoted estimate)", async () => {
    // Control: seed, then the oversized non-foldable payload — the unlearned
    // reference title.
    const upA = makeUpstream();
    const portA = await listen(upA);
    const a = await setup({ [`http://127.0.0.1:${portA}`]: { models: { "gpt-test": { context: WINDOW } } } });
    let titleControl = "";
    try {
        a.ctx.headers["x-acp-session"] = "p3977-learn-control";
        const rSeed = await post(a.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();
        const rBig = await post(a.ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig.status, 413, "oversized payload refused locally");
        titleControl = await rBig.text();
    } finally {
        upA.server.close();
        upA.server.closeIdleConnections?.();
        await a.close();
    }

    // (i) Window-only 400: arms the shrink but carries no per-part counts —
    // nothing for the learner to pair. The title must stay byte-identical.
    const upB = makeUpstream();
    const portB = await listen(upB);
    const b = await setup({ [`http://127.0.0.1:${portB}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        b.ctx.headers["x-acp-session"] = "p3977-learn-treat-wo";
        const rSeed = await post(b.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();
        upB.arm400();
        const rImg = await post(b.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: imageContent() }] });
        assert.equal(rImg.status, 400, "the detour rides and gets the window-only 400");
        await rImg.text();
        const rBig = await post(b.ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig.status, 413, "still refused locally");
        const titleTreated = await rBig.text();
        assert.equal(titleTreated, titleControl, "a 400 without per-part counts never teaches the estimator");
    } finally {
        upB.server.close();
        upB.server.closeIdleConnections?.();
        await b.close();
    }

    // (ii) Two agreeing stated-count 400s (recovery between them retires the
    // one-shot arm, #1110): k-hat publishes, the big payload's quoted
    // estimate scales, and the refusal title MOVES away from the control.
    const upC = makeUpstream();
    const portC = await listen(upC);
    const c = await setup({ [`http://127.0.0.1:${portC}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        c.ctx.headers["x-acp-session"] = "p3977-learn-treat-sc";
        const rSeed = await post(c.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();
        for (let i = 0; i < 2; i++) {
            upC.arm400Stated();
            const rImg = await post(c.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: imageContent() }] });
            assert.equal(rImg.status, 400, `stated-count detour ${i + 1} rides and gets the counted 400`);
            await rImg.text();
            const rRec = await post(c.ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "recovery ping" }] });
            assert.equal(rRec.status, 200, `recovery ${i + 1} retires the arm`);
            await rRec.text();
        }
        const treated = getSession("p3977-learn-treat-sc");
        assert.ok(typeof treated?.stats.calibratedEstimate === "number", "k-hat published from the two stated-count 400s");
        const streamsBeforeBig = upC.calls.filter((x) => x.stream).length;
        const rBig = await post(c.ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig.status, 413, "the calibrated payload is still refused locally (it was always over the window)");
        const titleTreated = await rBig.text();
        assert.notEqual(titleTreated, titleControl, "the learned k-hat recalibrates the quoted estimate — the title moves away from the never-saw-400 control");
        assert.equal(upC.calls.filter((x) => x.stream).length, streamsBeforeBig, "the oversized payload never reached the upstream");
    } finally {
        upC.server.close();
        upC.server.closeIdleConnections?.();
        await c.close();
    }
});
