import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { type ProxyOptions } from "../src/config.ts";
import { DOOMED_PROBE_ABSOLUTE_BYTES, DOOMED_PROBE_BYTES_PER_TOKEN } from "../src/preflight.ts";
import { type Prepared } from "../src/server.ts";
import { forward } from "../src/server/relay.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";

// #4079 PR① (hub fix-plan step 1): the send-side final window gate. Preflight
// judges on the calibrated ESTIMATE scale; this suite pins the byte-math backstop
// in forward(): a FINAL outbound core-text mass above max(2MB, window×7.5) bytes
// is refused locally with an honest 413 (stage "send-window-guard"), records a
// LocalRefusalRecord for the scope, and burns ZERO upstream calls — while every
// excluded lane (passthrough / side / undeclared-window / under-bar) keeps
// forwarding exactly as before. Gate discipline #3617: both directions asserted.
process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

async function withUpstream(run: (url: string, mainCalls: () => number) => Promise<void>) {
    let mainCalls = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
            if (body.stream) mainCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`, () => mainCalls);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeIdleConnections?.();
        server.closeAllConnections();
        await closed;
    }
}

const WINDOW = 100_000;
const BAR = Math.max(DOOMED_PROBE_ABSOLUTE_BYTES, WINDOW * DOOMED_PROBE_BYTES_PER_TOKEN);

interface Fixture {
    session: ReturnType<typeof getSession>;
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    log: (level: string, message: string) => void;
}

function fixture(): Fixture {
    const session = getSession(`send-guard-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(WINDOW, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    // handle.ts stamps the FINAL effective window (post self-heal + headroom)
    // onto the session right before the pipeline; the gate reads exactly this.
    session.metadata.effectiveContextLimit = WINDOW;
    session.metadata.lastModel = "test-model";
    const logs: string[] = [];
    const log = (_level: string, message: string) => { logs.push(message); };
    return { session, core, config, log };
}

function makePrepared(f: Fixture, coreTextBytes: number): Prepared {
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "big", role: "assistant", contentType: "text", text: "x".repeat(coreTextBytes) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const body = JSON.stringify({ model: "test-model", stream: true, input: messages.map(m => ({ role: m.role, content: m.text })) });
    return { body, session: f.session, processedMessages: messages, originalMessages: messages, protocol: "responses", stream: true, compressInjected: false };
}

function makeOpts(upstreamUrl: string): ProxyOptions {
    return {
        host: "127.0.0.1", port: 0, upstream: upstreamUrl, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: WINDOW, kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
}

function makeReqRes(url: string) {
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    let ended = "";
    const origEnd = res.end.bind(res);
    res.end = ((chunk?: unknown) => {
        if (chunk !== undefined && chunk !== null) ended += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        return origEnd(chunk as never);
    }) as typeof res.end;
    return { req, res, body: () => ended };
}

test("provably over-window payload is refused locally before any upstream call", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture();
        const prepared = makePrepared(f, BAR + 1_000_000);
        const { req, res, body } = makeReqRes(url);
        await forward(req, res, makeOpts(url), prepared.body, prepared, f.core, f.config, f.log, undefined, "send-guard-test", undefined, undefined, undefined);
        assert.equal(mainCalls(), 0, "a mathematically-doomed payload must not burn an upstream round-trip");
        assert.equal(res.statusCode, 413);
        const err = JSON.parse(body()) as { error: { type: string; stage: string; message: string } };
        assert.equal(err.error.type, "request_too_large");
        assert.equal(err.error.stage, "send-window-guard");
        assert.ok(err.error.message.includes("#4079"));
        const refusals = f.session.metadata.localRefusals as Array<{ origin: string; model: string; window: number }>;
        assert.equal(refusals.length, 1, "the refusal must be remembered for the scope (#3846)");
        assert.equal(refusals[0].model, "test-model");
        assert.equal(refusals[0].window, WINDOW);
        assert.ok(refusals[0].origin.startsWith("http://127.0.0.1"));
    });
});

test("under-bar payload forwards normally and records no refusal", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture();
        const prepared = makePrepared(f, BAR - 1_000_000);
        const { req, res } = makeReqRes(url);
        await forward(req, res, makeOpts(url), prepared.body, prepared, f.core, f.config, f.log, undefined, "send-guard-test", undefined, undefined, undefined);
        assert.equal(mainCalls(), 1);
        assert.equal(res.statusCode, 200);
        assert.equal(f.session.metadata.localRefusals, undefined, "an accepted payload must not poison the refusal ledger");
    });
});

test("passthrough without a session is untouched by the gate", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture();
        const big = JSON.stringify({ model: "test-model", stream: true, input: [{ role: "user", content: "x".repeat(BAR + 1_000_000) }] });
        const { req, res } = makeReqRes(url);
        await forward(req, res, makeOpts(url), big, null, f.core, f.config, f.log, undefined, "send-guard-test", undefined, undefined, undefined);
        assert.equal(mainCalls(), 1, "byte-exact passthrough carries no declared window — behavior unchanged");
        assert.equal(res.statusCode, 200);
        assert.equal(f.session.metadata.localRefusals, undefined);
    });
});

test("side requests stay owned by #1110 — gate does not fire", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture();
        const prepared = makePrepared(f, BAR + 1_000_000);
        prepared.sidePassthrough = true;
        const { req, res } = makeReqRes(url);
        await forward(req, res, makeOpts(url), prepared.body, prepared, f.core, f.config, f.log, undefined, "send-guard-test", undefined, undefined, undefined);
        assert.equal(mainCalls(), 1);
        assert.equal(res.statusCode, 200);
        assert.equal(f.session.metadata.localRefusals, undefined);
    });
});

test("no declared window stamp means no gate — behavior unchanged", async () => {
    await withUpstream(async (url, mainCalls) => {
        const f = fixture();
        delete f.session.metadata.effectiveContextLimit;
        const prepared = makePrepared(f, BAR + 1_000_000);
        const { req, res } = makeReqRes(url);
        await forward(req, res, makeOpts(url), prepared.body, prepared, f.core, f.config, f.log, undefined, "send-guard-test", undefined, undefined, undefined);
        assert.equal(mainCalls(), 1, "without a declared window there is no wall to judge against");
        assert.equal(res.statusCode, 200);
        assert.equal(f.session.metadata.localRefusals, undefined);
    });
});
