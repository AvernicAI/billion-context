/**
 * Snapshot lane (#3756): the server-side snapshot is the authoritative rendering
 * source for proxy-lane outbound history — root fix of #3752 (R2).
 *
 * Why this exists: in proxy mode every message id is derived from the bytes the
 * client resends each turn (deriveCanonicalMessageId at parse time). When the
 * kernel's identity function changes (#3658), every id in a persisted session is
 * re-minted → block effectiveMessageIds coverage lists lose track of everything →
 * heuristic reconciliation cannot save past-limit sessions → mass unfold
 * (126K→998K tokens, 2% cache hit). This lane pins historical ids to what the
 * unified store already recorded, so re-minting old messages structurally
 * disappears: a kernel upgrade or identity-function swap can never touch them.
 *
 * Mechanism (per proxy-mode turn, after XToCore):
 *   - A per-session registry mirrors the unified `messages` table rows
 *     ((session_id, seq), protocol-neutral core BiliMessage JSON — schema.ts:127),
 *     cold-seeded from unifiedRawMessages and kept exact across restarts by a
 *     small persisted row-id list (session_ext "snap:reg").
 *   - The client's freshly parsed core view is aligned against the registry
 *     ORDER-CENTRICALLY (KDD #11 doctrine at lane level): content keys are
 *     dialect-neutral (role|contentType|toolName|text — toolCallId excluded by
 *     design, #3642) and HOST-computed (node:crypto sha256), so they survive
 *     kernel identity-function changes; stored-id equality is the fast path.
 *   - Aligned prefix messages are STAMPED with their stored ids before the
 *     pipeline continues. Downstream nothing changes shape: reconcileFoldCoverage
 *     finds full coverage (dormant), the kernel's own fold rendering matches
 *     zero-drift, and the outbound prefix bytes stay stable turn-over-turn.
 *   - New tail messages keep their derived ids and join the registry on append —
 *     they become pinned from the next turn on.
 *
 * Divergence semantics (pinned down in #3756):
 *   - UNCOVERED tail region: the client is authoritative. Rewind/edit-tail
 *     truncates the registry there (originals stay retrievable via CCR); rows the
 *     client stopped resending are dropped.
 *   - COVERED region: the server is authoritative. Rows covered by an active
 *     block survive any client delete/rewind/checkpoint replacement — they stay
 *     in the view so the kernel keeps rendering their summaries (outbound
 *     unchanged). A foreign head the client swaps in (dsh-style wholesale
 *     checkpoint replacement) is ABSORBED as observation: recorded (head marker +
 *     one info log) but never forwarded into the outbound.
 *
 * Shapes handled in v1 — everything else falls through to PASSTHROUGH (the
 * client's parsed view is returned untouched = today's exact behavior, zero
 * regression by construction):
 *   APPEND    registry is a prefix of the resend (steady state; also appends that
 *             land after a truncation whose retained covered tail sits at the end
 *             of the registry — all trailing registry rows must be covered).
 *   TRUNCATE  resend is a strict prefix of the registry (rewind / edit-tail).
 *   REPLACE   m==0, matched suffix L≥MIN_TAIL_MATCH, foreign middle segment with
 *             no key overlap anywhere in the registry (checkpoint landing).
 * Bail reasons: mid-conversation insertion, reorder/reinsert, ambiguous short
 * tails, gaps beyond MAX_GAP_SKIP, duplicate-append collision.
 *
 * Gate: rollout feature `proxySnapshotLane` (default OFF — env/config gray
 * release per #3062) AND a live unified store (shadow or full). Plugin mode is
 * out of scope (the agent owns compression there). Legacy storage: one info log
 * per session, existing path unchanged. Block bookkeeping stays id-keyed — no
 * seq migration because stored ids are never re-minted (id-keyed == seq-keyed
 * stability). Non-goals (v1): google lane, middle-edit pinning, CCR storage of
 * absorbed heads, #3771 image fingerprint seeds.
 */

import { createHash } from "node:crypto";
import type { BiliMessage } from "acp-kernel/wire";
import type { CompressionState } from "acp-kernel";
import { getStore } from "./persist.js";
import { featureEnabled } from "./rollout.js";
import { coveredRealHistoryIds } from "./session.js";

const FEATURE = "proxySnapshotLane";
const EXT_REGISTRY = "snap:reg";
const EXT_HEAD = "snap:head";

/** In-memory registries, LRU-ordered (insertion order = recency). Mirrors the
 *  incremental lane's canonicalCache bound — full histories are MB-scale. */
const REGISTRY_LIMIT = 16;
/** Max registry rows the forward walk may skip over (server-retained rows the
 *  client stopped resending) before declaring divergence. */
const MAX_GAP_SKIP = 64;
/** Consecutive agreements required to accept a gap jump (resync run). */
const MIN_RESYNC_RUN = 3;
/** Minimum matched suffix for foreign-head absorption (REPLACE). */
const MIN_TAIL_MATCH = 3;
/** Bound for the info-once legacy-fallback set. */
const LEGACY_INFO_LIMIT = 1024;

interface Row {
    seq: number;
    id: string;
    key: string;
    core: BiliMessage;
}

interface Registry {
    rows: Row[];
    /** High-water seq for cold-seed filtering (appended rows beyond it are
     *  picked up from the store without an ext rewrite). */
    maxSeq: number;
    /** Absorbed foreign-head key list (REPLACE); null = none. */
    headKeys: string[] | null;
}

const registries = new Map<string, Registry>();
const legacyInfoLogged = new Set<string>();
const bailLogged = new Map<string, Set<string>>();

/** Host-side alignment key: dialect-neutral and independent of the kernel's
 *  (upgradable) identity function. toolCallId is deliberately EXCLUDED — it is
 *  re-minted across dialects/projections (#3642 doctrine); an image sidecar
 *  digest is included so image-only differences don't collide. */
export function alignKeyOf(m: BiliMessage): string {
    let s = `${m.role}|${m.contentType}|${m.toolName ?? ""}|${m.text ?? ""}`;
    if (typeof m.imageBase64 === "string" && m.imageBase64.length > 0) {
        s += "|img:" + createHash("sha256").update(m.imageBase64).digest("hex");
    }
    return createHash("sha256").update(s).digest("hex");
}

function pairEq(r: Row, c: BiliMessage, rKey: string, cKey: string): boolean {
    return r.id === c.id || rKey === cKey;
}

function bailReasons(sessionId: string): Set<string> {
    let set = bailLogged.get(sessionId);
    if (!set) {
        set = new Set();
        bailLogged.set(sessionId, set);
    }
    return set;
}

function infoOnceLegacy(sessionId: string, log: (level: string, msg: string) => void): void {
    if (legacyInfoLogged.has(sessionId)) return;
    legacyInfoLogged.add(sessionId);
    if (legacyInfoLogged.size > LEGACY_INFO_LIMIT) legacyInfoLogged.clear();
    log("info", `[snaplane:${sessionId}] unified store unavailable — snapshot lane inactive, existing path unchanged (info once)`);
}

function bailOnce(sessionId: string, reason: string, detail: string, log: (level: string, msg: string) => void): void {
    const set = bailReasons(sessionId);
    if (set.has(reason)) return;
    set.add(reason);
    log("debug", `[snaplane:${sessionId}] passthrough: ${reason} (${detail})`);
}

interface PersistedRegistry {
    v: number;
    ids: string[];
    maxSeq: number;
}

function readPersistedRegistry(sessionId: string): PersistedRegistry | null {
    try {
        const v = getStore().getSessionExt(sessionId, EXT_REGISTRY);
        if (typeof v !== "object" || v === null) return null;
        const o = v as Partial<PersistedRegistry>;
        if (o.v !== 1 || !Array.isArray(o.ids) || !Number.isFinite(o.maxSeq)) return null;
        return { v: 1, ids: o.ids.filter((x): x is string => typeof x === "string"), maxSeq: o.maxSeq as number };
    } catch {
        return null;
    }
}

function persistRegistry(sessionId: string, reg: Registry, log: (level: string, msg: string) => void): void {
    try {
        getStore().setSessionExt(sessionId, EXT_REGISTRY, {
            v: 1,
            ids: reg.rows.map((r) => r.id),
            maxSeq: reg.maxSeq,
        } satisfies PersistedRegistry);
    } catch (err) {
        bailOnce(sessionId, "ext-write-failed", String(err), log);
    }
}

function parseRows(raw: { seq: number; content: string }[]): Row[] {
    const out: Row[] = [];
    for (const row of raw) {
        let p: unknown;
        try {
            p = JSON.parse(row.content);
        } catch {
            continue; // malformed row: skip (store-level corruption is logged elsewhere)
        }
        if (typeof p !== "object" || p === null) continue;
        const m = p as BiliMessage;
        if (typeof m.id !== "string" || typeof m.role !== "string" || typeof m.contentType !== "string") continue;
        out.push({ seq: row.seq, id: m.id, key: alignKeyOf(m), core: m });
    }
    return out;
}

function ensureRegistry(sessionId: string): Registry | null {
    let reg = registries.get(sessionId);
    if (reg) {
        // LRU touch: move to the back (most recent).
        registries.delete(sessionId);
        registries.set(sessionId, reg);
        return reg;
    }
    const store = getStore();
    if (!store.replicasAvailable()) return null;
    const raw = store.unifiedRawMessages(sessionId);
    if (raw === null) return null;
    const all = parseRows(raw);
    let rows = all;
    const persisted = readPersistedRegistry(sessionId);
    if (persisted && persisted.ids.length > 0) {
        const byId = new Map<string, Row>();
        for (const r of all) if (!byId.has(r.id)) byId.set(r.id, r);
        const out: Row[] = [];
        for (const id of persisted.ids) {
            const r = byId.get(id);
            if (r) out.push(r);
        }
        rows = out;
    }
    // Appended rows ingested after the last ext rewrite ride the seq filter.
    const maxSeqSoFar = persisted?.maxSeq ?? Number.MIN_SAFE_INTEGER;
    if (persisted) {
        for (const r of all) {
            if (r.seq > maxSeqSoFar && !rows.some((x) => x.id === r.id)) rows.push(r);
        }
        rows.sort((a, b) => a.seq - b.seq);
    }
    reg = {
        rows,
        maxSeq: rows.reduce((mx, r) => Math.max(mx, r.seq), 0),
        headKeys: null,
    };
    try {
        const h = store.getSessionExt(sessionId, EXT_HEAD);
        if (Array.isArray(h) && h.every((x) => typeof x === "string")) reg.headKeys = h as string[];
    } catch {
        /* head marker unavailable: treat as none */
    }
    registries.set(sessionId, reg);
    while (registries.size > REGISTRY_LIMIT) {
        const oldest = registries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        registries.delete(oldest);
        bailLogged.delete(oldest);
    }
    return reg;
}

function appendRows(reg: Registry, fresh: BiliMessage[], seenIds: Set<string>, sessionId: string, log: (level: string, msg: string) => void): void {
    for (const m of fresh) {
        if (seenIds.has(m.id)) {
            bailOnce(sessionId, "dup-append", `id ${m.id} already in registry`, log);
            continue;
        }
        reg.maxSeq += 1;
        reg.rows.push({ seq: reg.maxSeq, id: m.id, key: alignKeyOf(m), core: m });
        seenIds.add(m.id);
    }
}

export interface PinInput {
    sessionId: string;
    protocol: string;
    pluginMode: boolean;
    msgs: BiliMessage[];
    state: CompressionState;
    log: (level: string, msg: string) => void;
}

/** Pin historical message ids onto the server-side snapshot. Returns the same
 *  array reference untouched whenever the lane does not engage (gate off,
 *  plugin mode, legacy storage, empty view, or any unsupported shape) — the
 *  caller then proceeds exactly as before. */
export function pinSnapshotIds(input: PinInput): BiliMessage[] {
    const { sessionId, pluginMode, msgs, state, log } = input;
    if (pluginMode || msgs.length === 0) return msgs;
    if (!featureEnabled(FEATURE)) return msgs;
    const reg = ensureRegistry(sessionId);
    if (reg === null) {
        infoOnceLegacy(sessionId, log);
        return msgs;
    }
    const covered = coveredRealHistoryIds(state.blocks);
    const cKeys = msgs.map(alignKeyOf);

    // Absorbed foreign head (previous REPLACE): verify, then exclude from the
    // aligned view — it was observed, never adopted into the outbound.
    let shift = 0;
    if (reg.headKeys && reg.headKeys.length > 0) {
        if (msgs.length >= reg.headKeys.length) {
            let ok = true;
            for (let i = 0; i < reg.headKeys.length; i++) {
                if (cKeys[i] !== reg.headKeys[i]) { ok = false; break; }
            }
            shift = ok ? reg.headKeys.length : 0;
            if (!ok) reg.headKeys = null; // client dropped the absorbed head
        } else {
            reg.headKeys = null;
        }
    }
    const C = msgs.slice(shift);
    const cK = cKeys.slice(shift);
    const R = reg.rows;
    const rK = R.map((r) => r.key);

    // Order-centric forward walk: positional agreement advances both; a break
    // tries a bounded gap-jump over server-retained rows and accepts it only
    // on a MIN_RESYNC_RUN consecutive-agreement resync (KDD #11 doctrine).
    // mapC/t records the EXACT C↔R pairing (a jump makes mC ≠ mR, so parallel
    // indexing would mis-stamp ids); skipped records jumped-over registry rows.
    const mapC: number[] = [];
    const skipped: number[] = [];
    let i = 0;
    let j = 0;
    outer: while (i < C.length && j < R.length) {
        if (pairEq(R[j], C[i], rK[j], cK[i])) { mapC.push(j); i++; j++; continue; }
        for (let k = j + 1; k < R.length && k <= j + MAX_GAP_SKIP; k++) {
            if (!pairEq(R[k], C[i], rK[k], cK[i])) continue;
            let ii = i;
            let kk = k;
            let run = 0;
            while (ii < C.length && kk < R.length && pairEq(R[kk], C[ii], rK[kk], cK[ii])) { ii++; kk++; run++; }
            if (run >= MIN_RESYNC_RUN) {
                for (let s = j; s < k; s++) skipped.push(s);
                for (let s = i; s < ii; s++) mapC.push(k + (s - i));
                i = ii;
                j = kk;
                continue outer;
            }
            break;
        }
        break;
    }
    const mC = i;
    const mR = j;
    const restR = R.length - mR;
    const restC = C.length - mC;

    // Aligned prefix in registry order: aligned rows take the client's bytes
    // (cache-stable) stamped with the stored id; gap-skipped rows emit their
    // stored core so their ids stay visible to the kernel (absence of a
    // covered id reads as drift and would unfold the block).
    const emitAlignedPrefix = (out: BiliMessage[]): void => {
        let t = 0;
        for (let r = 0; r < mR; r++) {
            if (t < mC && mapC[t] === r) { out.push({ ...C[t], id: R[r].id }); t++; }
            else out.push(R[r].core);
        }
    };

    // APPEND: everything left in the registry is covered-retained (or empty) —
    // the client's remainder is all-new tail.
    if (restR === 0 || R.slice(mR).every((r) => covered.has(r.id))) {
        const gapBad = skipped.find((s) => !covered.has(R[s].id));
        if (gapBad !== undefined) {
            bailOnce(sessionId, "gap-uncovered", `registry row ${gapBad} skipped by the client is not covered (mid-history edit — v1 passthrough)`, log);
            return msgs;
        }
        // Ambiguity guard: the UNALIGNED registry is what the client no longer
        // presents in place — tail content re-presenting ITS keys is a
        // checkpoint-shaped rewrite, not an append. (Aligned rows may legally
        // recur in the tail: repeated user content.)
        const rKeySet = new Set(R.slice(mR).map((r) => r.key));
        for (let t = mC; t < C.length; t++) {
            if (rKeySet.has(cK[t])) {
                bailOnce(sessionId, "dup-append", `tail key collides with unaligned registry at position ${t}`, log);
                return msgs;
            }
        }
        const view: BiliMessage[] = [];
        emitAlignedPrefix(view);
        for (let t = mR; t < R.length; t++) view.push(R[t].core);
        for (let t = mC; t < C.length; t++) view.push(C[t]);
        const seen = new Set(reg.rows.map((r) => r.id));
        appendRows(reg, C.slice(mC), seen, sessionId, log);
        return view;
    }

    // TRUNCATE: the client stopped resending at mC — uncovered dead-zone rows
    // drop (client authoritative, CCR keeps originals), covered rows retain
    // (server authoritative — their summaries keep rendering).
    if (restC === 0) {
        const dead = R.slice(mR);
        const retained = dead.filter((r) => covered.has(r.id));
        const view: BiliMessage[] = [];
        emitAlignedPrefix(view);
        for (const r of retained) view.push(r.core);
        reg.rows = [...R.slice(0, mR), ...retained];
        reg.maxSeq = Math.max(...reg.rows.map((r) => r.seq), 0);
        persistRegistry(sessionId, reg, log);
        return view;
    }

    // REPLACE: matched suffix + foreign middle segment (checkpoint landing).
    let L = 0;
    while (L < restC && L < restR && (rK[R.length - 1 - L] === cK[C.length - 1 - L] || R[R.length - 1 - L].id === C[C.length - 1 - L].id)) {
        L++;
    }
    if (L < MIN_TAIL_MATCH) {
        bailOnce(sessionId, "short-tail", `matched suffix ${L} < ${MIN_TAIL_MATCH} (mC=${mC}, mR=${mR}, restC=${restC}, restR=${restR})`, log);
        return msgs;
    }
    if (mC !== 0) {
        bailOnce(sessionId, "mid-insert", `agreed prefix ${mC} with non-empty remainders (v1 supports head-only foreign segments)`, log);
        return msgs;
    }
    const middleC = C.slice(0, C.length - L);
    const dead = R.slice(mR, R.length - L);
    const rKeySet = new Set(rK);
    for (const k of middleC) {
        if (rKeySet.has(alignKeyOf(k))) {
            bailOnce(sessionId, "foreign-overlap", "middle segment key present in registry (reorder/reinsert — v1 passthrough)", log);
            return msgs;
        }
    }
    const retained = dead.filter((r) => covered.has(r.id));
    const view: BiliMessage[] = [];
    for (const r of retained) view.push(r.core);
    for (let t = 0; t < L; t++) {
        view.push({ ...C[C.length - L + t], id: R[R.length - L + t].id });
    }
    reg.rows = [...retained, ...R.slice(R.length - L)];
    reg.maxSeq = Math.max(...reg.rows.map((r) => r.seq), 0);
    reg.headKeys = middleC.map((m) => alignKeyOf(m));
    persistRegistry(sessionId, reg, log);
    try {
        getStore().setSessionExt(sessionId, EXT_HEAD, reg.headKeys);
    } catch (err) {
        bailOnce(sessionId, "ext-write-failed", String(err), log);
    }
    log("info", `[snaplane:${sessionId}] absorbed ${middleC.length} foreign head message(s) (client checkpoint/rewrite) — recorded as observation, not forwarded; outbound keeps server summary + snapshot prefix (#3756)`);
    return view;
}

/** Test-only: drop all in-memory registries and once-log latches. */
export function __resetSnapshotLaneForTests(): void {
    registries.clear();
    legacyInfoLogged.clear();
    bailLogged.clear();
}
