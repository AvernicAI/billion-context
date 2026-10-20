import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER } from "../src/server.ts";
import { BILI_TUNNEL_HEADER } from "../src/tunnel-guard.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { finalizeResponsesWsUpstreamHeaders } from "../src/responses-ws.ts";
import { type FetchOptions } from "../src/fetch-util.ts";

/** #3905: bili's private protocol surface (the whole `x-bili-*` namespace) must
 *  never reach a real model endpoint. Hosts stamp `x-bili-plugin*` convention
 *  headers (marker / conversation id / window / model / the new declared-tools
 *  channel from #3906/#3907) that are consumed ONCE at this instance's ingress —
 *  forwarding them onward leaks host-private state to the provider. The main
 *  HTTP lane built its outbound headers by copying every inbound header except
 *  content-length/host, so the entire family rode through to the model endpoint.
 *
 *  The two EXCEPTIONS are the bili→bili chain markers (`x-bili-hop`,
 *  `x-bili-tunnel`): their sole consumer is a DOWNSTREAM bili's ingress
 *  pass-through decision (#300/#1086), so they must survive transit even though
 *  they leak harmlessly onto a terminal provider (providers ignore unknown
 *  headers; hop carries only an opaque instance id, tunnel literally "1"). We
 *  cannot reliably tell "next hop is a bili" from "next hop is a real provider"
 *  at egress, so stripping them would risk re-opening the double-compression bug
 *  the marker exists to prevent.
 *
 *  Pinned directions:
 *   - host path no longer emits any `x-bili-plugin*` (incl. the new exposed-tools);
 *   - the chain markers survive transit (inbound hop still present on egress);
 *   - WS lane presents the same surface (non-Azure keeps chain markers, Azure
 *     strips everything incl. markers for the documented custom-header cap). */

const MODEL = "gpt-test";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function makeOpts(upstream: string): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", headers: req.headers });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

const OPENAI_BODY = JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: "hello world" },
    ],
});

async function withRig(fn: (port: number, captured: Captured[]) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const srv = await startServer(makeOpts(llmUrl));
    await once(srv, "listening");
    try {
        await fn((srv.address() as { port: number }).port, captured);
    } finally {
        srv.closeAllConnections?.();
        await close(srv);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
}

test("#3905: proxy lane — stray x-bili-plugin* metadata never reaches the model endpoint", async () => {
    await withRig(async (port, captured) => {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "issue3905-proxy-stray",
                // No x-bili-plugin marker → stays a plain proxy-lane request.
                "x-bili-plugin-conversation": "conv-abc123",
                "x-bili-plugin-model": MODEL,
                "x-bili-plugin-context-window": "400000",
                "x-bili-plugin-exposed-tools": "compress,decompress,acp_status",
                // End-to-end header the client genuinely wants upstream.
                "x-client-keep": "yes",
            },
            body: OPENAI_BODY,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1, "the model endpoint was contacted");
        const h = captured[0]!.headers;
        assert.equal(h["x-bili-plugin-conversation"], undefined, "host conversation id must not leak");
        assert.equal(h["x-bili-plugin-model"], undefined, "host model declaration must not leak");
        assert.equal(h["x-bili-plugin-context-window"], undefined, "host window declaration must not leak");
        assert.equal(h["x-bili-plugin-exposed-tools"], undefined, "#3906 declared-tools channel must not leak upstream");
        assert.equal(h["x-client-keep"], "yes", "client end-to-end headers are unaffected");
    });
});

test("#3905: plugin lane — the full x-bili-plugin* family a host stamps is stripped at egress", async () => {
    await withRig(async (port, captured) => {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "dsh",
                "x-bili-plugin-conversation": "sess-host-1",
                "x-bili-plugin-model": MODEL,
                "x-bili-plugin-max-output": "8192",
                "x-bili-plugin-exposed-tools": "compress",
            },
            body: OPENAI_BODY,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1, "plugin-lane model call still reaches the model endpoint");
        const h = captured[0]!.headers;
        for (const k of Object.keys(h)) {
            assert.ok(!k.toLowerCase().startsWith("x-bili-plugin"), `host-private ${k} leaked to the model endpoint`);
        }
    });
});

test("#3905: the strip preserves the bili→bili chain marker (inbound x-bili-hop survives egress)", async () => {
    await withRig(async (port, captured) => {
        // A request already carrying x-bili-hop means an upstream bili processed
        // it — this instance passes through. The marker MUST still be on the
        // outbound bytes so a further downstream bili keeps detecting the chain.
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "issue3905-chain-hop",
                [BILI_HOP_HEADER]: "upstream-bili-instance",
                "x-bili-plugin-conversation": "conv-should-still-be-stripped",
            },
            body: OPENAI_BODY,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        const h = captured[0]!.headers;
        assert.equal(h[BILI_HOP_HEADER], "upstream-bili-instance", "chain marker survives transit (#300/#1086)");
        assert.equal(h["x-bili-plugin-conversation"], undefined, "...while host-private metadata is still stripped");
    });
});

test("#3905: WS egress — non-Azure strips x-bili-plugin* but keeps the chain markers", async () => {
    const raw: FetchOptions["headers"] = {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "x-bili-plugin": "opencode",
        "x-bili-plugin-conversation": "ses_abc",
        "x-bili-plugin-exposed-tools": "compress,decompress",
        [BILI_HOP_HEADER]: "instance-xyz",
        [BILI_TUNNEL_HEADER]: "1",
    };
    const out = finalizeResponsesWsUpstreamHeaders("wss://api.openai.com/v1/responses", raw);
    assert.equal(out["authorization"], "Bearer secret-token", "auth stays intact");
    assert.equal(out["x-bili-plugin"], undefined, "host marker stripped");
    assert.equal(out["x-bili-plugin-conversation"], undefined, "host conversation stripped");
    assert.equal(out["x-bili-plugin-exposed-tools"], undefined, "declared-tools channel stripped");
    assert.equal(out[BILI_HOP_HEADER], "instance-xyz", "chain hop marker kept for transit");
    assert.equal(out[BILI_TUNNEL_HEADER], "1", "tunnel marker kept for transit");
});

test("#3905: WS egress — Azure keeps stripping EVERY x-bili-* (custom-header cap, #2359)", async () => {
    const raw: FetchOptions["headers"] = {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "x-bili-plugin": "opencode",
        "x-bili-plugin-conversation": "ses_abc",
        [BILI_HOP_HEADER]: "instance-xyz",
        [BILI_TUNNEL_HEADER]: "1",
    };
    const out = finalizeResponsesWsUpstreamHeaders("wss://myres.openai.azure.com/v1/responses", raw);
    assert.equal(out["authorization"], "Bearer secret-token", "auth stays intact");
    for (const k of Object.keys(out)) {
        assert.ok(!k.toLowerCase().startsWith("x-bili-"), `azure caps custom WS headers — ${k} must be stripped`);
    }
});
