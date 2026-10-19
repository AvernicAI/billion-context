import { statSync } from "node:fs";
import path from "node:path";
import { flatFileNameFor } from "acp-kernel/persist";
import { SessionStore, contentStoreRelPathFor, relPathFor } from "./persist.js";
import { discoverLiveInstances, type ProxyInstanceFile } from "./instance.js";
import type { SessionStorageStats } from "./storage/store.js";

/** #3830: supported session cleanup (`bili sessions ls/rm/prune`). The sessions
 *  directory has write paths but no user-facing retention lever: JSON
 *  envelopes are kept forever and, since unified storage defaults to shadow
 *  double-write (#2671), every session also lives in index.db — with no
 *  auto-VACUUM, deleted rows never shrink the file on their own. This module
 *  is pure CLI policy on top of the existing deletion primitives
 *  (SessionStore.removeSession → UnifiedStore.deleteSession); it changes no
 *  compression behavior, no wire format, and adds no config surface. */

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2500;

export function parseDuration(raw: string): number {
    const m = /^(\d+)([smhdw])$/.exec(raw.trim());
    if (!m) throw new Error(`invalid duration "${raw}" (expected <number><s|m|h|d|w>, e.g. 30d)`);
    const mult: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return Number(m[1]) * mult[m[2]!]!;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

function fmtDate(ms: number | undefined): string {
    return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

interface LiveProbeView {
    id: string;
    live: boolean;
    lastSeenMs: number;
    instances: string[];
}

/** Asks every LIVE bili instance which sessions it knows about — the same
 *  best-effort probe `bili plugin remove` uses (#2155): a dead pid is already
 *  filtered by discoverLiveInstances, an unreachable/oddly-shaped instance
 *  only produces a warning line, never a failure. */
async function probeLiveSessions(instances: ProxyInstanceFile[]): Promise<{ seen: Map<string, LiveProbeView>; unreachable: ProxyInstanceFile[] }> {
    const seen = new Map<string, LiveProbeView>();
    const unreachable: ProxyInstanceFile[] = [];
    await Promise.all(instances.map(async (inst) => {
        const name = `${inst.instanceId} (pid ${inst.pid})`;
        try {
            const res = await fetch(inst.origin.replace(/\/$/, "") + "/__bili/sessions", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: "application/json" } });
            if (!res.ok) {
                unreachable.push(inst);
                return;
            }
            const data = (await res.json()) as { sessions?: Array<Record<string, unknown>> };
            for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
                const id = typeof s["id"] === "string" ? s["id"] : null;
                if (!id) continue;
                const lastSeenRaw = typeof s["lastSeen"] === "string" ? Date.parse(s["lastSeen"]) : Number.NaN;
                const cur = seen.get(id);
                if (cur) {
                    cur.live = cur.live || s["live"] === true;
                    if (Number.isFinite(lastSeenRaw)) cur.lastSeenMs = Math.max(cur.lastSeenMs, lastSeenRaw);
                    cur.instances.push(name);
                } else {
                    seen.set(id, { id, live: s["live"] === true, lastSeenMs: Number.isFinite(lastSeenRaw) ? lastSeenRaw : 0, instances: [name] });
                }
            }
        } catch {
            unreachable.push(inst);
        }
    }));
    return { seen, unreachable };
}

function activeReasons(id: string, seen: Map<string, LiveProbeView>): string[] {
    const view = seen.get(id);
    if (!view) return [];
    const where = view.instances.join(", ");
    if (view.live) return [`resident in memory on ${where}`];
    if (view.lastSeenMs > 0 && Date.now() - view.lastSeenMs <= ACTIVE_WINDOW_MS) {
        return [`active within the last ${Math.round(ACTIVE_WINDOW_MS / 60_000)} minutes on ${where}`];
    }
    return [];
}

interface CleanupSessionInfo {
    id: string;
    title?: string;
    label?: string;
    protocol?: string;
    upstreamOrigin?: string;
    /** Last persisted activity (max of envelope/row timestamps). */
    lastSaved: number;
    /** Bytes of the JSON envelope + CCR content-store files on disk. */
    jsonBytes: number;
    /** index.db footprint; null in legacy-only lanes. */
    dbStats: SessionStorageStats | null;
}

function fileBytesFor(dir: string, id: string, meta?: { protocol?: string; upstreamOrigin?: string }): number {
    let total = 0;
    for (const rel of [
        relPathFor(id, meta?.protocol, meta?.upstreamOrigin),
        relPathFor(id),
        flatFileNameFor(id),
        contentStoreRelPathFor(id, meta?.protocol, meta?.upstreamOrigin),
        contentStoreRelPathFor(id),
    ]) {
        try {
            total += statSync(path.join(dir, rel)).size;
        } catch {}
    }
    return total;
}

/** Union enumeration: unified rows (both modes — shadow rows are a baseline,
 *  full rows are authoritative) plus the JSON tree whenever the tree is still
 *  the truth base (legacy/shadow). Index-only ghost rows survive here too —
 *  they occupy DB space and are exactly what cleanup should show. */
export async function enumerateSessions(store: SessionStore, withSizes: boolean): Promise<CleanupSessionInfo[]> {
    type Entry = CleanupSessionInfo & { meta?: { protocol?: string; upstreamOrigin?: string } };
    const map = new Map<string, Entry>();
    const upsert = (id: string, patch: Partial<Entry>): void => {
        const cur = map.get(id);
        if (!cur) {
            map.set(id, { id, lastSaved: 0, jsonBytes: 0, dbStats: null, ...patch });
            return;
        }
        // The JSON tree is processed after the unified rows, so where both
        // exist it wins the display fields (it is the truth base in
        // legacy/shadow lanes); the rows alone cover index-only ghosts.
        if (patch.title !== undefined) cur.title = patch.title;
        if (patch.label !== undefined) cur.label = patch.label;
        if (patch.protocol !== undefined) cur.protocol = patch.protocol;
        if (patch.upstreamOrigin !== undefined) cur.upstreamOrigin = patch.upstreamOrigin;
        if (typeof patch.lastSaved === "number") cur.lastSaved = Math.max(cur.lastSaved, patch.lastSaved);
        if (patch.meta) cur.meta = patch.meta;
    };
    const baseline = store.webSummaryBaseline();
    if (baseline !== null) {
        for (const r of store.unifiedWebSummaries() ?? []) {
            upsert(r.sessionId, {
                title: r.hostTitle ?? r.title,
                label: r.label,
                protocol: r.protocol,
                upstreamOrigin: r.origin,
                lastSaved: r.updatedAt,
                meta: { protocol: r.protocol, upstreamOrigin: r.origin },
            });
        }
    }
    if (baseline !== "authoritative") {
        for (const s of [...(await store.loadAll()).values()]) {
            upsert(s.id, {
                title: s.meta.hostTitle ?? s.meta.title,
                label: s.meta.label,
                protocol: s.meta.protocol,
                upstreamOrigin: s.meta.upstreamOrigin,
                lastSaved: s.lastSeen,
                meta: { protocol: s.meta.protocol, upstreamOrigin: s.meta.upstreamOrigin },
            });
        }
    }
    const out: CleanupSessionInfo[] = [];
    for (const info of map.values()) {
        if (withSizes) {
            info.jsonBytes = fileBytesFor(store.dir, info.id, info.meta);
            info.dbStats = store.unifiedSessionStorageStats(info.id);
        }
        const { meta, ...publicInfo } = info;
        void meta;
        out.push(publicInfo);
    }
    out.sort((a, b) => b.lastSaved - a.lastSaved);
    return out;
}

interface RemoveOutcome {
    id: string;
    removed: boolean;
    blockedReasons: string[];
    envelopeFound: boolean;
    unifiedHadRows: boolean;
    pinnedKept: number;
}

async function removeOneSession(
    store: SessionStore,
    id: string,
    opts: { force: boolean; probe: Map<string, LiveProbeView> },
): Promise<RemoveOutcome> {
    const blocked: string[] = [];
    let pinnedKept = 0;
    if (store.replicasAvailable()) {
        const pinned = store.listReplicas(id).filter((cp) => cp.pinned);
        pinnedKept = pinned.length;
        if (pinned.length > 0 && !opts.force) {
            blocked.push(`pinned checkpoint(s) reference this session (${pinned.map((c) => `${c.cp_id} [${c.kind}]`).join(", ")}) — they hold CAS refcounts and outlive deletion by design; use --force to delete anyway`);
        }
    }
    if (!opts.force) {
        for (const reason of activeReasons(id, opts.probe)) {
            blocked.push(`session is ${reason}; use --force to delete anyway`);
        }
    }
    if (blocked.length > 0) {
        return { id, removed: false, blockedReasons: blocked, envelopeFound: false, unifiedHadRows: false, pinnedKept };
    }
    const res = await store.removeSession(id);
    if (!res.envelopeFound && !res.unifiedHadRows) {
        throw new Error(`session "${id}" not found in the sessions directory or index.db`);
    }
    return { id, removed: true, blockedReasons: [], envelopeFound: res.envelopeFound, unifiedHadRows: res.unifiedHadRows, pinnedKept };
}

function dbFileSize(dir: string): { main?: number; wal?: number } {
    const out: { main?: number; wal?: number } = {};
    try {
        out.main = statSync(path.join(dir, "index.db")).size;
    } catch {}
    try {
        out.wal = statSync(path.join(dir, "index.db-wal")).size;
    } catch {}
    return out;
}

function dbSizeLine(dir: string): string {
    const f = dbFileSize(dir);
    if (f.main === undefined) return "";
    const parts = [`index.db ${formatBytes(f.main)}`];
    if (f.wal !== undefined && f.wal > 0) parts.push(`+ WAL ${formatBytes(f.wal)}`);
    return parts.join(" ");
}

function renderLs(rows: CleanupSessionInfo[], withSizes: boolean, dir: string): string {
    if (rows.length === 0) {
        return "No persisted sessions found.";
    }
    const lines: string[] = [];
    if (withSizes) {
        lines.push(`${rows.length} session(s) under ${dir}:`);
        for (const r of rows) {
            const db = r.dbStats;
            const dbPart = db
                ? `db=${formatBytes(db.inlineBytes + db.casExclusiveBytes)} (inline ${formatBytes(db.inlineBytes)} + exclusive CAS ${formatBytes(db.casExclusiveBytes)}${db.casSharedBlobs > 0 ? `, ${db.casSharedBlobs} shared blob(s)` : ""}; ${db.rows.messages} msg / ${db.rows.blocks} blk${db.rows.pinnedCheckpoints > 0 ? ` / ${db.rows.pinnedCheckpoints} pinned cp` : ""})`
                : "db=n/a (legacy lane)";
            lines.push(
                `  ${r.id}${r.label ? `  label=${r.label}` : ""}  json=${formatBytes(r.jsonBytes)}  ${dbPart}  saved=${fmtDate(r.lastSaved)}  ${r.title ?? ""}`,
            );
        }
        const totalJson = rows.reduce((acc, r) => acc + r.jsonBytes, 0);
        const totalDb = rows.reduce((acc, r) => acc + (r.dbStats ? r.dbStats.inlineBytes + r.dbStats.casExclusiveBytes : 0), 0);
        lines.push("");
        lines.push(`total: json ${formatBytes(totalJson)} + db-attributed ${formatBytes(totalDb)}; ${dbSizeLine(dir)}`);
        lines.push("shared CAS blobs are counted once per owning session above; the file total also holds unattributed shared bytes.");
    } else {
        lines.push(`${rows.length} session(s):`);
        for (const r of rows) {
            lines.push(`  ${r.id}${r.label ? `  label=${r.label}` : ""}${r.protocol ? `  [${r.protocol}]` : ""}  saved=${fmtDate(r.lastSaved)}  ${r.title ?? ""}`);
        }
    }
    return lines.join("\n");
}

interface SessionsCommandOptions {
    dir?: string;
    sub: "ls" | "rm" | "prune";
    target?: string;
    olderThanMs?: number;
    withSizes: boolean;
    force: boolean;
    vacuum: boolean;
    json: boolean;
}

export async function runSessionsCommand(opts: SessionsCommandOptions): Promise<{ code: number; text: string }> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    try {
        if (opts.sub === "ls") {
            const rows = await enumerateSessions(store, opts.withSizes);
            return { code: 0, text: opts.json ? JSON.stringify({ sessionsDir: store.dir, sessions: rows }, null, 2) : renderLs(rows, opts.withSizes, store.dir) };
        }
        const instances = discoverLiveInstances();
        const { seen, unreachable } = await probeLiveSessions(instances);
        const notes: string[] = [];
        for (const inst of unreachable) {
            notes.push(`note: could not verify residency against live instance ${inst.instanceId} (pid ${inst.pid}) at ${inst.origin} — proceeding without that check`);
        }
        if (instances.length === 0) {
            notes.push("note: no live bili instance found — skipping the residency check");
        }

        let outcomes: RemoveOutcome[];
        if (opts.sub === "rm") {
            if (!opts.target) throw new Error('usage: bili sessions rm <id> [--force] [--no-vacuum]');
            outcomes = [await removeOneSession(store, opts.target, { force: opts.force, probe: seen })];
        } else {
            if (opts.olderThanMs === undefined) throw new Error("usage: bili sessions prune --older-than <dur> [--force] [--no-vacuum]");
            const cutoff = Date.now() - opts.olderThanMs;
            const candidates = (await enumerateSessions(store, false)).filter((r) => r.lastSaved > 0 && r.lastSaved < cutoff);
            outcomes = [];
            for (const c of candidates) {
                outcomes.push(await removeOneSession(store, c.id, { force: opts.force, probe: seen }));
            }
        }

        const removed = outcomes.filter((o) => o.removed);
        const blocked = outcomes.filter((o) => !o.removed);
        let vacuumNote = "";
        if (removed.length > 0 && store.replicasAvailable() && opts.vacuum) {
            const before = dbFileSize(store.dir);
            try {
                store.unifiedVacuum();
                const after = dbFileSize(store.dir);
                vacuumNote = `VACUUM: index.db ${before.main !== undefined ? formatBytes(before.main) : "?"} → ${after.main !== undefined ? formatBytes(after.main) : "?"}`;
            } catch (err) {
                vacuumNote = `VACUUM failed (${String(err)}) — rows are deleted; run "bili sessions rm <any-id> --no-vacuum" later or retry to shrink index.db`;
            }
        }

        const lines: string[] = [...notes];
        if (opts.sub === "rm") {
            const o = outcomes[0]!;
            if (!o.removed) {
                lines.push(`refused to delete ${o.id}:`);
                for (const reason of o.blockedReasons) lines.push(`  - ${reason}`);
                return { code: 1, text: lines.join("\n") };
            }
            lines.push(`deleted session ${o.id}${o.envelopeFound ? "" : " (no JSON envelope — index-only)"}${o.unifiedHadRows ? " + index.db rows (CAS refcounts released)" : ""}.`);
            if (o.pinnedKept > 0) lines.push(`note: ${o.pinnedKept} pinned checkpoint(s) kept — they hold CAS refcounts and survive deletion by design`);
        } else {
            lines.push(`prune --older-than ${parseDurationInverse(opts.olderThanMs!)}: ${removed.length} deleted, ${blocked.length} refused`);
            for (const o of removed) {
                lines.push(`  deleted   ${o.id}${o.pinnedKept > 0 ? ` (${o.pinnedKept} pinned cp kept)` : ""}`);
            }
            for (const o of blocked) {
                lines.push(`  REFUSED   ${o.id}: ${o.blockedReasons.join("; ")}`);
            }
            if (removed.length === 0 && blocked.length === 0) lines[lines.length - 1] = "nothing to prune (no session older than the cutoff)";
        }
        if (vacuumNote) lines.push(vacuumNote);
        const sizeNow = dbSizeLine(store.dir);
        if (sizeNow) lines.push(`now: ${sizeNow}`);
        const code = opts.sub === "prune" && removed.length === 0 && blocked.length > 0 ? 1 : 0;
        return { code, text: opts.json ? JSON.stringify({ sessionsDir: store.dir, outcomes, notes, vacuumNote }, null, 2) : lines.join("\n") };
    } finally {
        store.closeQuietly();
    }
}

function parseDurationInverse(ms: number): string {
    for (const [unit, mult] of [["w", 604_800_000], ["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
        if (ms % mult === 0) return `${ms / mult}${unit}`;
    }
    return `${Math.round(ms / 1000)}s`;
}
