// #3977 goal B: the preflight exit state machine. Every exit of
// preflightCompressIfNeeded is exactly one of these verdicts, decided by the
// triple 【evidence adjudication (src/size-evidence.ts), walk result
// (PreflightResult), fit measurement (fits)】 — not by if-chain position.
// Failure titles render from the FAIL_FAST verdict at a single site.
//
// Migration plan for this enum (issue #3977): it LANDS here in step 1 as the
// typed contract; step 2 routes the eight escape hatches through the
// transition table that consumes these kinds; step 3 collapses the exit sites
// onto one render. Until step 2 the preflight function still returns its
// Prepared | PreflightFailFast shapes directly — behavior is unchanged.

/** Why a payload is forwarded ONCE for upstream arbitration instead of being
 *  folded or refused. Each reason is one escape hatch family:
 *  - probe-evidence: #2313 estimate-only probe (baseline carries no current-
 *    route upstream evidence; forward once to acquire usage/overflow evidence)
 *  - image-billing: #496/#1800 image arbitration — images alone clear the
 *    window on estimate with no overflow evidence (immediate + post-fold gates)
 *  - divergence: #1839 the walk's own post-fold view fits but the rebuilt
 *    normal-config payload measures over
 *  - fresh-size: #3146 fresh (unknown-baseline) session still over-window by
 *    local estimate after maximum folding */
export type ForwardOnceReason = "probe-evidence" | "image-billing" | "divergence" | "fresh-size";

/** What a fail-fast verdict is FOR. The class drives retry semantics and the
 *  rendered title; status/retryable stay explicit fields because the same
 *  class can carry different statuses across paths (deterministic-exhaustion
 *  is always 413, transient is 502 today but is defined by cause, not code). */
export type FailFastClass =
    | "aborted"                  // client disconnected mid-preflight (status 0, no response)
    | "doomed-bytes"             // #2490/#3146 doom math: no tokenizer could fit it (413, retryable=false)
    | "deterministic-exhaustion" // #3461: math proved no combination of folds closes the gap (413)
    | "upstream-throttle"        // upstream 429 surfaced through preflight (503)
    | "transient"                // relay-dependent exhaustion: empty/truncated summaries, budget draws, pool saturation (502)
    | "dead-end-cooldown";       // #726 cached diagnosis replayed without re-running the walk

export type PreflightVerdict =
    /** Payload fits the window (or never triggered); forward as-is. */
    | { kind: "forward-fits" }
    /** Folding committed and the rebuilt payload fits; forward the rebuild. */
    | { kind: "fold" }
    /** Forward exactly once; the upstream arbitrates size/billing (#496 house pattern). */
    | { kind: "forward-once-arbitrate"; reason: ForwardOnceReason }
    /** Refuse locally with a diagnostic; nothing was forwarded. */
    | { kind: "fail-fast"; status: number; retryable: boolean; cls: FailFastClass }
    /** Dead-end cooldown active: identical request already proved un-foldable (#726). */
    | { kind: "cooldown" }
    /** Growth-armed zero progress with no foldable candidates: lean steady state, no backoff (#2638). */
    | { kind: "steady-state" }
    /** Growth-armed zero progress caused purely by queue drops: pool congestion, retry next turn (#2662). */
    | { kind: "congestion" };
