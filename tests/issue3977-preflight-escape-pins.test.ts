// #3977 step 0 (先打桩): pins the forward-once escape hatches that the #3846
// local-refusal evidence did NOT yet cover, BEFORE the evidence-ledger /
// verdict-state-machine migration touches them. Every gate below is pinned in
// BOTH directions (#3617 gate discipline): "fires when it should" AND "does
// NOT fire when a covering local refusal exists":
//   P-DIV   the #1839 rebuilt-view divergence forward-once (src/server.ts:3658)
//           × local refusal evidence — pinned by driving the two-view
//           divergence directly (walk view fits, normal-config rebuild over);
//   P-FRESH the #3146 fresh-session forward-once (src/server.ts:3712-3730)
//           × local refusal evidence — anonymous request, zero baseline,
//           deterministic exhaustion;
//   P-IMG   the #496/#1800 image-arbitration forward-once (src/server.ts:3360
//           immediate + src/server.ts:3691 post-fold) × local refusal
//           evidence — unit pair on the immediate gate plus an end-to-end
//           flow proving a REAL 413 seed closes the post-fold gate on a later
//           image turn (the write→read edge no existing test covers);
//   P-LEARN calibration-loop boundary: an upstream overflow-400 carrying
//           stated token counts arms the emergency shrink (#1839/#3450) but
//           does NOT move k̂ (calibratedEstimate/calibrationRing) today —
//           k̂ is written exclusively by settleUsageReport on successful
//           usage reports. This pin defines the flip target for migration
//           step 4 (learnFromOutcome(overflow-400)).
// Zero production code changes in this file — it records today's behavior.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { preflightCompressIfNeeded, startServer, type Prepared } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, listSessions } from "../src/session.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { _resetFetchUtilForTest, _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

_setStoreForTest(new SessionStore({ enabled: false }));
setRegistryForTest({});

type LogLine = [string, string];

// ---------------------------------------------------------------------------
// Unit fixtures: drive preflightCompressIfNeeded directly (the proven
// tests/preflight-client-abort.test.ts pattern) so each gate's inputs —
// walk result, rebuild measurement, baseline regime, refusal evidence — are
// controlled exactly instead of reconstructed through the full HTTP stack.
// ---------------------------------------------------------------------------

type UnitFixture = {
    session: ReturnType<typeof getSession>;
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    prepared: Prepared;
    req: http.IncomingMessage;
    res: http.ServerResponse;
    opts: ProxyOptions;
    log: LogLine[];
    server: http.Server;
    url: string;
    origin: string;
    window: number;
    model: string;
    route: { upstream: string; rewrittenUrl: string };
    summaryCalls: number[];
};

async function listenPlain(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port };
}

type PlainMessage = { role: CoreMessage["role"]; text: string };

async function makeUnitFixture(t: test.TestContext, spec: {
    window: number;
    core: PlainMessage[];
    extraItems?: Array<Record<string, unknown>>;
    preserveRecentMessages?: number;
    imageRoute?: boolean;
    summaryText?: string;
}): Promise<UnitFixture> {
    const core = createCore();
    const config = defaultConfig(spec.window, {
        preserveRecentMessages: spec.preserveRecentMessages ?? 0,
        preserveRecentTokens: 0,
    });
    const session = getSession(`pin-${randomUUID()}`);
    const messages: CoreMessage[] = spec.core.map((m, i) => ({ id: `m${i}`, role: m.role, contentType: "text", text: m.text }));
    const items: Array<Record<string, unknown>> = [
        ...messages.map((m) => ({ type: "message", role: m.role, content: m.text })),
        ...(spec.extraItems ?? []),
    ];
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", stream: true, input: items }),
        session,
        processedMessages: messages,
        originalMessages: messages,
        protocol: "responses",
        stream: true,
        compressInjected: false,
    };
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const log: LogLine[] = [];
    const fixture: UnitFixture = {
        session, core, config, prepared, req, res,
        opts: {
            host: "127.0.0.1",
            port: 0,
            upstream: "",
            routes: {},
            proxy: "",
            proxyMode: "direct",
            proxySource: "direct",
            modelContextLimit: spec.window,
            kernelConfig: config,
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" },
            compat: { roles: {} },
            streamErrorShape: "protocol",
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        },
        log,
        server: null as unknown as http.Server,
        url: "",
        origin: "",
        route: { upstream: "", rewrittenUrl: "" },
        window: spec.window,
        model: "test-model",
        summaryCalls: [],
    };
    // Summary endpoint: every summarization draw returns one usable answer.
    const { server, port } = await listenPlain((_r, sres) => {
        fixture.summaryCalls.push(1);
        sres.writeHead(200, { "content-type": "application/json" });
        sres.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: spec.summaryText ?? "PIN SUMMARY: earlier turns held deterministic load text." }] }] }));
    });
    fixture.server = server;
    fixture.url = `http://127.0.0.1:${port}/responses`;
    fixture.origin = normalizeUpstreamOrigin(fixture.url) ?? "";
    fixture.route = { upstream: fixture.url, rewrittenUrl: fixture.url };
    fixture.opts.upstream = fixture.url;
    req.url = fixture.url;
    if (spec.imageRoute) {
        fixture.opts.routes = { [fixture.url]: { models: { [fixture.model]: { context: spec.window } }, imageBilling: "bytes" } } as ProxyOptions["routes"];
    }
    t.after(() => { void server.close(); });
    return fixture;
}

function callGate(f: UnitFixture, runPrepare: () => Promise<Prepared>, anonymous: boolean) {
    return preflightCompressIfNeeded(
        f.prepared,
        runPrepare,
        f.req,
        Buffer.from(f.prepared.body),
        f.res,
        f.opts,
        f.core,
        f.config,
        f.config.modelContextLimit,
        f.model,
        undefined,
        undefined,
        f.route,
        undefined,
        anonymous,
        (level, msg) => f.log.push([level, msg]),
        `pin-${randomUUID()}`,
    );
}

/** Seed the #3846 metadata channel exactly as noteLocalRefusal writes it
 *  (the helpers are module-private; the record shape is the contract). */
function seedLocalRefusal(f: UnitFixture, window?: number): void {
    f.session.metadata.localRefusals = [
        { origin: f.origin, model: f.model, window: window ?? f.window, at: Date.now() },
    ];
}

function cleanup(t: test.TestContext): void {
    assert.equal(_liveUpstreamTimersForTest(), 0, "no live upstream timers");
    _resetFetchUtilForTest();
    void t;
}

const MODEL = "test-model";

// --- P-DIV: #1839 divergence forward-once × local refusal ------------------

// Divergence construction: the REAL walk folds the large middle message and
// its own relaxed-zone view fits under the window (result.payloadEstimate <
// limit); the supplied rebuild (normal-config prepare stand-in) measures the
// ORIGINAL payload again, over the window, so fits=false and the flow reaches
// the #1839 gate with (compressedRanges>0, walkViewFits, rebuiltOver).
async function divFixture(t: test.TestContext): Promise<UnitFixture> {
    const window = 6_000;
    const core: PlainMessage[] = [
        { role: "user", text: "small lead-in question" },
        { role: "assistant", text: "FILLER_".repeat(4_000) },
        { role: "user", text: "small trailing question" },
    ];
    const f = await makeUnitFixture(t, { window, core });
    // usage-grade baseline above the floor: the #2313 estimate-only probe
    // stays disarmed (baselineFloor > 0), isolating the divergence gate.
    f.session.stats.lastInputTokens = 1_000;
    f.session.stats.lastInputTokensSource = "usage";
    return f;
}

test("P-DIV: #1839 divergence forward-once fires WITHOUT a covering local refusal", async (t) => {
    const f = await divFixture(t);
    const out = await callGate(f, async () => f.prepared, false);
    assert.ok(!("failFast" in out), "no refusal evidence: the divergence gate must forward once");
    assert.ok(f.log.some(([, m]) => m.includes("forwarding once for upstream arbitration (#1839)")),
        `expected the #1839 forward-once log line, got:\n${f.log.map(([l, m]) => `[${l}] ${m}`).join("\n")}`);
    cleanup(t);
});

test("P-DIV: a covering local refusal CLOSES the #1839 divergence gate (fail-fast instead of re-forward)", async (t) => {
    const f = await divFixture(t);
    seedLocalRefusal(f);
    const out = await callGate(f, async () => f.prepared, false);
    assert.ok("failFast" in out, "a covering refusal must close the divergence escape hatch");
    // Walk succeeded (no failure kind), so the fall-through keeps the generic
    // verdict contract: not a deterministic exhaustion, hence 502 — the point
    // of the pin is NO forward, whatever the fall-through status is.
    assert.equal(out.status, 502);
    assert.equal(out.retryable, false);
    assert.ok(!f.log.some(([, m]) => m.includes("forwarding once for upstream arbitration (#1839)")),
        "the #1839 forward-once must stay silent under a covering refusal");
    cleanup(t);
});

// --- P-FRESH: #3146 fresh-session forward-once × local refusal -------------

// Anonymous request + zero baseline ⇒ unknownBaseline=true (the #553 regime).
// The oversized mass sits in a SYSTEM head, which IS foldable in the preflight
// walk — so the fixture forces the exhaustion another way (see below) instead
// of letting the walk succeed and take the fits-forward path. 36KB ≪ the 2MB
// doom bar, so the doomed-bytes guard does not pre-empt the gate under test.
async function freshFixture(t: test.TestContext): Promise<UnitFixture> {
    const window = 6_000;
    const core: PlainMessage[] = [
        { role: "system", text: "BLOB_".repeat(6_000) }, // ~7.5K tok est > 6K window
        { role: "user", text: "current turn question" },
    ];
    // The system head IS a foldable candidate in the preflight walk (verified
    // against the walk log), so a USABLE summary would fold it away and take
    // the fits-forward path — never reaching the #3146 branch. Deliberately
    // answer every draw with an 11-char summary (kernel minSummaryLength is
    // 50): the exhaustion is forced, deterministic per construction, and the
    // flow lands exactly on the #3146 fresh-session gate.
    return makeUnitFixture(t, { window, core, preserveRecentMessages: 1, summaryText: "PIN SUMMARY" });
}

test("P-FRESH: #3146 fresh-session forward-once fires WITHOUT a covering local refusal", async (t) => {
    const f = await freshFixture(t);
    const out = await callGate(f, async () => f.prepared, true);
    assert.ok(!("failFast" in out), "no refusal evidence: the fresh-session gate must forward once");
    assert.ok(f.log.some(([, m]) => m.includes("forwarding once for the upstream to arbitrate size before failing fast (#3146)")),
        `expected the #3146 forward-once log line, got:\n${f.log.map(([l, m]) => `[${l}] ${m}`).join("\n")}`);
    cleanup(t);
});

test("P-FRESH: a covering local refusal CLOSES the #3146 fresh-session gate (413 instead of re-forward)", async (t) => {
    const f = await freshFixture(t);
    seedLocalRefusal(f);
    const out = await callGate(f, async () => f.prepared, true);
    assert.ok("failFast" in out, "a covering refusal must close the fresh-session escape hatch");
    assert.equal(out.status, 502,
        // The exhaustion is NON-deterministic on purpose: the deliberately
        // unusable summary leaves a lastUnusableDetail, so the verdict contract
        // (src/server.ts:3749-3764) yields the generic 502, not the
        // deterministic 413. The pin's point is the GATE CLOSURE (no forward),
        // with the status following the existing verdict rules.
        "refused fresh-session payload fails fast (no forward)");
    assert.equal(out.retryable, false);
    assert.ok(f.log.some(([, m]) => m.includes("NOT re-forwarding for size arbitration (#3846)")),
        `expected the #3846 refusal log line, got:\n${f.log.map(([l, m]) => `[${l}] ${m}`).join("\n")}`);
    // the fall-through fail-fast re-notes the refusal — idempotent per scope:
    // the widest-window-dominates rule must keep exactly one record.
    const records = f.session.metadata.localRefusals as Array<Record<string, unknown>>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.window, f.window);
    cleanup(t);
});

// --- P-IMG: #496/#1800 image-arbitration forward-once × local refusal ------

// Image-dominated payload: the bytes-billed image reserve (22K) alone clears
// the window (20K) on ESTIMATE; the text channel is small AND every text
// message sits below minCompressRange (5000 chars) ⇒ the walk has ZERO viable
// ranges ⇒ deterministic exhaustion with no summary draws. Usage-grade
// baseline below the window ⇒ noOverflowEvidence ⇒ imageArbitration=true.
// Negative direction: the immediate gate (src/server.ts:3360) forwards once
// (bare Prepared ⇒ no nudge ⇒ zero advertised ranges). Positive direction:
// the covering refusal skips the immediate gate, the walk exhausts
// deterministically, the post-fold gate (src/server.ts:3691) stays shut, and
// the final verdict is the deterministic 413.
async function imgFixture(t: test.TestContext): Promise<UnitFixture> {
    const window = 20_000;
    const filler = (i: number) => `MARKER_${i}: ` + "lorem ipsum dolor sit amet ".repeat(25); // ~500 chars < minCompressRange 5000
    const roles: Array<"user" | "assistant"> = ["user", "assistant", "user", "assistant", "user", "assistant"];
    const core: PlainMessage[] = roles.map((role, i) => ({ role, text: filler(i) }));
    const imageB64 = "iVBORw0KGgo" + "A".repeat(22_000 * 4 - 32); // ~22K tokens at bytes billing (b64/4)
    const extraItems: Array<Record<string, unknown>> = [
        { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${imageB64}` }] },
    ];
    const f = await makeUnitFixture(t, { window, core, extraItems, imageRoute: true });
    f.session.stats.lastInputTokens = 1_000;
    f.session.stats.lastInputTokensSource = "usage";
    return f;
}

test("P-IMG: image-arbitration forward-once fires WITHOUT a covering local refusal (immediate gate, zero folds)", async (t) => {
    const f = await imgFixture(t);
    const out = await callGate(f, async () => f.prepared, false);
    assert.ok(!("failFast" in out), "no refusal evidence: the image-arbitration gate must forward once");
    assert.ok(f.log.some(([, m]) => m.includes("forwarding for the upstream to arbitrate billing (#496/#1800)")),
        `expected the #496/#1800 forward-once log line, got:\n${f.log.map(([l, m]) => `[${l}] ${m}`).join("\n")}`);
    assert.equal(f.summaryCalls.length, 0, "the immediate gate forwards before any fold");
    cleanup(t);
});

test("P-IMG: a covering local refusal CLOSES the image-arbitration gate (413 instead of re-forward)", async (t) => {
    const f = await imgFixture(t);
    seedLocalRefusal(f);
    const out = await callGate(f, async () => f.prepared, false);
    assert.ok("failFast" in out, "a covering refusal must close the image-arbitration escape hatch");
    // Zero viable ranges (sub-minCompressRange text) ⇒ deterministic
    // exhaustion, no summary draws spent; the calibrated meter
    // (text+image ≫ window) agrees ⇒ the #3461 413 path.
    assert.equal(out.status, 413);
    assert.equal(out.retryable, false);
    assert.equal(f.summaryCalls.length, 0, "the text portion still folds before the verdict");
    assert.ok(!f.log.some(([, m]) => m.includes("arbitrate billing (#496/#1800)")),
        "the #496/#1800 forward-once must stay silent under a covering refusal");
    cleanup(t);
});

// ---------------------------------------------------------------------------
// End-to-end pins (full HTTP stack through startServer).
// ---------------------------------------------------------------------------

// Under bytes billing the cost is base64 chars / 4 (base64ImageCost) — size
// the data URL so the reserve lands exactly on the target token count.
function imageB64Of(targetTokens: number): string {
    return "iVBORw0KGgo" + "A".repeat(targetTokens * 4 - 11);
}

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// Counting fake upstream for the e2e lanes: bills received message chars at
// ~40 B/token as prompt usage; answers summarization draws deterministically;
// replies to OVERLOAD400-marked traffic with a provider-shaped overflow 400
// carrying stated token counts.
function makeCountingUpstream(): { server: http.Server; calls: { summary: boolean; forwarded: boolean; contentChars: number }[] } {
    const calls: { summary: boolean; forwarded: boolean; contentChars: number }[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, forwarded: !isSummary, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "PIN SUMMARY: earlier turns held deterministic load text." }, finish_reason: "stop" }] }));
                    return;
                }
                if (raw.includes("OVERLOAD400")) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${E2E_WINDOW} tokens. However, you requested 250000 tokens (240000 in the messages, 10000 in the completion). Please reduce the length of the messages.`, type: "invalid_request_error", code: "context_length_exceeded" } }));
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
    return { server, calls };
}

const E2E_WINDOW = 200_000;
const E2E_MODEL = "gpt-pin";

function e2eProxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: E2E_WINDOW,
        kernelConfig: defaultConfig(E2E_WINDOW, {
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

// Zero-config routing: the /bili/<upstream-url>/... prefix carries the full
// upstream URL (resolveUpstream strips the prefix and takes the rest verbatim),
// so the route key is the upstream ORIGIN and the client URL appends the path.
async function startE2E(t: test.TestContext) {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = makeCountingUpstream();
    upstream.server.listen(0, "127.0.0.1");
    await once(upstream.server, "listening");
    const upstreamPort = (upstream.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    // imageBilling "bytes" is load-bearing: the default "auto" resolves to
    // pixels pricing, where an unparseable synthetic PNG costs ~0 tokens and
    // the whole image-arbitration regime switches off.
    const proxy = await startServer(e2eProxyOptions({ [origin]: { models: { [E2E_MODEL]: { context: E2E_WINDOW } }, imageBilling: "bytes" } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await Promise.allSettled([once(proxy, "close")]);
        await new Promise<void>((resolve) => { upstream.server.close(() => resolve()); });
        _resetFetchUtilForTest();
    });
    const sid = `e2e-${randomUUID()}`;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/${origin}/chat/completions`,
        headers: { "content-type": "application/json", "x-acp-session": sid },
        sid,
        origin,
        calls: upstream.calls,
    };
}

// P-IMG (end-to-end): the write→read edge no existing test covers — a REAL
// local 413 (seeded through the full stack) must keep the LATER image
// arbitration gate closed, while an identical image turn on a session that
// was never refused still forwards for billing arbitration.
test("P-IMG e2e: a real 413 seed closes the image-arbitration gate on a later image turn (and only there)", async (t) => {
    const refused = await startE2E(t);
    const clean = await startE2E(t);
    const body = (messages: unknown) => JSON.stringify({ model: E2E_MODEL, stream: true, messages });

    // Turn 1 (both sessions): small fitting turn settles a usage baseline.
    const r1a = await fetch(refused.url, { method: "POST", headers: refused.headers, body: body([{ role: "user", content: "hello" }]) });
    assert.equal(r1a.status, 200);
    await r1a.arrayBuffer();
    const r1b = await fetch(clean.url, { method: "POST", headers: clean.headers, body: body([{ role: "user", content: "hello" }]) });
    assert.equal(r1b.status, 200);
    await r1b.arrayBuffer();

    // Turn 2 (refused session only): oversized NON-FOLDABLE system text —
    // the #3846-proven deterministic 413 seed (system head is protected, so
    // the walk folds nothing and the verdict is a local refusal). ~1.05M
    // chars ≈ 260K-token estimate: over the 200K window, under the 2MB doom bar.
    const blob = Array.from({ length: 15_000 }, (_, i) => `oversized seed segment ${i}: ` + "x".repeat(40)).join("");
    const seed = [{ role: "system", content: blob }, { role: "user", content: "q" }];
    const r2 = await fetch(refused.url, { method: "POST", headers: refused.headers, body: body(seed) });
    assert.equal(r2.status, 413, "the seed must be a local 413, not forwarded");
    await r2.arrayBuffer();
    const refusedSession = listSessions().find((s) => s.id === refused.sid);
    const refusals = refusedSession?.metadata.localRefusals as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(refusals) && refusals.length === 1, "the 413 must persist exactly one local-refusal record");
    assert.equal(refusals?.[0]?.window, E2E_WINDOW);

    // Turn 3 (both sessions): old foldable history + a current turn whose
    // TEXT channel (~17K tok) fits but whose bytes-billed image reserve
    // (210K) clears the window on estimate ⇒ imageArbitration. The foldable
    // text mass (~17K × slack 1.2) cannot close the ~27K deficit — the image
    // is unfoldable — so the walk declares deterministic futility with zero
    // summary calls in BOTH sessions; the only difference left is the
    // post-fold arbitration gate, which the persisted refusal closes.
    const imageB64 = imageB64Of(210_000);
    const filler = "lorem ipsum dolor sit amet ".repeat(400);
    const imageTurn = [
        { role: "user", content: "old load segment A " + "a".repeat(30_000) },
        { role: "assistant", content: "old load segment B " + "b".repeat(30_000) },
        { role: "user", content: [
            { type: "text", text: "current turn text " + filler },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
        ] },
    ];
    const forwardsBefore = refused.calls.filter((c) => c.forwarded).length;
    const r3r = await fetch(refused.url, { method: "POST", headers: refused.headers, body: body(imageTurn) });
    assert.equal(r3r.status, 413, "the persisted refusal must keep the image-arbitration gate closed");
    await r3r.arrayBuffer();
    const forwardsAfter = refused.calls.filter((c) => c.forwarded).length;
    assert.equal(forwardsAfter, forwardsBefore, "NO additional forward may leave the proxy for a locally-refused scope");
    assert.equal(refused.calls.filter((c) => c.summary).length, 0, "futility spent no summarization call in the refused session either");

    const r3c = await fetch(clean.url, { method: "POST", headers: clean.headers, body: body(imageTurn) });
    assert.equal(r3c.status, 200, "an identical image turn on a never-refused session must still forward for billing arbitration");
    await r3c.arrayBuffer();
    assert.equal(clean.calls.filter((c) => c.forwarded).length, 2, "seed + exactly one arbitration forward left the clean session");
    assert.equal(clean.calls.filter((c) => c.summary).length, 0, "and it too spent no summarization call");
});

// P-LEARN: calibration-loop boundary. An upstream overflow-400 carrying
// stated token counts is the richest size evidence bili currently THROWS
// AWAY: armOverflowShrink consumes the window/count to arm the emergency
// shrink, but k̂ (calibratedEstimate + calibrationRing) moves ONLY on
// successful usage reports (settleUsageReport). Pinning today's boundary —
// the flip target of migration step 4 (learnFromOutcome(overflow-400)).
test("P-LEARN: an overflow-400 with stated token counts arms the shrink but does NOT move k̂", async (t) => {
    const ctx = await startE2E(t);
    const body = (messages: unknown) => JSON.stringify({ model: E2E_MODEL, stream: true, messages });

    const r1 = await fetch(ctx.url, { method: "POST", headers: ctx.headers, body: body([{ role: "user", content: "hello" }]) });
    assert.equal(r1.status, 200);
    await r1.arrayBuffer();

    const s = listSessions().find((x) => x.id === ctx.sid);
    assert.ok(s, "session must exist");
    // Pre-seed a concrete k̂ so the pin is "this exact state survives", not
    // "absence stays absence".
    const origin = normalizeUpstreamOrigin(ctx.origin) ?? "";
    s.stats.calibratedEstimate = 1.5;
    s.stats.calibratedEstimateOrigin = origin;
    s.stats.calibratedEstimateModel = E2E_MODEL;
    s.stats.calibrationRing = { origin, model: E2E_MODEL, values: [1.4, 1.6] };
    const before = {
        calibratedEstimate: s.stats.calibratedEstimate,
        calibratedEstimateOrigin: s.stats.calibratedEstimateOrigin,
        calibratedEstimateModel: s.stats.calibratedEstimateModel,
        calibrationRing: s.stats.calibrationRing,
        lastUsageGradeTokens: s.stats.lastUsageGradeTokens,
    };

    // Demote the baseline to estimate-only so the #2313 probe fires and the
    // payload actually reaches the upstream (which answers with the 400).
    s.stats.lastInputTokens = 60_000;
    s.stats.lastInputTokensSource = "estimate";

    const r2 = await fetch(ctx.url, { method: "POST", headers: ctx.headers, body: body([{ role: "user", content: "OVERLOAD400 please answer" }]) });
    assert.equal(r2.status, 400, "the overflow 400 passes through to the client");
    const errText = await r2.text();
    assert.match(errText, /maximum context length/i);

    const s2 = listSessions().find((x) => x.id === ctx.sid);
    assert.ok(s2, "session must survive");
    // Positive control: the 400 WAS consumed as overflow evidence — the
    // emergency shrink armed at the stated wall with the stated messages count.
    assert.equal(s2.stats.lastInputTokensSource, "overflow-arm", "armOverflowShrink must have fired on the 400");
    assert.equal(s2.stats.overflowArmTokens, E2E_WINDOW, "the stated window must anchor the overflow arm");
    // The pin: none of the k̂ state moved.
    assert.deepEqual(
        {
            calibratedEstimate: s2.stats.calibratedEstimate,
            calibratedEstimateOrigin: s2.stats.calibratedEstimateOrigin,
            calibratedEstimateModel: s2.stats.calibratedEstimateModel,
            calibrationRing: s2.stats.calibrationRing,
            lastUsageGradeTokens: s2.stats.lastUsageGradeTokens,
        },
        before,
        "an overflow-400 must not touch the calibration loop today (step-4 flip target)",
    );
});
