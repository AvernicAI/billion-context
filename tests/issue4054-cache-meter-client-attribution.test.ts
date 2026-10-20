// #4054: bili's own #1320 thinking-mass projection must not read as
// client-origin evidence for the #3023 seam-attribution arm. The first three
// cases are the synthetic fixtures shipped in the #4042 report bundle
// (cache-metering.test.ts) verbatim — they were RED on master bc4a3f87e and
// pin the settle-side behavior; the last two pin the capture-side invariant
// directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { getCacheLedger, noteForwardedBody, noteInboundMessages, settleUsageReport } from "../src/cache-ledger.ts";

function session(): Session {
    return {
        id: "synthetic-metering-fixture", metadata: {}, stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}
function inbound(tokens: number, signature = "synthetic-fixed-signature"): BiliMessage[] {
    return [
        { id: "fixture-a", role: "user", contentType: "text", text: "a", wireIndex: 0 },
        { id: "fixture-b", role: "assistant", contentType: "reasoning", text: "", thinkingSignature: signature, thinkingTokens: tokens, wireIndex: 1 },
        { id: "fixture-c", role: "user", contentType: "text", text: "c", wireIndex: 2 },
    ];
}
function sample(s: Session, messages: BiliMessage[], middleWire: string, cached: number): void {
    noteInboundMessages(s, messages);
    noteForwardedBody(s, JSON.stringify({ model: "synthetic-fixture", messages: ["a", middleWire, "c"].map(content => ({ role: "user", content })) }));
    // Synthetic usage only. No network, provider SDK, or real model is involved.
    settleUsageReport(s, { total: 100_000, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://fixture.invalid" });
}
function inboundFps(s: Session): string[] {
    const t = s as unknown as { transient?: { inBody?: { fps?: string[] } } };
    return t.transient?.inBody?.fps ?? [];
}

test("generated thinkingTokens must not alone establish client origin of a separate outbound break", () => {
    const s = session();
    sample(s, inbound(10), "before-outbound", 99_000);
    sample(s, inbound(20), "changed-outbound", 20_000);
    const ledger = getCacheLedger(s);
    assert(ledger.lines.at(-1)!.tr > 8192, "actual unexplained miss must remain recorded");
    assert.equal(ledger.agg.clientInserts, 0, "proxy-owned metering is not client-origin evidence");
    assert.equal(ledger.lines.at(-1)?.prov, undefined);
});

test("metering change with identical outbound bytes does not itself trigger client attribution", () => {
    const s = session();
    sample(s, inbound(10), "same-outbound", 99_000);
    sample(s, inbound(20), "same-outbound", 20_000);
    assert.equal(getCacheLedger(s).agg.clientInserts, 0);
});

test("real signature changes remain detectable when outbound bytes also diverge", () => {
    const s = session();
    sample(s, inbound(10, "synthetic-signature-before"), "before-outbound", 99_000);
    sample(s, inbound(20, "synthetic-signature-after"), "changed-outbound", 20_000);
    assert.equal(getCacheLedger(s).agg.clientInserts, 1);
    assert.equal(getCacheLedger(s).lines.at(-1)?.prov, "client");
});

test("inbound fingerprints are immune to projected thinkingTokens deltas", () => {
    const a = session();
    const b = session();
    noteInboundMessages(a, inbound(10));
    noteInboundMessages(b, inbound(20));
    assert.deepEqual(inboundFps(b), inboundFps(a));
});

test("real signature changes still flip the inbound fingerprint", () => {
    const a = session();
    const b = session();
    noteInboundMessages(a, inbound(10, "synthetic-signature-before"));
    noteInboundMessages(b, inbound(10, "synthetic-signature-after"));
    assert.notDeepEqual(inboundFps(b), inboundFps(a));
});
