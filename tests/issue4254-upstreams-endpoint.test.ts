// #4254 defect ②: GET /__bili/upstreams read surface — per-host merge of the
// alert table + open circuits that DSH's frame-level banner polls. Unit-tests
// the projection directly (the route is a thin loopback-gated passthrough of
// getUpstreamHealthReport()).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    recordUpstreamAlert,
    recordUpstreamCircuitFailure,
    recordUpstreamCircuitSuccess,
    clearUpstreamAlertsForHost,
    getUpstreamHealthReport,
    _resetUpstreamAlertsForTest,
    _resetUpstreamCircuitsForTest,
    _setCircuitCooldownForTest,
} from "../src/upstream-alerts.ts";

const A = "http://127.0.0.1:7864/v1/chat/completions";
const B = "http://10.0.0.5:9000/v1/chat/completions";
const NO_PORT = "http://relay.example.com/v1/chat/completions";

function refused(host: string): Error {
    return Object.assign(new Error(`connect ECONNREFUSED ${host}`), { code: "ECONNREFUSED" });
}

test("#4254: alert-only window → one entry per host, circuit null, kind/count/hint/code from the alert", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    const r = getUpstreamHealthReport();
    assert.equal(r.upstreams.length, 1);
    const e = r.upstreams[0];
    assert.equal(e.host, "127.0.0.1:7864");
    assert.equal(e.port, 7864);
    assert.equal(e.kind, "connect-refused");
    assert.equal(e.code, "ECONNREFUSED");
    assert.ok(typeof e.hint === "string" && e.hint.length > 0);
    assert.equal(e.count, 1);
    assert.equal(e.circuit, null);
});

test("#4254: open circuit is the authoritative down signal — merged row, state open, nextProbe ETA, circuit strikes", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(60_000);
    for (let i = 0; i < 3; i++) {
        recordUpstreamAlert(B, refused("10.0.0.5:9000"), false);
        recordUpstreamCircuitFailure(B, refused("10.0.0.5:9000"), false);
    }
    const e = getUpstreamHealthReport(Date.now()).upstreams[0];
    assert.equal(e.host, "10.0.0.5:9000");
    assert.equal(e.port, 9000);
    assert.ok(e.circuit, "circuit must be present while open");
    assert.equal(e.circuit?.state, "open");
    assert.ok(e.circuit && e.circuit.nextProbeInMs > 0 && e.circuit.nextProbeInMs <= 60_000);
    assert.equal(e.kind, "connect-refused");
    assert.equal(e.code, "ECONNREFUSED");
    assert.equal(e.count, 3, "count reflects circuit strikes while open");
});

test("#4254: multiple hosts merge into distinct rows; recovery (clear alerts + close circuit) drops the host", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    recordUpstreamAlert(B, refused("10.0.0.5:9000"), false);
    const hosts = new Set(getUpstreamHealthReport().upstreams.map((e) => e.host));
    assert.deepEqual([...hosts].sort(), ["10.0.0.5:9000", "127.0.0.1:7864"]);
    // Recovery on B: a resolved response clears its alerts AND closes any circuit.
    clearUpstreamAlertsForHost(B);
    recordUpstreamCircuitSuccess(B);
    const after = getUpstreamHealthReport().upstreams.map((e) => e.host);
    assert.deepEqual(after, ["127.0.0.1:7864"], "recovered host disappears, the other stays");
});

test("#4254: host with no explicit port projects port=null", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(NO_PORT, refused("relay.example.com"), false);
    const e = getUpstreamHealthReport().upstreams[0];
    assert.equal(e.host, "relay.example.com");
    assert.equal(e.port, null);
});
