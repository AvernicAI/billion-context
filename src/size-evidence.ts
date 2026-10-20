// #3977 Step 1 (pure extraction): the session's SIZE EVIDENCE stores get a
// single module. Knowledge that was scattered across server.ts inline blocks
// keeps its exact metadata keys, shapes, and semantics — this move changes
// WHERE the code lives, not what any decision observes. Later steps route the
// escape-hatch guards through fitEvidence()-style single adjudicators; those
// live here so a new hatch cannot forget a store that lives in another file.
//
// Evidence grades already latent in the codebase (#857 lastInputTokensSource,
// #3846 localRefusals, #1110 overflowArm): usage / overflow-arm / estimate /
// local-refusal. Step 2 makes them a first-class type over this module.

import { markDirty, type Session } from "./session.js";

// ---------------------------------------------------------------------------
// Store: localRefusals (#3846) — persisted local 413 evidence
// ---------------------------------------------------------------------------

// (comment block moved verbatim from server.ts with the store)
// probe / image arbitration / #1839 rebuilt-view divergence / #3146
// fresh-session) re-bets the same estimator guess — production shape: three
// consecutive full-bill forwards of 606K/620K/633K-token payloads bili itself
// had already refused locally. Persist refusals as their own metadata channel
// — NEVER as usage (that field is upstream billing evidence only) — scoped to
// the route/model/window that saw them; an equal-or-wider refused window
// covers the current equal-or-tighter one, anything else evaluates fresh.
interface LocalRefusalRecord {
    origin: string;
    model: string;
    window: number;
    at: number;
}

const LOCAL_REFUSAL_MAX_RECORDS = 16;

function readLocalRefusals(metadata: Record<string, unknown>): LocalRefusalRecord[] {
    const raw = metadata.localRefusals;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is LocalRefusalRecord =>
        !!r && typeof r === "object"
        && typeof (r as LocalRefusalRecord).origin === "string"
        && typeof (r as LocalRefusalRecord).model === "string"
        && typeof (r as LocalRefusalRecord).window === "number",
    );
}

/** Record a local 413 refusal for (origin, model, window). A wider refusal in
 *  the same scope already dominates (it covers every tighter window); a
 *  narrower one replaces it so the record tracks the widest verdict seen. */
export function noteLocalRefusal(session: Session, origin: string | undefined, model: string | undefined, window: number): void {
    if (!origin || !model || !Number.isFinite(window) || window <= 0) return;
    const records = readLocalRefusals(session.metadata);
    const existing = records.find((r) => r.origin === origin && r.model === model);
    if (existing !== undefined && existing.window >= window) return;
    session.metadata.localRefusals = [
        ...records.filter((r) => !(r.origin === origin && r.model === model)),
        { origin, model, window: Math.floor(window), at: Date.now() },
    ].slice(-LOCAL_REFUSAL_MAX_RECORDS);
    markDirty(session);
}

/** True when this session was locally refused (413) by the SAME origin+model
 *  at an equal or WIDER window — the current request may then not reopen any
 *  forward-once escape hatch (#3846). Both sides must be known
 *  (evidence-permitlist discipline: an unprovenanced refusal proves nothing
 *  about an unprovenanced request, and vice versa). */
export function localRefusalCovers(metadata: Record<string, unknown>, origin: string | undefined, model: string | undefined, window: number): boolean {
    if (!origin || !model) return false;
    return readLocalRefusals(metadata).some((r) => r.origin === origin && r.model === model && r.window >= window);
}

// ---------------------------------------------------------------------------
// Store: preflightDeadEnd (#728) — identical-request cooldown evidence
// ---------------------------------------------------------------------------

/** The persisted shape of the #728 dead-end cooldown: a fail-fast verdict for
 *  one exact request (sha256 of the inbound body keyed with model+window)
 *  that the upstream just rejected, held for a cooldown window so a spinning
 *  host cannot re-bill it. The READ side stays inline in server.ts this step:
 *  its replay semantics (status fallback, stale-key eviction) are exactly as
 *  rich as the block that owns them; the write side is owned here. */
interface PreflightDeadEndRecord {
    key: string;
    until: number;
    status: number;
    retryable: boolean;
    message: string;
}

/** Arm (or re-arm) the dead-end cooldown for one exact request. */
export function armDeadEnd(session: Session, record: PreflightDeadEndRecord): void {
    session.metadata.preflightDeadEnd = record;
    markDirty(session);
}
