import { readdirSync, statSync, unlinkSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { bodyDumpEnabled, dump4xxEnabled, dumpGcMaxAgeMs, dumpGcMaxTotalBytes, rawDumpDir, sseDumpDir } from "./knobs.js";
import { configFile, dumpsDir } from "./paths.js";

/**
 * #2412: retention GC for the debug dump directories (`dumps/`, `raw/`, the
 * SSE dump dir). These dirs are write-only and grew without bound — 70 GB in
 * 26 h measured under active forensics. Opt-in via diagnostics.maxTotalBytes /
 * diagnostics.maxAgeDays (BILI_DUMP_MAX_TOTAL_BYTES / BILI_DUMP_MAX_AGE_DAYS):
 * when either bound is set, oldest files are deleted first until both bounds
 * hold. Default OFF — nothing is ever deleted unless a bound is configured.
 *
 * Design carried over from PR #277 (closed unmerged; this is its config-driven
 * successor): FIFO-by-mtime trim with a deterministic name tiebreak, a 30 s
 * per-dir throttle that keeps the sweep off the hot path, best-effort error
 * handling throughout (a missing dir or an ununlinkable file is not an error).
 * Deltas vs #277:
 *   - caps come from knobs (env > file > default-off) instead of hardcoded
 *     500 files / 512 MB — at high capture rates a fixed small cap evicts
 *     forensics evidence within minutes of writing it;
 *   - `err-*` / `summary-err-*` incident dumps (error-dump.ts, BILI_DUMP_4XX)
 *     are protected: rare, high-value post-mortem evidence written
 *     independently of the body-dump toggles;
 *   - deletions log at WARN, not debug: silent evidence eviction is exactly
 *     the failure class this issue reports.
 */

const MIN_INTERVAL_MS = 30 * 1000;
const PROTECTED_PREFIXES = ["err-", "summary-err-"];
const lastRun = new Map<string, number>();

export interface DumpGcPolicy {
    /** Total-size cap in bytes; oldest files dropped until under it. null = no byte bound. */
    maxBytes?: number | null;
    /** Age cap in ms; everything older is dropped regardless of bytes. null = no age bound. */
    maxAgeMs?: number | null;
}

/**
 * Sweep `dir`, deleting oldest files (by mtime) until both policy bounds hold.
 * Best-effort; returns the number of files removed (0 when throttled, when
 * the policy is empty, or when there is nothing to do). `nowMs` is injectable
 * for tests. Subdirectories are ignored (all dump dirs are flat-file).
 */
export function gcDebugDir(dir: string, policy: DumpGcPolicy, nowMs: number = Date.now()): number {
    const maxBytes = policy.maxBytes ?? null;
    const maxAgeMs = policy.maxAgeMs ?? null;
    if (!dir || (maxBytes == null && maxAgeMs == null)) return 0;
    const last = lastRun.get(dir);
    if (last !== undefined && nowMs - last < MIN_INTERVAL_MS) return 0;

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        // Missing/unreadable dir — do NOT start the throttle clock, so a dir
        // created shortly after a failed probe gets swept on its next visit.
        return 0;
    }
    lastRun.set(dir, nowMs);

    const files: { name: string; mtime: number; size: number }[] = [];
    for (const name of names) {
        if (PROTECTED_PREFIXES.some((p) => name.startsWith(p))) continue;
        try {
            const st = statSync(path.join(dir, name));
            if (st.isFile()) files.push({ name, mtime: st.mtimeMs, size: st.size });
        } catch {
            // vanished between readdir and stat
        }
    }
    files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

    let removed = 0;
    let freedBytes = 0;
    const drop = (f: { name: string; size: number }): void => {
        try {
            unlinkSync(path.join(dir, f.name));
            removed++;
            freedBytes += f.size;
        } catch {
            // locked/gone — skip and keep trimming older files
        }
    };

    // Age bound first: everything older than the cutoff goes, regardless of bytes.
    let survivors = files;
    if (maxAgeMs != null) {
        const cutoff = nowMs - maxAgeMs;
        survivors = [];
        for (const f of files) {
            if (f.mtime < cutoff) drop(f);
            else survivors.push(f);
        }
    }
    // Byte bound: oldest-first until under the cap.
    if (maxBytes != null) {
        let remainingBytes = 0;
        for (const f of survivors) remainingBytes += f.size;
        for (const f of survivors) {
            if (remainingBytes <= maxBytes) break;
            drop(f);
            remainingBytes -= f.size;
        }
    }

    if (removed > 0) {
        const bounds = [
            maxBytes != null ? `maxTotalBytes=${maxBytes}` : "",
            maxAgeMs != null ? `maxAgeDays=${maxAgeMs / 86_400_000}` : "",
        ].filter(Boolean).join(" ");
        loggerLog("warn", `[gc] ${dir}: removed ${removed} oldest dump file(s), ~${Math.round(freedBytes / (1024 * 1024))} MB freed (${bounds}), ${files.length - removed} left`);
    }
    return removed;
}

/**
 * Hot-path entry point used by every dump write site: resolves the live
 * policy from knobs (env > file > default-off) and sweeps `dir` only when a
 * bound is actually configured. Cheap no-op otherwise.
 */
export function gcDumpDirIfConfigured(dir: string): void {
    if (!dir) return;
    const maxBytes = dumpGcMaxTotalBytes();
    const maxAgeMs = dumpGcMaxAgeMs();
    if (maxBytes == null && maxAgeMs == null) return;
    gcDebugDir(dir, { maxBytes, maxAgeMs });
}

// --- #3851: retention visibility -------------------------------------------------
// The bounds above are opt-in and default OFF by design ("leave both unset for
// unbounded retention", CONFIGURATION.md). The gap #3851 reports: once capture
// is turned on per the docs, nothing says the dirs are unbounded or how big they
// already are — 51.9 GB over 10 days before anyone noticed. This block is that
// signpost: read-only measurement + message building only. No new config keys,
// no deletion, no change to any write path.

export interface DumpDirStat {
    dir: string;
    exists: boolean;
    bytes: number;
    files: number;
}

export interface DumpRetentionState {
    /** Capture channels writing dumps right now: "body" (dumps/ + raw/),
     *  "4xx" (err-* incident dumps in dumps/), "sse" (raw SSE stream dir). */
    channels: string[];
    maxTotalBytes: number | null;
    maxAgeDays: number | null;
    /** Capture on with NEITHER bound set — dirs grow forever. */
    unbounded: boolean;
}

/** Live retention posture for the debug dump dirs. Resolves the same knobs as
 *  the GC itself (env > file > default-off), so what is reported is what runs. */
export function dumpRetentionState(): DumpRetentionState {
    const channels: string[] = [];
    if (bodyDumpEnabled()) channels.push("body");
    if (dump4xxEnabled()) channels.push("4xx");
    if (sseDumpDir() !== undefined) channels.push("sse");
    const maxBytes = dumpGcMaxTotalBytes();
    const maxAgeMs = dumpGcMaxAgeMs();
    return {
        channels,
        maxTotalBytes: maxBytes,
        maxAgeDays: maxAgeMs == null ? null : maxAgeMs / 86_400_000,
        unbounded: channels.length > 0 && maxBytes == null && maxAgeMs == null,
    };
}

/** Every dump dir the current config can write (deduped — a custom rawDumpDir
 *  may coincide with dumpsDir). Order: dumps/, raw/, SSE dir. */
export function activeDumpDirs(): string[] {
    const st = dumpRetentionState();
    const dirs: string[] = [];
    if (st.channels.includes("body") || st.channels.includes("4xx")) dirs.push(dumpsDir());
    if (st.channels.includes("body")) dirs.push(rawDumpDir());
    if (st.channels.includes("sse")) dirs.push(sseDumpDir()!);
    return [...new Set(dirs)];
}

/** Total size + file count of one dump dir. Best-effort: a missing/unreadable
 *  dir reports exists:false instead of throwing. Flat-file assumption matches
 *  gcDebugDir — all bili dump dirs are flat. */
export async function measureDumpDir(dir: string): Promise<DumpDirStat> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return { dir, exists: false, bytes: 0, files: 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const name of names) {
        try {
            const st = await stat(path.join(dir, name));
            if (st.isFile()) {
                bytes += st.size;
                files += 1;
            }
        } catch {
            // vanished between readdir and stat
        }
    }
    return { dir, exists: true, bytes, files };
}

/** Human-readable byte count for logs/doctor (binary units, one decimal). */
export function fmtBytes(n: number): string {
    if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
    if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${n} B`;
}

/** One-shot boot warning text (#3851). Pure builder so the exact wording is
 *  unit-tested; empty `stats` = measurement failed, sizes omitted. */
export function formatUnboundedDumpWarning(state: DumpRetentionState, stats: DumpDirStat[]): string {
    const sizes = stats.length === 0
        ? "size measurement unavailable"
        : stats.map((s) => `${s.dir}=${s.exists ? `${fmtBytes(s.bytes)} (${s.files} file${s.files === 1 ? "" : "s"})` : "(not created yet)"}`).join(", ");
    return `[dump] UNBOUNDED retention: capture is ON (${state.channels.join("+")}) but diagnostics.maxTotalBytes and diagnostics.maxAgeDays are both unset — these dirs are write-only and grow forever (~GB/day measured under active sessions, #2412). Current: ${sizes}. Set diagnostics.maxTotalBytes (total bytes) and/or diagnostics.maxAgeDays in ${configFile()} to bound them, or turn capture off (diagnostics.dumpBody=false) when you no longer need it.`;
}
