// #2645 probe-and-remember: process-local registry of (upstream origin, model)
// pairs that have PROVEN they reject `prompt_cache_key`, by controlled A/B at
// the relay egress seam (src/server/relay.ts): when an egress carrying the key
// 400s, the identical request is re-sent once without it.
//   retry accepted   -> causation confirmed -> the pair is ablated here;
//   retry still fails -> inconclusive       -> nothing is learned, the key
//                      stays in every subsequent body, the original 400
//                      passes through verbatim.
// The memory is deliberately NON-persistent and config-free (owner directive,
// #2645 thread): no disk state, no config surface — a proxy restart re-probes.
// Every ablation must be visible: warn log here, acp_status section
// (src/acp-status.ts) and web panel banner (GET /__bili/panel-data
// pckSuppressions), naming the destination, the model, and the affected
// conversation ids. That visibility covers the one known false-positive: a
// transient unrelated 400 misattributed to the key silently degrades
// prefix-cache affinity on a friendly relay/account pool for the rest of this
// process's life — the operator can see exactly which pair stopped sending
// the key and why.

import { normalizeUpstreamOrigin } from "./util.js";
import { log as loggerLog } from "./logger.js";

interface PckAblationEntry {
    origin: string;
    model?: string;
    firstAt: number;
    lastAt: number;
    confirmations: number;
    sessions: string[];
}

interface AblationRecord extends PckAblationEntry {
    sessionCounts: Map<string, number>;
}

const MAX_SESSIONS_TRACKED = 8;
const entries = new Map<string, AblationRecord>();

function keyOf(origin: string, model?: string): string {
    return `${origin}\u0000${model ?? ""}`;
}

/** True when this exact origin+model pair has been A/B-confirmed as
 *  prompt_cache_key-hostile for the lifetime of this process. Unknown origins
 *  are never ablated (fail open = keep sending the key). */
export function pckKeyAbated(egressUrl: string | undefined, fallbackOrigin: string | undefined, modelId?: unknown): boolean {
    const origin = normalizeUpstreamOrigin(egressUrl) ?? normalizeUpstreamOrigin(fallbackOrigin);
    if (!origin) return false;
    const model = typeof modelId === "string" && modelId !== "" ? modelId : undefined;
    return entries.has(keyOf(origin, model));
}

export function recordPckAblation(facts: {
    origin: string;
    model?: unknown;
    sessionId: string;
    statusWithKey: number;
    errSnippet: string;
}): void {
    const origin = normalizeUpstreamOrigin(facts.origin) ?? facts.origin.trim();
    if (!origin) return;
    const model = typeof facts.model === "string" && facts.model !== "" ? facts.model : undefined;
    const now = Date.now();
    const k = keyOf(origin, model);
    let e = entries.get(k);
    const where = `${origin}${model ? ` (model ${model})` : ""}`;
    if (!e) {
        e = { origin, model, firstAt: now, lastAt: now, confirmations: 1, sessions: [], sessionCounts: new Map() };
        entries.set(k, e);
        const snippet = facts.errSnippet.replace(/\s+/g, " ").slice(0, 200);
        loggerLog("warn", `[pck] ${where} rejected prompt_cache_key — A/B confirmed (with key: HTTP ${facts.statusWithKey}; identical request without the key was accepted). bili now withholds the cache-routing key from this destination until proxy restart (#2645 probe-and-remember). Affected session(s): ${facts.sessionId}. Upstream error: ${snippet || "(empty body)"}. CAVEAT: if this destination is a relay/account pool keyed by prompt_cache_key, its prefix-cache affinity for these conversations may degrade for the rest of this process's lifetime (a transient unrelated 400 can be misattributed); restart resets.`);
    } else {
        e.confirmations += 1;
        e.lastAt = now;
        loggerLog("debug", `[pck] ${where} ablation reconfirmed (${e.confirmations}× total, session ${facts.sessionId}, #2645)`);
    }
    if (facts.sessionId) {
        e.sessionCounts.set(facts.sessionId, (e.sessionCounts.get(facts.sessionId) ?? 0) + 1);
        e.sessions = [...e.sessionCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, MAX_SESSIONS_TRACKED);
    }
}

/** Snapshot for acp_status / the web panel payload — newest first. */
export function pckAblations(): PckAblationEntry[] {
    return [...entries.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .map(({ sessionCounts: _sessionCounts, ...rest }) => rest);
}

export function _resetPckProbeForTest(): void {
    entries.clear();
}
