// #3977 goal A: the single authority over SIZE EVIDENCE — what bili knows
// about how big a payload is, WHERE each number came from, and how much it can
// be trusted. The kernel owns WHAT is foldable (#3236 unit-projection); this
// module owns the evidence plane WHETHER-folding-suffices is judged against.
//
// Phase 1 (this file): the graded view over the existing stores + the local-
// refusal store, moved here from server.ts byte-for-byte. No persistence
// format changes: metadata keys stay exactly as they are; reads/writes merely
// converge on this facade. fitEvidence() — the single adjudication every
// forward-once / arbitration / backoff decision must route through — lands
// with its callers in migration step 2; learnFromOutcome() in step 4.

import { markDirty, type Session } from "./session.js";
import { normalizeUpstreamOrigin } from "./util.js";

/** Provenance grade of a size measurement. Estimation and hard evidence were
 *  one untyped number in the if-chain (#1839 estimate-as-fact, #3146 unknown-
 *  as-estimate, #3663 mixed rulers — three symptoms, one disease); every
 *  judgment now declares the grade it consumed. */
export type EvidenceGrade = "usage" | "overflow" | "local-refusal" | "estimate";

/** One size-evidence record. `at` is epoch ms; 0 while the underlying store
 *  carries no timestamp (the baseline store has none today — adding one is a
 *  persistence change deferred past phase 1). */
export interface SizeEvidence {
    kind: "baseline" | "refusal";
    origin: string | null; // normalized upstream origin; null = unprovenanced
    model: string | null;
    window: number | null; // the window the verdict was made against
    tokens: number;
    at: number;
    grade: EvidenceGrade;
}

/** Map the baseline store's source marker onto the grade ladder. Unknown or
 *  absent sources project to estimate — the exact legacy treatment (#1933:
 *  sessions started before the field existed keep legacy behavior). */
export function gradeOfSource(source: string | undefined): EvidenceGrade | null {
    if (source === "usage") return "usage";
    if (source === "overflow-arm") return "overflow";
    if (source === "estimate") return "estimate";
    return null;
}

/** The session's size baseline as one graded record. usage-grade measures what
 *  upstream billed; overflow-grade is upstream REJECTION evidence at that size
 *  (armOverflowShrink stamps the origin so the arm survives #1933 F2 on its
 *  own route); everything else is bili's own meter. */
export function readBaselineEvidence(stats: Session["stats"]): SizeEvidence {
    const tokens = typeof stats.lastInputTokens === "number" ? stats.lastInputTokens : 0;
    const origin = stats.lastInputTokensOrigin !== undefined ? normalizeUpstreamOrigin(stats.lastInputTokensOrigin) : undefined;
    return {
        kind: "baseline",
        origin: origin ?? null,
        model: null,
        window: null,
        tokens,
        at: 0,
        grade: gradeOfSource(stats.lastInputTokensSource) ?? "estimate",
    };
}

export interface BaselineProjection {
    floor: number; // the floor after cross-origin demotion
    from: number; // the raw floor before demotion (for the log line)
    demoted: boolean;
    origin: string | null; // the baseline's provenance origin (for the log line)
}

/** #1492 floor rule + #1933 F2 cross-origin demotion, pure. A usage-grade
 *  baseline floors the trigger while authoritative for THIS payload (it can
 *  legitimately exceed every local estimate — invisible thinking/cache
 *  components); an overflow-grade one is upstream rejection evidence at that
 *  size, floored too (#1195/#987 lose their trigger otherwise). An estimate-
 *  grade baseline floors only when the current payload is unmeasured
 *  (hasProcessedMessages=false ⇒ kernel transform failed ⇒ the outbound IS the
 *  raw body). A baseline measured on another origin is demoted to untrusted
 *  (provider billing scales differ per upstream, #1933 F2). Unprovenanced
 *  origins never demote anything — an unprovenanced baseline proves nothing
 *  about any specific route (evidence-permitlist discipline). */
export function baselineFloor(evidence: SizeEvidence, currentOrigin: string | undefined, hasProcessedMessages: boolean): BaselineProjection {
    const raw = hasProcessedMessages
        ? (evidence.grade === "usage" || evidence.grade === "overflow" ? evidence.tokens : 0)
        : evidence.tokens;
    if (raw > 0 && currentOrigin !== undefined && evidence.origin !== null && evidence.origin !== currentOrigin) {
        return { floor: 0, from: raw, demoted: true, origin: evidence.origin };
    }
    return { floor: raw, from: raw, demoted: false, origin: evidence.origin };
}

/** #496/#1839/#857: a baseline ≥ window counts as upstream overflow evidence
 *  ONLY at usage or overflow grade. An estimate-derived or legacy-unmarked
 *  baseline is NOT one (#857: preflight used to write image estimates back
 *  into lastInputTokens, which permanently closed the image-arbitration hatch
 *  on pixel-billing upstreams). */
export function hasOverflowEvidence(evidence: SizeEvidence, limit: number): boolean {
    return evidence.tokens >= limit && (evidence.grade === "usage" || evidence.grade === "overflow");
}

// #3846: a local 413 ("can never fit, NOT forwarded") is independent evidence
// that this origin/model/window cannot accept the payload — but it only ever
// lived in the #726 dead-end marker's body-hash dimension: the moment the
// baseline source demotes to estimate (the #2313 probe re-arms at
// baselineFloor === 0) or the body changes between turns (the hash misses),
// the refusal evaporates and every forward-once escape hatch (estimate-only
// probe / image arbitration / #1839 rebuilt-view divergence / #3146
// fresh-session) re-bets the same estimator guess — production shape: three
// consecutive full-bill forwards of 606K/620K/633K-token payloads bili itself
// had already refused locally. Persist refusals as their own metadata channel
// — NEVER as usage (that field is upstream billing evidence only) — scoped to
// the route/model/window that saw them; an equal-or-wider refused window
// covers the current equal-or-tighter one, anything else evaluates fresh.
export interface LocalRefusalRecord {
    origin: string;
    model: string;
    window: number;
    at: number;
}

const LOCAL_REFUSAL_MAX_RECORDS = 16;

export function readLocalRefusals(metadata: Record<string, unknown>): LocalRefusalRecord[] {
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
