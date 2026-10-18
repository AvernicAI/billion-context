// #3003 deferred fold materialization — proxy-level seam test.
//
// The unit suite (tests/fold-hold.test.ts) pins the gate arithmetic and the
// loop suite (tests/loop-compress.test.ts #3003a/b) pins the loop re-request;
// THIS test pins the property at the request level on the real proxy with a
// scripted fake upstream, using the anonymous stateless client shape of
// affinity-crosswire-fold.test.ts (the dsh-web replay pattern):
//
//   K consecutive folds across a burst pay exactly ONE materialization seam.
//   While the burst continues every client request replays the RAW history
//   (prefix byte-stable, full cache hit); the first fold-free request renders
//   every held fold at once. Asserted as: exactly one raw→folded transition
//   across the whole client-request sequence.
//
// Wire dynamics worth knowing (learned the hard way): the inject-tool lane
// settles a compress tool_call with INTERNAL re-requests (loop rounds), so one
// client turn can produce SEVERAL upstream bodies. Client requests are
// identified by their unique "Turn N" marker (first body containing it), and
// a repeated fold demand over a raw view is REFUSED by the kernel's
// consumed-classification ("already covered by active block(s)") — that
// refusal is the designed interaction, not a bug: state truth and view
// fiction disagree during the hold by construction.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

// Hermetic state dirs BEFORE importing the server modules.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-3003-fold-hold-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { getSession } = await import("../src/session.ts");
const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { defaultConfig } = await import("acp-kernel");
const { heldFoldBlockIds } = await import("../src/fold-hold.ts");

const THRESHOLD = 64 * 1024;
const SUMMARY_TEXT = "Fold summary: the audit covered provinces one through six, ledger entries stable, no anomalies recorded in any region of the network.";
const EARLY_FILLER_TAG = "Paragraph 3-";
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: ledger audit of the ming dynasty grain transport network continued without incident across all provinces. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const parseRefIds = (body: string): string[] => {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
};

interface Rig {
    proxy: http.Server;
    upstream: http.Server;
    openaiBase: string;
    bodies: string[];
    foldDemands: number;
    /** scripted per-request override: (idx, body) => "fold" | "plain" */
    replyMode: (idx: number, body: string) => "fold" | "plain";
}

async function buildRig(context: number): Promise<Rig> {
    const bodies: string[] = [];
    let foldDemands = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const idx = bodies.length + 1;
            bodies.push(body);
            const wantFold = rig.replyMode(idx, body) === "fold"
                && Buffer.byteLength(body) > THRESHOLD && parseRefIds(body).length >= 12;
            if (wantFold) foldDemands++;
            const reply = `Reply ${idx}: acknowledged. ` + FILLER(idx % 7, 0.2);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
            if (wantFold) {
                const refs = parseRefIds(body);
                const args = JSON.stringify({ content: [{ startId: refs[2]!, endId: refs[refs.length - 6]!, topic: "audit fold", summary: SUMMARY_TEXT }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: args } }] } }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
            } else {
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "probe-model": { context } } } },
        modelContextLimit: context,
        kernelConfig: defaultConfig(context),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as unknown as import("../src/config.ts").ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const rig: Rig = {
        proxy, upstream, openaiBase: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        bodies, foldDemands: 0, replyMode: () => "plain",
    };
    Object.defineProperty(rig, "foldDemands", { get: () => foldDemands });
    return rig;
}

type Msg = { role: string; content: string };

interface Scenario {
    rig: Rig;
    hist: Msg[];
    /** first upstream body containing the turn marker = the client request */
    clientBody: (t: number) => string;
    turn: (t: number) => Promise<void>;
}

async function play(rig: Rig): Promise<Scenario> {
    const hist: Msg[] = [];
    const clientBody = (t: number): string => {
        const marker = `Turn ${t}: audit province ${t}.`;
        const b = rig.bodies.find((x) => x.includes(marker));
        if (!b) assert.fail(`no upstream body carries the client marker of turn ${t}`);
        return b;
    };
    const turn = async (t: number): Promise<void> => {
        hist.push({ role: "user", content: `Turn ${t}: audit province ${t}. ` + FILLER(t, 6) });
        const resp = await fetch(rig.openaiBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe-model", stream: true, messages: [...hist] }) });
        const raw = await resp.text();
        if (resp.status !== 200) assert.fail(`turn ${t}: ${resp.status}: ${raw.slice(0, 300)}`);
        hist.push({ role: "assistant", content: `Reply about province ${t}: acknowledged. ` + FILLER(t, 0.2) });
    };
    return { rig, hist, clientBody, turn };
}

/** Count raw→folded transitions across the client-request sequence — the
 *  number of cache seams the burst paid. */
function seamCount(rig: Rig, turns: number[]): number {
    const states = turns.map((t) => (rig.bodies.find((x) => x.includes(`Turn ${t}: audit province ${t}.`)) ?? "").includes(EARLY_FILLER_TAG));
    let seams = 0;
    for (let i = 1; i < states.length; i++) if (states[i - 1] && !states[i]) seams++;
    return seams;
}

test("K consecutive folds pay ONE materialization seam (#3003)", { timeout: 180_000 }, async () => {
    process.env.BILI_DEFER_MATERIALIZATION = "1";
    const rig = await buildRig(200_000);
    // Fold while the burst cap allows it, then answer plain — the model
    // "stops calling compress" and the next request materializes. The cap
    // counts COMMITTED blocks, not fold demands: the settle rounds re-demand
    // over raw views (refused as already-covered), which would otherwise eat
    // the whole budget inside the load turn.
    const BURST_CAP = 3;
    const sessionId0 = { id: "" };
    rig.replyMode = () => {
        const s = sessionId0.id ? getSession(sessionId0.id) : undefined;
        return s && s.state.blocks.length >= BURST_CAP ? "plain" : "fold";
    };
    const sc = await play(rig);
    try {
        let t = 0;
        while (rig.foldDemands === 0 && t < 20) { t++; await sc.turn(t); }
        assert.ok(rig.foldDemands >= 1, "the upstream demanded at least one fold");
        const pfas = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfas.length, 1, "one anonymous session across the burst");
        const sessionId = pfas[0]!;
        sessionId0.id = sessionId;
        assert.ok(getSession(sessionId)!.state.blocks.length >= 1, "the first fold committed");
        assert.ok(heldFoldBlockIds(getSession(sessionId)!).size >= 1, "and is held (not yet materialized)");

        // Burst legs — every client request still RAW.
        let guard = 0;
        while (getSession(sessionId)!.state.blocks.length < BURST_CAP && guard++ < 10) {
            t++;
            await sc.turn(t);
            assert.ok(sc.clientBody(t).includes(EARLY_FILLER_TAG), `turn ${t}: hold leg stays raw (no seam yet)`);
            assert.ok(heldFoldBlockIds(getSession(sessionId)!).size >= 1, `turn ${t}: fold(s) still held`);
        }
        assert.equal(getSession(sessionId)!.state.blocks.length, BURST_CAP, `committed all ${BURST_CAP} burst folds`);
        assert.ok(heldFoldBlockIds(getSession(sessionId)!).size >= BURST_CAP, "every burst fold is held — zero seams so far");

        // Burst ends (cap reached → plain). The first fold-free request is the
        // ONE materialization seam; later requests stay stably folded.
        t++; await sc.turn(t); // last hold leg (previous turn's commit is new)
        assert.ok(sc.clientBody(t).includes(EARLY_FILLER_TAG), "the request right after the last fold is still a hold leg");
        t++; await sc.turn(t);
        const seamBody = sc.clientBody(t);
        assert.ok(seamBody.includes(SUMMARY_TEXT), "the first fold-free request materializes ALL held folds (carrier present)");
        assert.ok(!seamBody.includes(EARLY_FILLER_TAG), "covered early content folds away at materialization");
        assert.equal(heldFoldBlockIds(getSession(sessionId)!).size, 0, "the hold is spent");
        t++; await sc.turn(t);
        assert.ok(sc.clientBody(t).includes(SUMMARY_TEXT), "post-materialization requests stay folded (prefix stable, no new seam)");

        const turns = Array.from({ length: t }, (_, i) => i + 1);
        assert.equal(seamCount(rig, turns), 1, "exactly ONE raw→folded transition across the whole conversation");
        assert.equal(prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-")).length, 1, "no fork anywhere");
    } finally {
        rig.proxy.close();
        rig.upstream.close();
        delete process.env.BILI_DEFER_MATERIALIZATION;
    }
});

test("BILI_DEFER_MATERIALIZATION=0 keeps today's eager behavior — the fold renders on the FIRST post-fold request (#3003 escape hatch)", { timeout: 180_000 }, async () => {
    process.env.BILI_DEFER_MATERIALIZATION = "0";
    const rig = await buildRig(200_000);
    let sawFold = false;
    rig.replyMode = () => (sawFold ? "plain" : "fold");
    const sc = await play(rig);
    try {
        let t = 0;
        while (rig.foldDemands === 0 && t < 20) { t++; await sc.turn(t); }
        assert.ok(rig.foldDemands >= 1, "one fold demand fired");
        sawFold = true;
        const sessionId = prefixAffinity.trackedSessionIds().find((id) => id.startsWith("pfa-"))!;
        assert.ok(getSession(sessionId)!.state.blocks.length >= 1, "fold committed");
        t++; await sc.turn(t);
        const body = sc.clientBody(t);
        assert.ok(body.includes(SUMMARY_TEXT), "eager path renders the fold immediately");
        assert.ok(!body.includes(EARLY_FILLER_TAG), "covered content is folded on the first post-fold request");
        assert.equal(heldFoldBlockIds(getSession(sessionId)!).size, 0, "nothing is ever held with the knob off");
    } finally {
        rig.proxy.close();
        rig.upstream.close();
        delete process.env.BILI_DEFER_MATERIALIZATION;
    }
});

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
