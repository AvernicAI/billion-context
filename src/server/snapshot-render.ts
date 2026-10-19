import type { BiliMessage } from "acp-kernel/wire";
import { getStore } from "../persist.js";
import { featureEnabled } from "../rollout.js";
import type { Session } from "../session.js";

/**
 * #3756 snapshot render: assemble the outbound message view for a proxy
 * request from the server-side canonical transcript instead of re-deriving
 * message identity from the client-resent bytes.
 *
 * Doctrine (issue #3756, m-tier design): the (sessionId, unified snapshot)
 * pair IS the conversation; the client's resent history is an alignment
 * observation. Concretely:
 *
 *   - prefix authority: the unified transcript rows (core-form, fold-time
 *     message ids). Once a row exists, the outbound byte for it never
 *     changes — codec/identity upgrades re-mint client ids every turn but
 *     rows keep the ids the kernel assigned at fold time (#3752 becomes a
 *     non-event: refs/tags stay stable, the upstream cache prefix holds).
 *   - tail authority: the client's live messages — everything the client
 *     sent that the transcript has not yet recorded (this turn's fresh
 *     user message, the previous reply before it is re-observed) ride the
 *     client's own bytes.
 *   - alignment: a contiguous backward chain from the client's end against
 *     the transcript view (id fast path, then the #3658 canonical identity
 *     signature — role|contentType|toolName|text — so an upgrade turn where
 *     every id is re-minted still chains by content).
 *   - client head edits (checkpoints, deletions, compactions of the head)
 *     never resurrect or duplicate rows: the prefix renders what the server
 *     has, the chain's first unmatched client message starts the tail, and
 *     anything below the chain is dropped (server-authoritative head).
 *   - rewinds truncate the transcript view at the chain join: rows the
 *     client no longer vouches for (beyond the last chained row) do not
 *     render — the tail is client-authoritative past the join point.
 *
 * The merged view keeps kernel semantics untouched downstream: covered rows
 * ride fold-time ids so prune strips them by effectiveMessageIds and renders
 * the real summaries; a synthetic anchor (acp_summary_<blockId>) is inserted
 * past each block's covered region so collectSummaryAnchors resolves it at
 * a deterministic position even when every covered row is outside the view.
 *
 * Inactive (rollout off / no active blocks / store unavailable / empty or
 * unchainable transcript / any parse failure) ⇒ returns the client view
 * unchanged — the legacy path, never a guess.
 */

/** Client-tail walk budget. Full-resend histories are bounded by the wire;
 *  beyond this the lane degrades rather than scanning unbounded tails. */
const MAX_CHAIN_WALK = 8192;

/** #3658 canonical identity signature minus the hash: the tuple the kernel
 *  derives message ids from. Equal signature ⇒ same logical message even
 *  when the id bytes were re-minted by an upgrade. Image cores share the
 *  "[image]" text, so the sidecar length rides the signature (same image ⇒
 *  same bytes ⇒ same length; different images practically always differ). */
function identitySig(m: BiliMessage): string {
    const text = typeof m.text === "string" ? m.text : "";
    const img = m.imagePart === true ? `|img:${(m.imageBase64 ?? "").length}` : "";
    return `${m.role}|${m.contentType}|${m.toolName ?? ""}|${text}${img}`;
}

interface ViewRow {
    seq: number;
    msg: BiliMessage;
}

interface SnapshotRenderDeps {
    sessionId: string;
    log?: (level: string, msg: string) => void;
}

/** One-time + per-turn observability: the latch counts active renders; the
 *  activated flag logs exactly once per session. */
function noteRender(session: Session, deps: SnapshotRenderDeps): void {
    const prior = typeof session.metadata["snapshotRenderTurns"] === "number" ? (session.metadata["snapshotRenderTurns"] as number) : 0;
    session.metadata["snapshotRenderTurns"] = prior + 1;
    if (prior === 0) deps.log?.("info", `[snapshot-render] active: outbound prefix now rendered from the unified transcript (issue #3756)`);
}

/** Post-arm degrade marker (observability only — never touches outbound bytes).
 *  Set here, cleared on a successful render. Pre-arm exits (rollout off / nothing
 *  armed) must NOT route through this: an unrendered lane is not a degradation. */
function legacyFor(session: Session, deps: SnapshotRenderDeps, clientMsgs: BiliMessage[], reason: string): BiliMessage[] {
    session.metadata["snapshotRenderDegradeReason"] = reason;
    deps.log?.("debug", `[snapshot-render] legacy fallback (${reason})`);
    return clientMsgs;
}

function parseRow(content: string, seq: number): BiliMessage | null {
    try {
        const parsed = JSON.parse(content) as { id?: unknown; role?: unknown };
        if (typeof parsed.id !== "string" || typeof parsed.role !== "string") return null;
        return parsed as BiliMessage;
    } catch {
        return null;
    }
}

/**
 * Returns the merged view, or `clientMsgs` unchanged when the lane is
 * inactive/degraded. Pure with respect to the transcript: the only mutations
 * are two observability fields on `session.metadata` (the render latch and the
 * last post-arm degrade reason) — neither touches outbound bytes.
 */
export function maybeSnapshotView(session: Session, clientMsgs: BiliMessage[], deps: SnapshotRenderDeps): BiliMessage[] {
    if (!featureEnabled("snapshotRender")) return clientMsgs;
    const activeBlocks = session.state.blocks.filter((b) => b.active);
    if (activeBlocks.length === 0) return clientMsgs;
    const store = getStore();
    if (!store) return legacyFor(session, deps, clientMsgs, "store-unavailable");
    let rows: ViewRow[] = [];
    try {
        const rawRows = store.unifiedTailViewRows(session.id);
        const seqs = store.unifiedTailSeqs(session.id);
        if (!rawRows || rawRows.length === 0 || !seqs || seqs.length === 0) return legacyFor(session, deps, clientMsgs, "transcript-empty");
        const bySeq = new Map<number, ViewRow>();
        for (const row of rawRows) {
            const msg = parseRow(row.content, row.seq);
            if (!msg) return legacyFor(session, deps, clientMsgs, "row-unparsable"); // untrustworthy transcript: degrade, never guess
            bySeq.set(row.seq, { seq: row.seq, msg });
        }
        for (const seq of seqs) {
            const v = bySeq.get(seq);
            if (!v) return legacyFor(session, deps, clientMsgs, "view-pointer-missing-row"); // view pointer to a missing row: degrade
            rows.push(v);
        }
    } catch {
        return legacyFor(session, deps, clientMsgs, "transcript-error");
    }
    if (rows.length === 0) return legacyFor(session, deps, clientMsgs, "transcript-empty");

    // Backward chain: from the client's end, match view rows (id fast path,
    // then identity signature). The chain must be contiguous; the first
    // unmatched client message bounds the client tail.
    let joinRow = -1; // view index of the TOPMOST matched row — the join point
    let clientJoin = clientMsgs.length; // first client index of the tail
    {
        const byId = new Map<string, number>(); // msgId -> view index (last occurrence)
        for (let i = 0; i < rows.length; i++) byId.set(rows[i].msg.id, i);
        const bySig = new Map<string, number[]>(); // sig -> descending view indices
        for (let i = rows.length - 1; i >= 0; i--) {
            const sig = identitySig(rows[i].msg);
            const list = bySig.get(sig);
            if (list) list.push(i);
            else bySig.set(sig, [i]);
        }
        let cursor = rows.length; // exclusive upper bound: matched rows must sit below this
        let started = false;
        for (let k = clientMsgs.length - 1; k >= 0 && clientMsgs.length - 1 - k < MAX_CHAIN_WALK; k--) {
            const m = clientMsgs[k];
            const sig = identitySig(m);
            let hit = -1;
            const byIdHit = byId.get(m.id);
            if (byIdHit !== undefined && byIdHit < cursor) hit = byIdHit;
            else {
                const cands = bySig.get(sig);
                if (cands) {
                    for (const idx of cands) {
                        if (idx < cursor) {
                            hit = idx;
                            break; // cands are descending: first below cursor is the nearest
                        }
                    }
                }
            }
            if (hit < 0) {
                // Before the chain starts, unmatched messages are the live
                // tail (this turn's fresh user message, last turn's reply
                // not yet re-observed) — skip them. Once the chain has
                // started, an unmatched message ENDS it (contiguity).
                if (started) break;
                continue;
            }
            if (!started) {
                started = true;
                clientJoin = k + 1; // tail = everything above the topmost matched message
                joinRow = hit; // the join point: the prefix renders every row up to and including it
            }
            cursor = hit;
        }
        if (!started) return legacyFor(session, deps, clientMsgs, "chain-not-started"); // nothing chains: epoch-like rewrite, legacy
    }
    const d = joinRow + 1; // prefix = rows[0..d) — everything up to the join; rows beyond (rewound-away tails) never render

    // Anchor synthesis: one anchor per active block, positioned past the
    // block's covered region in the transcript (first view row whose seq
    // exceeds this block's deepest covered row; end-of-prefix when none).
    // Per-block covered seqs seed from effectiveMessageIds; the identity
    // signature propagates them to upgrade-twin rows (id re-minted, same
    // content). Covered rows themselves ride the prefix so prune strips them
    // by effectiveMessageIds and renders the real summary — the anchor is
    // the deterministic fallback position, not the stripper.
    const anchors: { at: number; msg: BiliMessage }[] = [];
    const coveredSeqUnion = new Set<number>();
    for (const block of activeBlocks) {
        const blockSeqs = new Set<number>();
        const blockSigs = new Set<string>();
        for (const id of block.effectiveMessageIds) {
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].msg.id === id) {
                    blockSeqs.add(rows[i].seq);
                    blockSigs.add(identitySig(rows[i].msg));
                }
            }
        }
        if (blockSeqs.size > 0) {
            for (let i = 0; i < rows.length; i++) {
                if (!blockSeqs.has(rows[i].seq) && blockSigs.has(identitySig(rows[i].msg))) blockSeqs.add(rows[i].seq);
            }
        }
        for (const seq of blockSeqs) coveredSeqUnion.add(seq);
        let maxCover = -1;
        for (const seq of blockSeqs) maxCover = Math.max(maxCover, seq);
        let at = d;
        for (let i = 0; i < d; i++) {
            if (rows[i].seq > maxCover) {
                at = i;
                break;
            }
        }
        anchors.push({
            at,
            msg: { id: `acp_summary_${block.blockId}`, role: "system", contentType: "text", text: "" } as BiliMessage,
        });
    }
    anchors.sort((a, b) => a.at - b.at);

    // The ENGINE owns coverage on this lane: covered rows never render —
    // prune's effectiveMessageIds strip cannot be trusted here because
    // reconcile may have re-keyed the block to the client's re-minted ids
    // (#3752 upgrade turns), while the transcript rows keep fold-time ids.
    // The synthesized anchor above carries each block's summary instead.
    const merged: BiliMessage[] = [];
    let ai = 0;
    for (let i = 0; i < d; i++) {
        while (ai < anchors.length && anchors[ai].at === i) merged.push(anchors[ai++].msg);
        if (coveredSeqUnion.has(rows[i].seq)) continue;
        merged.push(rows[i].msg);
    }
    while (ai < anchors.length) merged.push(anchors[ai++].msg);
    for (let k = clientJoin; k < clientMsgs.length; k++) merged.push(clientMsgs[k]);

    delete session.metadata["snapshotRenderDegradeReason"];
    noteRender(session, deps);
    return merged;
}
