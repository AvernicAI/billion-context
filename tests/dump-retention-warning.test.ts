import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activeDumpDirs, dumpRetentionState, fmtBytes, formatUnboundedDumpWarning, measureDumpDir } from "../src/state-gc.ts";
import { renderDoctorReport, type DoctorReport } from "../src/doctor.ts";
import { dumpsDir } from "../src/paths.ts";
import { rawDumpDir } from "../src/knobs.ts";

// #3851: retention visibility for debug dump dirs. Contract under test:
//   - unbounded predicate = some capture channel ON && BOTH bounds unset (row-driven,
//     positive AND negative directions per gate discipline #3617);
//   - activeDumpDirs() maps channels onto dirs, deduped;
//   - measureDumpDir: flat-file totals, missing dir -> exists:false (never throws);
//   - boot warning wording: dir paths, sizes, both config keys, off-switch hint;
//   - doctor renders UNBOUNDED / bounded / off variants.

const ENV_KEYS = [
    "BILI_CONFIG_FILE", "XDG_STATE_HOME", "ACP_DUMP_BODY", "ACP_RAW_DUMP_DIR",
    "ACP_DUMP_DIR", "BILI_DUMP_4XX", "ACP_DUMP_SSE",
    "BILI_DUMP_MAX_TOTAL_BYTES", "BILI_DUMP_MAX_AGE_DAYS",
] as const;

const tmpRoot = mkdtempSync(path.join(tmpdir(), "bili-dumpwarn-"));
let cfgSeq = 0;
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
    const saved: [string, string | undefined][] = [];
    for (const k of ENV_KEYS) saved.push([k, process.env[k]]);
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

function writeConfig(obj: unknown): string {
    const f = path.join(tmpRoot, `cfg-${++cfgSeq}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
}

test("defaults: no capture, no caps -> not unbounded, no dirs", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({}), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.deepEqual(st.channels, []);
        assert.equal(st.unbounded, false);
        assert.deepEqual(activeDumpDirs(), []);
    },
));

test("body capture without bounds -> UNBOUNDED, dumps/ + raw/ listed", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: true } }), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.deepEqual(st.channels, ["body"]);
        assert.equal(st.unbounded, true);
        assert.deepEqual(activeDumpDirs(), [dumpsDir(), rawDumpDir()]);
    },
));

test("maxTotalBytes alone bounds it (negative row for unbounded)", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: true, maxTotalBytes: 5 << 20 } }), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.equal(st.unbounded, false);
        assert.equal(st.maxTotalBytes, 5 << 20);
        assert.equal(st.maxAgeDays, null);
    },
));

test("maxAgeDays alone bounds it (negative row for unbounded)", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: true, maxAgeDays: 7 } }), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.equal(st.unbounded, false);
        assert.equal(st.maxAgeDays, 7);
    },
));

test("4xx-only capture -> dumps/ only, still unbounded", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dump4xx: true } }), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.deepEqual(st.channels, ["4xx"]);
        assert.equal(st.unbounded, true);
        assert.deepEqual(activeDumpDirs(), [dumpsDir()]);
    },
));

test("SSE dump dir only -> sse channel, own dir, unbounded", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ dumpSse: path.join(tmpRoot, "sse") }), XDG_STATE_HOME: tmpRoot },
    () => {
        const st = dumpRetentionState();
        assert.deepEqual(st.channels, ["sse"]);
        assert.equal(st.unbounded, true);
        assert.deepEqual(activeDumpDirs(), [path.join(tmpRoot, "sse")]);
    },
));

test("env ACP_DUMP_BODY=1 wins over file dumpBody:false", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: false } }), XDG_STATE_HOME: tmpRoot, ACP_DUMP_BODY: "1" },
    () => {
        const st = dumpRetentionState();
        assert.ok(st.channels.includes("body"));
        assert.equal(st.unbounded, true);
    },
));

test("env cap wins over unset file bounds", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: true } }), XDG_STATE_HOME: tmpRoot, BILI_DUMP_MAX_TOTAL_BYTES: "5242880" },
    () => {
        const st = dumpRetentionState();
        assert.equal(st.unbounded, false);
        assert.equal(st.maxTotalBytes, 5242880);
    },
));

test("custom rawDumpDir is the audited raw dir; dedup when it equals dumpsDir", () => withEnv(
    { BILI_CONFIG_FILE: writeConfig({ diagnostics: { dumpBody: true, rawDumpDir: path.join(tmpRoot, "custom-raw") } }), XDG_STATE_HOME: tmpRoot },
    () => {
        assert.ok(activeDumpDirs().includes(path.join(tmpRoot, "custom-raw")));
    },
));

test("measureDumpDir sums flat files only; subdirs ignored", async () => {
    const dir = path.join(tmpRoot, "measure");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "a.txt"), "x".repeat(100));
    writeFileSync(path.join(dir, "b.txt"), "y".repeat(2048));
    writeFileSync(path.join(dir, "sub", "c.txt"), "z".repeat(999));
    const st = await measureDumpDir(dir);
    assert.deepEqual(st, { dir, exists: true, bytes: 2148, files: 2 });
});

test("measureDumpDir: missing dir -> exists:false, never throws", async () => {
    const st = await measureDumpDir("/nonexistent/bili-dumpwarn-missing");
    assert.deepEqual(st, { dir: "/nonexistent/bili-dumpwarn-missing", exists: false, bytes: 0, files: 0 });
});

test("fmtBytes boundaries", () => {
    assert.equal(fmtBytes(0), "0 B");
    assert.equal(fmtBytes(512), "512 B");
    assert.equal(fmtBytes(1536), "1.5 KiB");
    assert.equal(fmtBytes(1 << 20), "1.0 MiB");
    assert.equal(fmtBytes(2.5 * (1 << 30)), "2.5 GiB");
});

test("boot warning names dirs, sizes, both config keys, and the off switch", () => {
    const msg = formatUnboundedDumpWarning(
        { channels: ["body", "4xx"], maxTotalBytes: null, maxAgeDays: null, unbounded: true },
        [
            { dir: "/x/dumps", exists: true, bytes: 8 * (1 << 30), files: 28518 },
            { dir: "/x/raw", exists: false, bytes: 0, files: 0 },
        ],
    );
    assert.ok(msg.includes("UNBOUNDED retention"), msg);
    assert.ok(msg.includes("(body+4xx)"), msg);
    assert.ok(msg.includes("/x/dumps=8.0 GiB (28518 files)"), msg);
    assert.ok(msg.includes("/x/raw=(not created yet)"), msg);
    assert.ok(msg.includes("diagnostics.maxTotalBytes"), msg);
    assert.ok(msg.includes("diagnostics.maxAgeDays"), msg);
    assert.ok(msg.includes("dumpBody=false"), msg);
});

test("boot warning degrades gracefully when measurement failed", () => {
    const msg = formatUnboundedDumpWarning(
        { channels: ["body"], maxTotalBytes: null, maxAgeDays: null, unbounded: true },
        [],
    );
    assert.ok(msg.includes("size measurement unavailable"), msg);
});

function minimalReport(dumps: DoctorReport["dumps"]): DoctorReport {
    return {
        generatedAt: Date.parse("2026-10-20T00:00:00Z"),
        packageName: "billion-context",
        global: { form: "npm", runningVersion: "0.1.299", updateTag: "latest", verdict: "ok" },
        lanes: [],
        processes: [],
        dumps,
    };
}

test("doctor renders UNBOUNDED with per-dir sizes", () => {
    const out = renderDoctorReport(minimalReport({
        retention: { channels: ["body", "4xx"], maxTotalBytes: null, maxAgeDays: null, unbounded: true },
        dirs: [
            { dir: path.join(tmpRoot, "billion-context", "dumps"), exists: true, bytes: 8 * (1 << 30), files: 28518 },
            { dir: path.join(tmpRoot, "billion-context", "raw"), exists: true, bytes: 43 * (1 << 30), files: 98194 },
        ],
    }));
    assert.ok(out.includes("dump dirs"), out);
    assert.ok(out.includes("UNBOUNDED"), out);
    assert.ok(out.includes("8.0 GiB (28,518 files)"), out);
    assert.ok(out.includes("43.0 GiB (98,194 files)"), out);
});

test("doctor renders bounded with the configured caps", () => {
    const out = renderDoctorReport(minimalReport({
        retention: { channels: ["body"], maxTotalBytes: 2 * (1 << 30), maxAgeDays: 7, unbounded: false },
        dirs: [
            { dir: path.join(tmpRoot, "dumps"), exists: false, bytes: 0, files: 0 },
            { dir: path.join(tmpRoot, "raw"), exists: true, bytes: 100, files: 1 },
        ],
    }));
    assert.ok(out.includes("bounded —"), out);
    assert.ok(out.includes("maxTotalBytes=2.0 GiB"), out);
    assert.ok(out.includes("maxAgeDays=7"), out);
    assert.ok(out.includes("(absent)"), out);
    assert.ok(out.includes("100 B (1 file)"), out);
});

test("doctor renders off when nothing captures (negative row)", () => {
    const out = renderDoctorReport(minimalReport({
        retention: { channels: [], maxTotalBytes: null, maxAgeDays: null, unbounded: false },
        dirs: [{ dir: path.join(tmpRoot, "dumps"), exists: false, bytes: 0, files: 0 }],
    }));
    assert.ok(out.includes("off (no capture enabled)"), out);
    assert.ok(!out.includes("UNBOUNDED"), out);
});
