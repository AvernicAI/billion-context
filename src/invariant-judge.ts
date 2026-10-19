// #3842 — Outbound-invariant judge (the "attribution layer").
//
// Decides, for ONE request, whether bili rewrote the client's own history on
// the way out. It reconciles the INBOUND core (what the client sent) against
// the OUTBOUND core (what bili forwarded) at the kernel canonical-core level
// (#3658) — wire-neutral, so same-wire and cross-wire share one code path.
//
// Invariants (owner design, #3842):
//   I1 (no fold): every inbound stable message appears at the outbound in
//     order, normalized-equal. Only legal diffs: (a) tail appends, (b) the
//     named, count-bounded exemption list — chain checkpoint, NOTE/nudge
//     carriers, acp_summary carriers, policy reasoning drops, crush envelopes.
//   I2 (fold): all divergence is confined to [earliest-fold-start, end); the
//     bytes before the fold point stay identical, and the fold carrier stays
//     pinned (anchor drift is a violation too).
//
// Single-request independence: the inbound core IS the client ground truth, so
// the judge needs no cross-request state — structurally avoiding the process-
// local seam pairing's restart blindness (#2773).
//
// Division of labor (kept separate on purpose): this judge = attribution
// ("whose fault"); seamLcp (#2131, consecutive outbound-vs-previous-outbound)
// = miss detection ("money lost"). A client restart/id-change passes I1
// correctly yet still breaks the provider prefix cache — that layer owns it.
//
// normalize-on-compare (renderTags=text-only, #2483/#3842): render tags are
// re-stamped onto historical assistant text EVERY request, so they are stripped
// from BOTH sides before comparison. This closes the exemption list WITHOUT
// changing a single outbound byte (zero behavior change).
//
// Pure: no I/O, no mutation. `judgeInboundOutbound` never throws on well-formed
// input; the runtime wrapper records events only and never blocks traffic.

import type { CoreMessage } from "acp-kernel";
import { openaiToCore, anthropicToCore, responsesToCore, googleToCore } from "acp-kernel/wire";

// `<acp tokens="N" type="T">ref</acp>`; angle brackets hex-escaped per KDD#2.
// An optional leading newline is consumed too — the renderer injects the tag on
// its own line, so leaving it behind would false-positive every re-tagged turn.
const RENDER_TAG_RE = /\n?\x3cacp\s[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g;
const CHAIN_TAG_PREFIX = "\x3cbili-chain ";
const SUMMARY_MARKER = "[Compressed conversation section]";
// kernel/src/crush.ts CRUSH_KEY — a tool-result decoding to an object with this
// key was legitimately crushed (lossless, deterministic), not rewritten.
const CRUSH_KEY = "__acp_crush";

export type ViolationKind =
  | "mid-history-rewrite"
  | "mid-history-drop"
  | "mid-insertion"
  | "fold-boundary-drift"
  | "carrier-drift";

export interface Violation {
  kind: ViolationKind;
  /** Inbound index implicated (-1 when the finding is positional on the exit side). */
  index: number;
  detail: string;
}

export interface JudgeVerdict {
  ok: boolean;
  folded: boolean;
  foldStart?: number;
  matched: number;
  total: number;
  violations: Violation[];
}

export interface JudgeOptions {
  // Carriers are few per request; a wider gap than this before the next stable
  // match reads as a rewrite, not an injection. Default 4.
  maxCarrierGap?: number;
}

function normText(m: CoreMessage): string {
  return (m.text ?? "").replace(RENDER_TAG_RE, "").trim();
}

function isReasoning(m: CoreMessage): boolean {
  return m.contentType === "reasoning";
}

function isCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.startsWith(CHAIN_TAG_PREFIX) || t.includes(SUMMARY_MARKER);
}

function isSummaryCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.includes(SUMMARY_MARKER) || m.id.startsWith("acp_summary");
}

function isCrushedToolResult(m: CoreMessage): boolean {
  if (m.contentType !== "tool-result") return false;
  const t = (m.text ?? "").trim();
  if (!t.startsWith("{")) return false;
  try {
    const o = JSON.parse(t) as unknown;
    return !!o && typeof o === "object" && Object.hasOwn(o as Record<string, unknown>, CRUSH_KEY);
  } catch {
    return false;
  }
}

function fp(m: CoreMessage): string {
  const id = m.toolCallId ? `#${m.toolCallId}` : "";
  const name = m.contentType === "tool-call" && m.toolName ? `:${m.toolName}` : "";
  const t = normText(m).replace(/\s+/g, " ").trim().slice(0, 80);
  return `${m.role}/${m.contentType}${name}${id}|${t}`;
}

// Identity is content-primary: tool-call ids are re-minted on re-projection
// (#2821) while bytes stay identical, so a differing toolCallId never vetoes a
// content-equal pair (order-centric, KDD#11). toolName stays a hard gate.
function stableEqual(a: CoreMessage, b: CoreMessage): boolean {
  if (a.role !== b.role || a.contentType !== b.contentType) return false;
  if (a.contentType === "tool-call" && a.toolName && b.toolName && a.toolName !== b.toolName) return false;
  if (isCrushedToolResult(b)) return true;
  return normText(a) === normText(b);
}

/**
 * Reconcile one request's inbound core against its outbound core. Returns a
 * structured verdict; never throws on well-formed input. On a corrupted stream
 * it may report several related violations — `ok` is authoritative, details aid triage.
 */
export function judgeInboundOutbound(
  entry: readonly CoreMessage[],
  exit: readonly CoreMessage[],
  opts: JudgeOptions = {},
): JudgeVerdict {
  const maxGap = opts.maxCarrierGap ?? 4;
  const violations: Violation[] = [];
  let matched = 0;
  let total = 0;

  // The fold point is the first summary carrier; everything before it is the
  // frozen prefix (must match), everything from it on is the fold/tail (free).
  const sumIdx = exit.findIndex(isSummaryCarrier);
  const folded = sumIdx !== -1;
  const freezeEnd = folded ? sumIdx : exit.length;
  let foldStart = -1;

  let j = 0;
  for (let i = 0; i < entry.length; i++) {
    const e = entry[i];
    if (isReasoning(e)) continue;
    if (folded && j >= freezeEnd) { foldStart = i; break; } // remainder is the folded region
    total++;

    let found = -1;
    let nearTwin = false;
    for (let k = j; k < freezeEnd; k++) {
      if (k - j > maxGap) break;
      const x = exit[k];
      if (isCarrier(x) || isReasoning(x)) continue;
      if (stableEqual(e, x)) { found = k; break; }
      if (x.role === e.role && x.contentType === e.contentType && (!e.toolCallId || !x.toolCallId || x.toolCallId === e.toolCallId)) nearTwin = true;
    }

    if (found < 0) {
      violations.push({
        kind: nearTwin ? "mid-history-rewrite" : "mid-history-drop",
        index: i,
        detail: `inbound[${i}] ${fp(e)} absent from outbound frozen prefix`,
      });
      j++; // soft resync: one bad cell must not cascade into a total unfold (#2821)
      continue;
    }

    for (let k = j; k < found; k++) {
      const x = exit[k];
      if (!isCarrier(x) && !isReasoning(x)) {
        violations.push({ kind: "mid-insertion", index: i, detail: `unexplained outbound element before inbound[${i}]: ${fp(x)}` });
      }
    }
    matched++;
    j = found + 1;
  }

  // Carrier pinning (I2): a non-carrier element sitting before the fold carrier
  // that exceeds the matched frozen prefix means the anchor drifted.
  if (folded && sumIdx > matched) {
    for (let k = matched; k < sumIdx; k++) {
      const x = exit[k];
      if (!isCarrier(x) && !isReasoning(x)) {
        violations.push({ kind: "carrier-drift", index: -1, detail: `element before fold carrier at outbound[${k}]: ${fp(x)}` });
        break;
      }
    }
  }

  return {
    ok: violations.length === 0,
    folded,
    ...(folded && foldStart >= 0 ? { foldStart } : {}),
    matched,
    total,
    violations,
  };
}

// --- Runtime wiring (advisory, disarmed by default) --------------------------
// Deliberately OFF unless explicitly armed: no config surface is invented here
// (production enablement/sampling/counters is an owner decision, #3842). While
// armed it reconciles every request through the real path and reports verdicts
// to the sink; it never mutates the body or throws out.
export interface InvariantJudgeInput {
  /** Inbound cores (what the client sent) — already computed by prepare. */
  originalMessages?: readonly CoreMessage[];
  /** Outbound request body (the exact bytes forwarded) — re-parsed to core here. */
  body?: string | Buffer;
  protocol?: string;
}

// Re-parse the ACTUAL outbound body through its own wire codec so the exit side
// reflects exactly what crossed the wire. prepare builds the body from
// rebuiltMessages, NOT from processedMessages — comparing those internal
// snapshots diverges for reasons unrelated to the invariant (token estimation,
// ref re-minting, ordering repairs). Same codec on both sides ⇒ directly
// comparable and wire-neutral, which is also what makes cross-wire work.
function parseExitCores(body: string | Buffer | undefined, protocol: string | undefined): CoreMessage[] | null {
  if (!body || !protocol) return null;
  const text = typeof body === "string" ? body : body.toString("utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  try {
    switch (protocol) {
      case "openai": return openaiToCore(parsed as Parameters<typeof openaiToCore>[0]).msgs;
      case "anthropic": return anthropicToCore(parsed as Parameters<typeof anthropicToCore>[0]).msgs;
      case "responses": return responsesToCore(parsed as Parameters<typeof responsesToCore>[0]).msgs;
      case "google": return googleToCore(parsed as Parameters<typeof googleToCore>[0]).msgs;
      default: return null;
    }
  } catch { return null; }
}

type Sink = (v: JudgeVerdict) => void;
// Test-only fault injector: simulates a bili defect in the exit core so the
// wired path can be proven to detect it without depending on an unfixed bug.
// It operates on a throwaway copy — the relayed body is never touched.
type Fault = (exitCores: CoreMessage[]) => CoreMessage[];
let armed = false;
let sink: Sink | null = null;
let fault: Fault | null = null;

export function _setInvariantJudgeForTest(enabled: boolean, s?: Sink): void {
  armed = enabled;
  sink = enabled ? (s ?? null) : null;
}

export function _setInvariantJudgeFaultForTest(fn?: Fault | null): void {
  fault = fn ?? null;
}

export function maybeRunInvariantJudge(input: InvariantJudgeInput): void {
  if (!armed) return;
  try {
    const entry = input.originalMessages ?? [];
    const exitCores0 = parseExitCores(input.body, input.protocol);
    if (!exitCores0) return; // unparseable/unknown wire → skip, never false-positive
    const exitCores = fault ? fault([...exitCores0]) : exitCores0;
    const v = judgeInboundOutbound(entry, exitCores);
    if (!v.ok && sink) sink(v);
  } catch {
    // advisory layer: a judge failure must never disturb the request
  }
}
