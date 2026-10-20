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
//   P-LEARN  boundary: an upstream 400 whose body states the real token count
//            teaches the estimator NOTHING today (titles byte-identical) —
//            @flip-target for learnFromOutcome(overflow-400).
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

type Call = { summary: boolean; stream: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// Upstream that can be flipped to answer the NEXT forwarded request with the
// production-shaped 400 that STATES the real token count in its body.
function makeUpstream(): { server: http.Server; calls: Call[]; arm400: () => void } {
    const calls: Call[] = [];
    let arm400 = false;
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
    return { server, calls, arm400: () => { arm400 = true; } };
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

test("pin #3977 P-LEARN: an upstream 400 that STATES the real token count teaches the estimator NOTHING today — titles byte-identical (@flip-target for step 4)", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        ctx.headers["x-acp-session"] = "p3977-learn";
        const rSeed = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(rSeed.status, 200, "the fitting seed forwards");
        await rSeed.text();

        // Detour FIRST (before any local refusal exists — P-IMG-b proved the
        // evidence would block the ride): the image payload rides by
        // arbitration and the upstream answers with the #3900-shaped 400 whose
        // body STATES the real token count.
        up.arm400();
        const rImg = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: imageContent() }] });
        const imgStatus = rImg.status;
        await rImg.text();
        // OBSERVED on the integration branch (550860ed): the image payload
        // rides and the upstream answers the stated-count 400 verbatim.
        assert.equal(imgStatus, 400, "the detour payload rides and is answered with the stated-count 400");
        assert.equal(up.calls.filter((c) => c.stream).length >= 2, true, "the detour payload reached the upstream");

        // Baseline title for the oversized non-foldable payload, AFTER the
        // stated-count 400 has had every chance to arm/teach.
        const rBig1 = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig1.status, 413, "oversized payload refused locally");
        const title1 = await rBig1.text();

        // The oversized non-foldable payload again: with learnFromOutcome
        // (step 4) the stated-count 400 becomes calibration evidence and the
        // numbers in this title MOVE. Today they must not.
        const rBig2 = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(rBig2.status, 413, "still refused locally");
        const title2 = await rBig2.text();
        assert.equal(title1, title2, "the stated-count 400 changed nothing in the estimator's verdict today");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});
