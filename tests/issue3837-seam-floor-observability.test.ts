// #3837: unexplained cache breaks below the warn floor (tr <= 8192 tok) were
// dropped silently by detectSeam's substantive gate — the field case billed
// 5,701 full-price tokens with ZERO log lines. Fix: count below-floor pairs
// (agg.seamFloored / seamFlooredMissed) + one-time info log + additive report
// field (seam.floored) + formatSeam section. Warn thresholds untouched.
// Gate discipline (#3617): positive = floored pair counted & NOT flagged;
// negative control = above-floor pair STILL flags as a suspect (unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `issue3837-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("#3837: a small mid-history break below the warn floor is counted, not flagged", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["alpha-one", "beta-two", "gamma-three", "delta-four", "epsilon-five", "zeta-six"]));
    settle(s, 20_000, 0); // opener (nb-marked, becomes the baseline pair head)
    // Same list with ONE small mid-history change (the durable-demote tag-insert shape):
    // divergence exists but the unexplained bill stays far below the 8192-tok floor.
    noteForwardedBody(s, body(["alpha-one", "beta-two", "gamma-three", "delta-four TAGGED", "epsilon-five", "zeta-six"]));
    settle(s, 20_000, 15_000); // missed = 5_000 << 8192
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.notEqual(line.nb, 1, "second sample has a baseline");
    assert.equal(line.tr, 5_000, "unexplained residual booked");
    assert.equal(line.tr > 8192, false, "residual is below the warn floor");
    assert.notEqual(line.seam, 1, "below-floor pair must NOT be flagged as a suspected break");
    assert.equal(led.agg.seamSuspects, 0, "suspect counter untouched");
    assert.equal(led.agg.seamFloored, 1, "below-floor pair counted");
    assert.equal(led.agg.seamFlooredMissed, line.tr, "floored token volume accumulated");
    assert.equal(led.seamEvents?.length ?? 0, 0, "no forensic event for a floored pair");

    // A second floored sample accumulates into the same counters.
    noteForwardedBody(s, body(["alpha-one", "beta-two", "gamma-three", "delta-four TAGGED X", "epsilon-five", "zeta-six"]));
    settle(s, 20_000, 16_000); // missed = 4_000, still floored
    const led2 = getCacheLedger(s);
    assert.equal(led2.agg.seamFloored, 2);
    assert.equal(led2.agg.seamSuspects, 0);

    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.floored.count, 2);
    assert.ok(report.seam.floored.missed > 0, "floored volume surfaced in the report");
    const text = handleAcpCache(s).text;
    assert.match(text, /SEAM SAMPLES UNDER FLOOR/, "report section names the floored samples");
});

test("#3837 negative control: an above-floor mid-history break still flags as a suspect", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["alpha-one", "beta-two", "gamma-three", "delta-four", "epsilon-five", "zeta-six"]));
    settle(s, 100_000, 99_000); // healthy baseline
    noteForwardedBody(s, body(["alpha-one", "BETA-REWRITTEN", "gamma-three", "delta-four", "epsilon-five", "zeta-six"]));
    settle(s, 100_000, 50_000); // missed = 50_000 > 8192 AND > 0.3*input
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1, "above-floor break keeps flagging (gate unchanged)");
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.seamFloored, 0, "flagged pairs do not double-count as floored");
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "forensic event still recorded");
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.suspects, 1);
    assert.equal(report.seam.floored.count, 0);
});
