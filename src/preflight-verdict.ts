// #3977 Step 1 (pure extraction): the FINAL preflight verdict — the status /
// retryable / progress / dead-end classification at the bottom of
// preflightCompressIfNeeded — becomes a pure function so later steps can make
// the exits a closed enumeration with ONE render point. Every expression below
// moved verbatim from server.ts (comments included): same inputs, same
// outputs, byte-identical messages.

/** Structural slice of the walk outcome the classification needs. The walk
 *  result itself stays internal to server.ts; only the fields the verdict
 *  reads are required here, so this stays a pure, dependency-free module. */
interface VerdictWalkSlice {
    kind?: string;
    deterministic?: boolean;
    status?: number;
    retryable?: boolean | undefined;
    detail?: string;
}

type PreflightStatus = 413 | 502 | 503;

/** (comment moved verbatim from server.ts)
 *  #3461 problem 2: DETERMINISTIC exhaustion (futile-round math proved no
 *  combination of folds can close the gap regardless of upstream health)
 *  can never succeed for this identical payload — answer it 413 like every
 *  other "can never fit as-is" verdict (#2847 lesson applied to the
 *  exhaustion path; #2921/#3146 doomed-bytes precedent) instead of 502,
 *  which status-code-driven headless hosts read as transient and spin on
 *  forever (field measurement: 5+ doomed rounds). Relay-dependent
 *  exhaustion (empty/truncated/incomplete summaries, budget draws, pool
 *  saturation) stays 502: those walks succeed once the relay recovers.
 *  AND only when bili's own calibrated meter agrees the payload is over the
 *  window (!payloadFitsWindow): when the calibrated estimate FITS but the
 *  walk still ran (char-count trigger arm, overflow-armed baseline), the
 *  doom is a relay-billing artifact bili cannot compute (#496/#767/#857
 *  byte-relay lanes) — bili must not declare structural doom for it; those
 *  lanes keep their 502 fail-fast contract where NOT re-forwarding IS the
 *  protection, not a client spin. */
export function classifyStatus(f: VerdictWalkSlice | undefined, payloadFitsWindow: boolean): PreflightStatus {
    return f?.kind === "upstream" && f.status === 429 ? 503 : f?.kind === "exhausted" && f.deterministic && !payloadFitsWindow ? 413 : 502;
}

/** (comment moved verbatim from server.ts)
 *  #3918: non-deterministic exhaustion WITH committed progress is not terminal —
 *  the folds persist in the session, so the next attempt starts from a smaller
 *  baseline and continues the fold. Reporting retryable=false told hosts to stop
 *  spinning exactly where each retry makes real progress (incident: 64 effective
 *  folds, every round declared terminal). Deterministic exhaustion keeps today's
 *  verdict: nothing more can fold from this view, so retries are genuinely doomed. */
export function progressContinues(f: VerdictWalkSlice | undefined, compressedRanges: number): boolean {
    return f?.kind === "exhausted" && !f.deterministic && compressedRanges > 0;
}

/** (comment moved verbatim from server.ts)
 *  #2189: an explicit retryable=false from preflight (credential-shape
 *  rejection — deterministic for the identical payload) overrides the
 *  status-based heuristic below; every other path keeps today's mapping. */
export function classifyRetryable(progress: boolean, f: VerdictWalkSlice | undefined): boolean {
    return progress ? true : f?.retryable === false ? false : f?.retryable === true || (f?.kind === "upstream" && f.status !== undefined && (f.status === 429 || f.status >= 500));
}

/** The #3918 progress suffix appended to the fail-fast detail when folds
 *  committed this turn persist for the next attempt. */
export function progressDetailSuffix(compressedRanges: number, foldedCalibratedSize: number | undefined, limit: number): string {
    const shortfall = foldedCalibratedSize !== undefined ? Math.max(0, limit - foldedCalibratedSize) : undefined;
    return ` ${compressedRanges} range(s) folded this turn persist in the session — the next attempt starts from a smaller baseline and continues the fold${shortfall !== undefined ? ` (~${shortfall.toLocaleString("en-US")} tokens short of the target)` : ""}.`;
}

/** (comment moved verbatim from server.ts — the dead-end arming condition)
 *  contentDeadEnd: exhausted walks, and non-retryable upstream 4xx verdicts,
 *  arm the identical-request cooldown only when nothing folded this turn. */
export function isContentDeadEnd(f: VerdictWalkSlice | undefined, retryable: boolean): boolean {
    return f?.kind === "exhausted" || (f?.kind === "upstream" && f.status !== undefined && f.status >= 400 && f.status < 500 && !retryable);
}
