import test from "node:test";
import assert from "node:assert/strict";
import {
    formatStallDiagnostic,
    installNativeFetchIntercept,
    _resetForTest,
    _setStallTimingForTest,
    _setStallSinkForTest,
    type NativeInterceptState,
} from "../src/agent/native-intercept.ts";

// #4129: pi attaches to a HEALTHY shared proxy, prints the banner, then the
// first model request stalls forever because the proxy's event loop is saturated
// by concurrent compression (#3654) — the socket connects but never answers, so
// undici never throws and the old recovery path (only fires on TypeError) never
// runs. The fix adds a bounded, evidence-based watchdog on that send. These
// tests pin the wording contract (pure) and the watchdog's fire/suppress/re-fire
// behavior (integration, driven through the real fetch chain).

const DEAD_ORIGIN = "http://127.0.0.1:1"; // loopback port 1 → connect refused, fast "dead" probe
const MODEL_URL = "http://127.0.0.1:8199/v1/messages";
const MODEL_INIT: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

type Announce = { level: "info" | "warn"; line: string };

const hangingFetch = ((_input?: unknown, _init?: unknown) => new Promise<Response>(() => {})) as typeof fetch;
const fastFetch = (async (_input?: unknown, _init?: unknown) => new Response("{}", { status: 200 })) as typeof fetch;

function stateFor(origin = DEAD_ORIGIN): NativeInterceptState {
    return { origin, ready: Promise.resolve(origin) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("formatStallDiagnostic: busy → warn + saturation wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 12_345, { state: "busy", detail: "no health answer within 1500ms after TCP connect" });
    assert.equal(level, "warn");
    assert.match(line, /event loop saturated/);
    assert.match(line, /health=busy \(no health answer within 1500ms after TCP connect\)/);
    assert.match(line, /still pending after 12s/);
});

test("formatStallDiagnostic: alive → info + queued-behind-work wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 20_000, { state: "alive" });
    assert.equal(level, "info");
    assert.match(line, /queued behind in-flight work/);
    assert.match(line, /health=alive;/);
    assert.match(line, /still pending after 20s/);
});

test("formatStallDiagnostic: dead without detail → warn + respawn wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 20_000, { state: "dead" });
    assert.equal(level, "warn");
    assert.match(line, /recovery respawns on the next failure/);
    assert.match(line, /health=dead;/);
});

test("#4129: a model request stalled against a held origin emits ONE note, rate-limited per origin, re-fires after cooldown", async () => {
    const seen: Announce[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    _setStallTimingForTest(20, 100);
    _setStallSinkForTest((level, line) => seen.push({ level, line }));
    const fetchTop = (() => {
        globalThis.fetch = hangingFetch;
        assert.equal(installNativeFetchIntercept(stateFor()), true);
        return globalThis.fetch;
    })();
    try {
        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(60);
        assert.equal(seen.length, 1, `first stall → exactly one note (got ${seen.length})`);
        assert.match(seen[0].line, /model request to http:\/\/127\.0\.0\.1:1 still pending after \ds/);
        assert.match(seen[0].line, /health=(busy|dead|alive)/);

        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(80);
        assert.equal(seen.length, 1, "second stall within the cooldown window must be suppressed");

        await sleep(120);
        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(80);
        assert.equal(seen.length, 2, "a stall after the cooldown elapses must re-announce");
    } finally {
        _setStallSinkForTest(undefined);
        _setStallTimingForTest(undefined, undefined);
        _resetForTest();
        globalThis.fetch = saved;
    }
});

test("#4129: a model request that completes before the probe window emits no note", async () => {
    const seen: Announce[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    _setStallTimingForTest(50, 1000);
    _setStallSinkForTest((level, line) => seen.push({ level, line }));
    const fetchTop = (() => {
        globalThis.fetch = fastFetch;
        assert.equal(installNativeFetchIntercept(stateFor()), true);
        return globalThis.fetch;
    })();
    try {
        const res = await fetchTop(MODEL_URL, MODEL_INIT);
        assert.equal(res.status, 200, "the routed request must reach the (fake) downstream");
        await sleep(80);
        assert.equal(seen.length, 0, "a fast response must not trip the stall watchdog");
    } finally {
        _setStallSinkForTest(undefined);
        _setStallTimingForTest(undefined, undefined);
        _resetForTest();
        globalThis.fetch = saved;
    }
});
