// #3003 deferred fold materialization — the burst-hold gate.
//
// Problem: K consecutive compress rounds pay K prefix-cache seams. Each fold
// commits to state (blocks/refs/ledger) and the NEXT request's view renders
// the folded history — every fold leg rewrites the outbound prefix, so a
// cross-ROUND compress burst (model folds, sees the result, folds again …)
// breaks the cache once per fold (#3003 / the seam cost analysis in the #3670
// thread). Same-round parallel folds already coalesce (loop/core.ts executes
// every tool call of a round, then ONE refresh); the residual cost is folds
// spread across rounds.
//
// Fix: keep the fold COMMITTED (state is truth — refs, ledger, consumed
// classification, decompress all see it immediately) but defer its
// MATERIALIZATION into the outbound view while the burst continues:
//   - a request that carries a NEW successful compress result renders the RAW
//     view (byte-identical prefix → full cache hit; the model still sees its
//     tool_result — the pair rides the raw tail as usual);
//   - the first request with NO new compress result materializes ALL held
//     folds — exactly one seam for the whole burst;
//   - window pressure (≥ FOLD_HOLD_PRESSURE_PCT of the effective window)
//     materializes immediately — never hold past the point where the raw view
//     could overflow.
//
// Worst case (gap-separated single folds) = today's behavior, one seam per
// fold, never worse. Restart/fork-safe by construction: the hold set lives in
// a WeakMap keyed by the in-memory Session object — an evicted/reloaded or
// forked session has no entry and materializes on its next view build.
//
// Cache ledger: no deferral plumbing needed there — a held fold's FoldEvent
// is recorded at commit but stays 0-claim until a repayment sample consumes
// it (#2929 cold-tail claiming), and hold legs are warm hits (raw prefix =
// full cache), so attribution naturally lands on the ONE materialization leg.
//
// Knob: BILI_DEFER_MATERIALIZATION > compress.deferMaterialization > true
// (src/knobs.ts). The knob is read live, so flipping it mid-burst clears the
// hold on the next view build (resolvePrepareHold materializes when disabled).

import type { CompressionState, ProcessTurnInput, ProcessTurnResult } from "acp-kernel";
import type { Session } from "./session.js";
import { deferMaterializationEnabled } from "./knobs.js";

/** Context size fraction at which a held fold materializes immediately
 *  instead of waiting out the burst — the raw view must never be the thing
 *  that overflows the window. 0.9 sits below the kernel's default emergency
 *  band (0.95) so pressure materializes before truncation can arm. */
export const FOLD_HOLD_PRESSURE_PCT = 0.9;

interface FoldHoldRuntime {
    /** Block ids committed but not yet materialized into a view. */
    heldBlockIds: Set<string>;
    /** Bumped on every tracked fold commit. */
    lastCommitSeq: number;
    /** Value of lastCommitSeq as of the previous prepare-side view build. */
    seenPrepareSeq: number;
    /** Hold legs served since the last materialization (logging only). */
    burstLegs: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const holds = new WeakMap<Session, FoldHoldRuntime>();

function runtimeOf(session: Session): FoldHoldRuntime {
    let rt = holds.get(session);
    if (!rt) {
        rt = { heldBlockIds: new Set(), lastCommitSeq: 0, seenPrepareSeq: 0, burstLegs: 0 };
        holds.set(session, rt);
    }
    return rt;
}

/** Called at the applyRanges commit point (the single funnel every lane —
 *  injected tools, plugin/native HTTP, loop rounds — funnels through).
 *  `hold: false` is for emergency folds (preflight overflow rescue) whose
 *  entire purpose is shrinking the CURRENT request. */
export function noteFoldCommit(session: Session, newBlockIds: readonly string[], opts?: { hold?: boolean }): void {
    const rt = runtimeOf(session);
    if (newBlockIds.length > 0) rt.lastCommitSeq += 1;
    if (opts?.hold === false) return;
    if (!deferMaterializationEnabled()) return;
    for (const id of newBlockIds) rt.heldBlockIds.add(id);
}

/** Held (committed, view-deferred) block ids for this session object. */
export function heldFoldBlockIds(session: Session): ReadonlySet<string> {
    const rt = holds.get(session);
    return rt ? rt.heldBlockIds : EMPTY_SET;
}

/** True when the context is close enough to the window that holding the raw
 *  view is no longer safe — materialize now. */
export function foldHoldPressure(tokenCount: number, limit: number): boolean {
    return limit > 0 && tokenCount > 0 && tokenCount >= FOLD_HOLD_PRESSURE_PCT * limit;
}

interface PrepareHoldDecision {
    /** Serve this view build from the RAW history (held folds stay deferred). */
    hold: boolean;
    /** The held ids when `hold` is true (empty otherwise). */
    heldBlockIds: ReadonlySet<string>;
}

/** Prepare-side gate. Advances the prepare seq; decides hold vs materialize.
 *  `limit` = the resolved effective context window (loopConfig.modelContextLimit);
 *  `tokenCount` = the same effectiveTokenCount value fed to processTurn —
 *  usage-grade when available, which during a hold reflects the RAW view the
 *  upstream is actually billing (honest pressure signal). */
export function resolvePrepareHold(session: Session, opts: { limit: number; tokenCount: number; log?: (msg: string) => void }): PrepareHoldDecision {
    const rt = holds.get(session);
    if (!rt || rt.heldBlockIds.size === 0) return { hold: false, heldBlockIds: EMPTY_SET };
    const log = opts.log ?? (() => {});
    const newCommit = rt.lastCommitSeq > rt.seenPrepareSeq;
    rt.seenPrepareSeq = rt.lastCommitSeq;
    if (!deferMaterializationEnabled() || foldHoldPressure(opts.tokenCount, opts.limit)) {
        const n = rt.heldBlockIds.size;
        const why = !deferMaterializationEnabled() ? "knob disabled" : "window pressure";
        rt.heldBlockIds.clear();
        rt.burstLegs = 0;
        log(`[fold-hold] materialized ${n} held block(s) (${why}) — view rebuilt with the fold(s) (#3003)`);
        return { hold: false, heldBlockIds: EMPTY_SET };
    }
    if (newCommit) {
        rt.burstLegs += 1;
        log(`[fold-hold] holding ${rt.heldBlockIds.size} block(s) through the compress burst (leg ${rt.burstLegs}) — raw view, prefix byte-identical (#3003)`);
        return { hold: true, heldBlockIds: rt.heldBlockIds };
    }
    const n = rt.heldBlockIds.size;
    rt.heldBlockIds.clear();
    const legs = rt.burstLegs;
    rt.burstLegs = 0;
    log(`[fold-hold] materialized ${n} held block(s) after ${legs} burst leg(s) — one seam for the whole burst (#3003)`);
    return { hold: false, heldBlockIds: EMPTY_SET };
}

/** Drop every held id (the view being built already renders them folded —
 *  the loop's refreshFolded path). Idempotent. */
export function clearFoldHold(session: Session): void {
    const rt = holds.get(session);
    if (!rt) return;
    rt.heldBlockIds.clear();
    rt.burstLegs = 0;
}

/** Clone `state` with the held blocks knocked out of the VIEW — the kernel
 *  pipeline then renders their ranges raw. The real session state is never
 *  passed this clone (see processTurnWithHold for the restore step).
 *
 *  `active:false` ALONE is not enough: the kernel's per-pass sync
 *  (kernel/src/sync.ts:83) RE-ACTIVATES every non-consumed block whose raw
 *  messages (or summary carrier) ride the resent history — and on a hold leg
 *  the client resends the raw content by construction, so sync would undo the
 *  hold before prune ever runs. The `expanded` flag is the kernel's one
 *  sanctioned "render raw while the block lives" channel (the decompress
 *  feature; fork adoption uses the same {active:false, expanded:true} pair in
 *  src/plugin.ts:1280), and sync deliberately leaves expanded blocks
 *  inactive. The restore step below clears the flag again — the flag never
 *  reaches the adopted session.state. */
export function holdViewState(state: CompressionState, held: ReadonlySet<string>): CompressionState {
    if (held.size === 0 || state.blocks.length === 0) return state;
    return {
        ...state,
        blocks: state.blocks.map((b) => (held.has(b.blockId) && b.active !== false ? { ...b, active: false, expanded: true } : b)),
    };
}

/** Re-activate the held blocks on the state processTurn returned, before the
 *  caller adopts it as session.state — the hold is a VIEW-only fiction; the
 *  ledger stays active the whole time.
 *
 *  `origActive` is the pre-clone activity map of the input state. Only blocks
 *  that were ACTIVE before the clone get resurrected: a block the user
 *  genuinely decompressed mid-burst (host-set expanded, already inactive in
 *  session.state) is never flipped by holdViewState, and must not be
 *  resurrected here either. The fictional `expanded` flag is stripped along
 *  the way — it must never reach the adopted session.state. */
export function restoreHeldBlocks(state: CompressionState, held: ReadonlySet<string>, origActive?: ReadonlyMap<string, boolean>): CompressionState {
    if (held.size === 0 || state.blocks.length === 0) return state;
    return {
        ...state,
        blocks: state.blocks.map((b) => (held.has(b.blockId) && (origActive === undefined || origActive.get(b.blockId) === true) ? { ...b, active: true, expanded: undefined } : b)),
    };
}

/** Drop nudge ranges whose BOTH endpoints live inside held blocks. On a hold
 *  leg the view state does not fold the held ranges, so the kernel's
 *  recommender legitimately re-advertises them as compressible — but the real
 *  ledger already covers them, and a model following the nudge would hit the
 *  "already covered by active block(s)" refusal (bounded #156 spin, pure
 *  noise). Ranges only PARTIALLY overlapping a held block are kept: their
 *  uncovered tail may still be legitimately foldable, and the kernel's apply
 *  side judges them precisely. When nothing honest remains to advertise, the
 *  whole nudge is dropped for this leg (#3003). */
function excludeHeldRanges(
    nudge: ProcessTurnResult["nudge"],
    state: CompressionState,
    held: ReadonlySet<string>,
): ProcessTurnResult["nudge"] {
    if (!nudge || nudge.compressibleRanges.length === 0 || held.size === 0) return nudge;
    const heldRefs = new Set<string>();
    for (const b of state.blocks) {
        if (!held.has(b.blockId)) continue;
        for (const id of b.effectiveMessageIds) {
            const ref = state.messageRefs.byRaw[id];
            if (ref !== undefined) heldRefs.add(ref);
        }
    }
    if (heldRefs.size === 0) return nudge;
    const kept = nudge.compressibleRanges.filter((r) => !(heldRefs.has(r.startRef) && heldRefs.has(r.endRef)));
    if (kept.length === nudge.compressibleRanges.length) return nudge;
    if (kept.length === 0) return undefined;
    return { ...nudge, compressibleRanges: kept };
}

/** The prepare-side processTurn wrapper: runs the burst-hold gate, feeds the
 *  kernel the (possibly) held view state, and restores the real active flags
 *  on the returned state so the caller can adopt it unchanged. Everything
 *  else about the input passes through untouched. */
export function processTurnWithHold(
    session: Session,
    core: { processTurn: (input: ProcessTurnInput) => ProcessTurnResult },
    input: ProcessTurnInput,
    opts: { limit: number; log?: (msg: string) => void },
): ProcessTurnResult {
    const decision = resolvePrepareHold(session, { limit: opts.limit, tokenCount: input.tokenCount, log: opts.log });
    const viewState = decision.hold ? holdViewState(input.state, decision.heldBlockIds) : input.state;
    const origActive = new Map(input.state.blocks.map((b) => [b.blockId, b.active]));
    const turn = core.processTurn({ ...input, state: viewState });
    if (decision.hold && turn.nudge) turn.nudge = excludeHeldRanges(turn.nudge, input.state, decision.heldBlockIds);
    if (decision.hold) turn.state = restoreHeldBlocks(turn.state, decision.heldBlockIds, origActive);
    return turn;
}

