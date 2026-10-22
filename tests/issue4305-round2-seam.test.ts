// #4305: standing generation-boundary note — round-2 cache-seam parity.
// Once the one-shot detection fires (≥2 distinct above-frontier ref citations
// in the visible history, here seeded as previous-generation receipt/status
// residue in the early turns), the static note must ride EVERY rebuild of the
// ACP standing system block in the exact steady-path order (prompt → note →
// absorb). The compress-loop round-2 rebuild recomposes the system element by
// hand, so this pins that its output stays byte-identical to the steady
// prepare-anthropic system on a boundary-active session — the same seam class
// #3298/#2499 fixed for attribution and cache marks.
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { GENERATION_BOUNDARY_NOTE } from "../src/generation-boundary.ts";
import { PROJECT_ATTRIBUTION_LINE } from "../src/compress-tool.ts";

const anthropicSse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

// Previous-generation residue: citations STRICTLY ABOVE this session's frontier
// (m00001..m00007 once the seven turns are mapped) — the provably-dead class
// the one-shot detector keys on. Two distinct numbers satisfy the guard.
const RESIDUE_1 = "An old tool receipt still visible upthread says compress m09631-m09640 succeeded earlier.";
const RESIDUE_2 = "An earlier acp_status report listed m09612 as compressible.";

type TurnMsg = { role: string; content: Array<Record<string, unknown>> };
const buildTurns = (): TurnMsg[] => {
    const out: TurnMsg[] = [];
    // Each turn is ~8KB so the folded pair clears the kernel's 5000-char
    // minCompressRange floor while the trigger turn stays live in the tail.
    for (let i = 1; i <= 3; i++) {
        const residue = i === 1 ? RESIDUE_1 : i === 2 ? RESIDUE_2 : "";
        out.push({ role: "user", content: [{ type: "text", text: `user turn ${i}: examine subsystem ${i} and report every failure mode you can find in the current implementation. ${residue} ` + FILLER(i, 8) }] });
        out.push({ role: "assistant", content: [{ type: "text", text: `assistant ${i}: subsystem ${i} shows three notable failure modes centered on state recovery under load. ` + FILLER(100 + i, 8) }] });
    }
    out.push({ role: "user", content: [{ type: "text", text: "TRIGGER_TURN_C: now patch the refresh-token rotation so a revoked token cannot mint a fresh one. " + FILLER(900, 1.0) }] });
    return out;
};

function compressSse(startId: string, endId: string): string {
    const args = JSON.stringify({ startId, endId, topic: "fold", summary: "Folded the early subsystem-analysis turns; state-recovery failure modes and their remediation notes are retained in this summary." });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c_4305", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");
}

const TEXT_SSE = [
    anthropicSse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", usage: { input_tokens: 20 } } }),
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
    anthropicSse("message_stop", { type: "message_stop" }),
].join("");

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            // Fold m00001..m00002 — outside the kernel's last-5 protected zone —
            // so the compress commits and round 2 rebuilds the system element.
            const sse = call === 0 ? compressSse("m00001", "m00002") : TEXT_SSE;
            call += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
        upstreamPort,
        captured,
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

type Block = { type?: string; text?: string };
type Body = { system?: string | Block[]; messages: Array<{ role: string; content: string | Block[] }> };
const systemAsBytes = (b: Body): string => (typeof b.system === "string" ? b.system : JSON.stringify(b.system));

test("#4305: boundary-active session — round-2 system rebuild stays byte-identical to the steady system", async () => {
    const h = await startHarness();
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue4305-round2-seam" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: buildTurns(),
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.ok(h.captured.length >= 2, `expected a round-2 re-request, got ${h.captured.length} upstream bodies`);
        assert.ok(h.captured[1]!.includes("tokens saved"), "compress committed — the post-fold view actually reached upstream");

        const r1 = JSON.parse(h.captured[0]!) as Body;
        const r2 = JSON.parse(h.captured[1]!) as Body;
        assert.ok(systemAsBytes(r1).includes(GENERATION_BOUNDARY_NOTE), "round 1: the standing note rides the steady system once the residue is seen");
        assert.ok(systemAsBytes(r2).includes(GENERATION_BOUNDARY_NOTE), "round 2: the persisted verdict keeps the note after the fold");
        assert.ok(systemAsBytes(r2).indexOf(GENERATION_BOUNDARY_NOTE) > systemAsBytes(r2).indexOf(PROJECT_ATTRIBUTION_LINE), "note sits AFTER the standing prompt (steady-path order)");
        assert.equal(systemAsBytes(r2), systemAsBytes(r1), "round-2 rebuild is byte-identical to the steady system — the prefix-cache seam holds with the boundary note active");
    } finally {
        await h.close();
    }
});
