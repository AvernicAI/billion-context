// #4054: the cache report (/acp-cache, web session page) booked a cache break as
// prov:"client" (clientInserts+1) when the ONLY inbound change between two requests
// was bili's own projected thinking-token meter (#1320 projectThinkingMass). The
// #3023 client arm fingerprints each inbound message's full JSON; a fluctuating meter
// flipped a mid-history message's fingerprint and handed a SEPARATE outbound break to
// the client bucket, masking the real cause. Fix: noteInboundMessages strips the
// top-level thinkingTokens before hashing, so the client view reflects client bytes
// only (the field's sole writer is budget.ts:175 — no wire codec fills it).
// Split from #4042: the three end-to-end cases below are adopted VERBATIM from
// #4042's attached cache-metering fixture (loopback-only, no network); the fourth is
// a direct pin on the fingerprint itself.
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

// Direct pin on the mechanism: the per-message fingerprint must be INVARIANT to
// thinkingTokens fluctuation — the exact property the three end-to-end cases above
// exercise through detectSeam. Nails the strip even if the attribution path reshapes.
test("inbound fingerprint is immune to projected thinkingTokens fluctuation", () => {
    const s = session();
    noteInboundMessages(s, inbound(10));
    const before = [...(s.transient?.inBody?.fps ?? [])];
    noteInboundMessages(s, inbound(20));
    const after = s.transient?.inBody?.fps ?? [];
    assert.equal(before.length, 3, "all three messages fingerprinted");
    assert.deepEqual(after, before, "fingerprint array unchanged when only bili's projected meter moves");
});
