import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    configureLogger,
    log,
    closeLogger,
    setLogCapture,
    isFileLoggingActive,
} from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #3857 follow-up pins (on top of #3858's delivered-write liveness design):
// regression coverage the merged silent-loss suite does not carry —
// (1) a mid-life leg death (the log path becomes a DIRECTORY while the old fd
//     lives on as an orphan inode) must produce exactly ONE warn across the
//     per-line reopen loop, not one warn per doomed stream;
// (2) isFileLoggingActive() must report a merely-PENDING stream (async open
//     still in flight) as not live — it feeds the #2864 mute decision.

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr;
    Object.defineProperty(process, "stderr", {
        configurable: true,
        value: { write: (chunk: unknown) => { lines.push(String(chunk)); return true; } },
    });
    return { lines, restore: () => Object.defineProperty(process, "stderr", { configurable: true, value: orig }) };
}

async function until(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("mid-life leg death stays one-shot across the per-line reopen loop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(file);
    try {
        // Prove the leg healthy first: a DELIVERED byte closes any earlier
        // episode (the one-shot flag resets on a landed write).
        log("info", "arm-line");
        await until(() => fs.existsSync(file) && fs.statSync(file).size > 0, "armed write flushed");
        await new Promise((r) => setTimeout(r, 50)); // settle the flush-callback reset
        fs.renameSync(file, file + ".bak"); // legal on Windows even while the fd is open
        fs.mkdirSync(file); // path is now a directory → every reopen fails ASYNC (EISDIR on POSIX; dir-fd reject on win32)
        for (let i = 0; i < 5; i++) {
            log("info", `retry-loop-${i}`);
            await new Promise((r) => setTimeout(r, 60)); // let this line's doomed stream fail+clear first
        }
        assert.equal(warns.length, 1, "one warn per episode, not one per doomed stream");
        assert.ok(cap.lines.some((l) => l.includes("[warn]")), "the single warn reached stderr");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("isFileLoggingActive reports false for a pending stream (open still in flight)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        assert.equal(isFileLoggingActive(), false, "right after configureLogger the open is still in flight");
        log("info", "seed");
        await until(() => fs.existsSync(file) && fs.statSync(file).size > 0, "delivered write");
        assert.equal(isFileLoggingActive(), true);
    } finally {
        closeLogger();
        rmrf(dir);
    }
});
