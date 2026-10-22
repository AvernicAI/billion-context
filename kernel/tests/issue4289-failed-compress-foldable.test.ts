// #4289: a compress invocation that applied ZERO ranges (total-failure
// receipt "[Compression FAILED…") carries no summary carrier — no block cites
// its arguments, decompress/search never read them — yet it enjoyed
// compress's permanent exemption (ALWAYS_PROTECTED_TOOLS matches the tool
// NAME, not the outcome). Every failed retry pinned ~10KB of summary draft
// into context forever and raised the fold floor (measured: ~75% of a 227K
// context was compression residue). The exemption now follows the OUTCOME:
// total-failure exchanges fold like ordinary messages; success/partial
// receipts and result-less in-flight calls stay exempt. Existing sessions
// self-heal through the #2607 BLOCKED→numeric migration on the next
// assignRefs pass — no ledger script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs, BLOCKED_REF, indexToRef, refToIndex } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { collectFailedCompressCallIds } from "../src/protected.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage, CompressionState } from "../src/types.js";

const FAILED_RECEIPT =
  "[Compression FAILED: requested range(s) resolved to no messages]";
const PARTIAL_RECEIPT =
  "[Compressed m00001-m00002 (partial: 1 of 3 ranges applied) → 1 block(s), ~50 tokens saved]";
const SUCCESS_RECEIPT =
  "[Compressed m00001-m00002 → 1 block(s), ~120 tokens saved]";
const VALID_SUMMARY =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

// Emulates the bili host wiring (src/config.ts): hasProtection=true via the
// MCP hard-protection hook, dialect-aware compress recognition (#2970).
function biliConfig(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    isToolProtected: (name?: string) =>
      name === "mcp__bili__compress" || name === "mcp__bili__acp_rule",
    isCompressTool: (name: string) =>
      name === "compress" || name === "mcp__bili__compress",
    ...overrides,
  });
}

function mk(
  id: string,
  role: CoreMessage["role"],
  ct: CoreMessage["contentType"],
  toolName?: string,
  toolCallId?: string,
  text = "x".repeat(800),
): CoreMessage {
  return { id, role, contentType: ct, toolName, toolCallId, text };
}

// Main geometry: an early head, a SUCCESSFUL compress exchange, then a
// REASONING message nailed behind the FAILED exchange (turn-integrity
// withdrawal keeps it unfolded while the nail sits inside any span), then
// tail content.
function mainGeometry(): CoreMessage[] {
  return [
    mk("U1", "user", "text"),
    mk("A1", "assistant", "text"),
    mk("C_OK", "assistant", "tool-call", "compress", "ok", "y".repeat(9000)),
    mk("R_OK", "tool", "tool-result", "compress", "ok", SUCCESS_RECEIPT),
    mk("REASON", "assistant", "reasoning"),
    mk("C_FAIL", "assistant", "tool-call", "compress", "fail", "z".repeat(9000)),
    mk("R_FAIL", "tool", "tool-result", "compress", "fail", FAILED_RECEIPT),
    mk("U2", "user", "text"),
    mk("A2", "assistant", "text"),
  ];
}

function runTurn(messages: CoreMessage[], config: Config, state?: CompressionState) {
  const core = createCore();
  return core.processTurn({
    messages,
    state: state ?? createInitialState(),
    config,
    tokenCount: 1000,
  });
}

test("#4289 unit: collectFailedCompressCallIds marks only unrecognized-name-free total failures", () => {
  const msgs = [
    mk("c1", "assistant", "tool-call", "compress", "t1"),
    mk("r1", "tool", "tool-result", "compress", "t1", FAILED_RECEIPT),
    mk("c2", "assistant", "tool-call", "bash", "t2"),
    mk("r2", "tool", "tool-result", "bash", "t2", FAILED_RECEIPT),
    mk("c3", "assistant", "tool-call", "compress", "t3"),
    // Unnamed result: recognition falls back to the paired call's toolName.
    mk("r3", "tool", "tool-result", undefined, "t3", FAILED_RECEIPT),
    mk("r4", "tool", "tool-result", undefined, "t4", FAILED_RECEIPT),
    mk("c5", "assistant", "tool-call", "compress", "t5"),
    mk("r5", "tool", "tool-result", "compress", "t5", SUCCESS_RECEIPT),
  ];
  const ids = collectFailedCompressCallIds(msgs, {});
  assert.deepEqual(
    [...ids].sort(),
    ["t1", "t3"],
    "failed bare-name and unnamed-paired compress results marked; bash-shaped text, orphan result, success receipt are not",
  );
});

test("#4289 refs: failed compress exchange gets foldable numeric refs; successful stays BLOCKED", () => {
  const messages = mainGeometry();
  const config = biliConfig();
  const turn = runTurn(messages, config);
  const refs = turn.state.messageRefs.byRaw;

  assert.equal(refs["C_OK"], BLOCKED_REF, "successful call stays protected");
  assert.equal(refs["R_OK"], BLOCKED_REF, "successful result stays protected");
  assert.match(refs["C_FAIL"]!, /^m\d+$/, "failed call migrates to a numeric ref");
  assert.match(refs["R_FAIL"]!, /^m\d+$/, "failed result migrates to a numeric ref");
  assert.notEqual(
    refs["C_FAIL"],
    refs["R_FAIL"],
    "each half keeps its own distinct ref (id-never-reused)",
  );
});

test("#4289 recommend: failed exchange is advertised, successful exchange is not", () => {
  const messages = mainGeometry();
  const config = biliConfig();
  const turn = runTurn(messages, config);
  const ctx = buildCompressibleRanges(messages, turn.state, config);

  const idx = new Map(messages.map((m, i) => [m.id, i]));
  const failLo = idx.get("C_FAIL")!;
  const failHi = idx.get("R_FAIL")!;
  const okLo = idx.get("C_OK")!;
  const okHi = idx.get("R_OK")!;

  assert.ok(
    ctx.compressible.some(
      (r) =>
        (r.startIndex ?? 0) <= failLo &&
        (r.endIndex ?? 0) >= failHi,
    ),
    "a compressible range spans the failed exchange",
  );
  // Ref-level invariant with teeth: advertised ranges are ref-addressed, and
  // the successful exchange holds no numeric refs at all — so it can be
  // neither an endpoint nor an interior member of any range's ref span.
  // (Positional spans MAY cross the still-BLOCKED pair; BLOCKED messages
  // consume no slot and break no adjacency, and the apply-side carve-out
  // keeps them out of the folded set — proven by the apply test below.)
  const coveredIds = new Set<string>();
  for (const r of ctx.compressible) {
    const lo = refToIndex(r.startRef);
    const hi = refToIndex(r.endRef);
    if (lo === null || hi === null) continue;
    for (let n = lo; n <= hi; n++) {
      const id = turn.state.messageRefs.byRef[indexToRef(n)];
      if (id) coveredIds.add(id);
    }
  }
  assert.ok(coveredIds.has("C_FAIL") && coveredIds.has("R_FAIL"),
    "the failed exchange is addressable through advertised refs");
  assert.ok(!coveredIds.has("C_OK") && !coveredIds.has("R_OK"),
    "the successful exchange remains unaddressable by any advertised range");
});

test("#4289 apply: the full span folds the failed exchange AND the reasoning it had pinned; the successful exchange is carved out, not folded", () => {
  const core = createCore();
  const messages = mainGeometry();
  const config = biliConfig();
  const turn = runTurn(messages, config);
  const refs = turn.state.messageRefs.byRaw;

  const result = core.applyCompression({
    ranges: [{ startRef: refs["U1"]!, endRef: refs["A2"]!, summary: VALID_SUMMARY }],
    messages,
    state: structuredClone(turn.state),
    config,
  });

  assert.equal(result.result.errors.length, 0, result.result.errors.join("; "));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[0]!;
  for (const id of ["U1", "A1", "REASON", "C_FAIL", "R_FAIL", "U2", "A2"]) {
    assert.ok(
      block.effectiveMessageIds.includes(id),
      `${id} folded (the reasoning nailed behind the failed call goes with it)`,
    );
  }
  assert.ok(
    !block.effectiveMessageIds.includes("C_OK"),
    "successful call stays visible (carved out, not folded)",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("R_OK"),
    "successful result stays visible (carved out, not folded)",
  );
});

test("#4289 pairing: an unnamed failed result (toolCallId only) is unpinned too", () => {
  const messages = [
    ...mainGeometry(),
    mk("C_F2", "assistant", "tool-call", "compress", "fail2", "z".repeat(9000)),
    mk("R_F2", "tool", "tool-result", undefined, "fail2", FAILED_RECEIPT),
  ];
  const config = biliConfig();
  const turn = runTurn(messages, config);
  const refs = turn.state.messageRefs.byRaw;
  assert.match(refs["C_F2"]!, /^m\d+$/);
  assert.match(refs["R_F2"]!, /^m\d+$/, "unnamed result unpinned via the pairing set");
});

test("#4289 conservative: in-flight compress call (no result yet) stays protected", () => {
  const messages = [
    mk("U1", "user", "text"),
    mk("C_INFLIGHT", "assistant", "tool-call", "compress", "inflight", "z".repeat(9000)),
    mk("U2", "user", "text"),
  ];
  const turn = runTurn(messages, biliConfig());
  assert.equal(
    turn.state.messageRefs.byRaw["C_INFLIGHT"],
    BLOCKED_REF,
    "a result-less call keeps its exemption until its receipt arrives",
  );
});

test("#4289 conservative: partial-success receipt (starts '[Compressed') stays protected", () => {
  const messages = [
    mk("U1", "user", "text"),
    mk("C_PART", "assistant", "tool-call", "compress", "part", "z".repeat(9000)),
    mk("R_PART", "tool", "tool-result", "compress", "part", PARTIAL_RECEIPT),
    mk("U2", "user", "text"),
  ];
  const turn = runTurn(messages, biliConfig());
  assert.equal(turn.state.messageRefs.byRaw["C_PART"], BLOCKED_REF);
  assert.equal(turn.state.messageRefs.byRaw["R_PART"], BLOCKED_REF);
});

test("#4289 acp_rule: untouched by the carve-out, still BLOCKED", () => {
  const messages = [
    mk("U1", "user", "text"),
    mk("C_RULE", "assistant", "tool-call", "acp_rule", "rule"),
    mk("R_RULE", "tool", "tool-result", "acp_rule", "rule", "rule text"),
    mk("U2", "user", "text"),
  ];
  const turn = runTurn(messages, biliConfig());
  assert.equal(turn.state.messageRefs.byRaw["C_RULE"], BLOCKED_REF);
  assert.equal(turn.state.messageRefs.byRaw["R_RULE"], BLOCKED_REF);
});

test("#4289 host intent outranks the carve-out: isMessageProtected hook still pins a failed exchange", () => {
  const messages = mainGeometry();
  const config = biliConfig({
    isMessageProtected: (m) => m.id === "C_FAIL" || m.id === "R_FAIL",
  });
  const turn = runTurn(messages, config);
  assert.equal(turn.state.messageRefs.byRaw["C_FAIL"], BLOCKED_REF);
  assert.equal(turn.state.messageRefs.byRaw["R_FAIL"], BLOCKED_REF);
});

test("#4289 host intent outranks the carve-out: protectedTools pattern still pins a failed exchange", () => {
  const messages = mainGeometry();
  const config = biliConfig({ protectedTools: ["compress"] });
  const turn = runTurn(messages, config);
  assert.equal(turn.state.messageRefs.byRaw["C_FAIL"], BLOCKED_REF);
  assert.equal(turn.state.messageRefs.byRaw["R_FAIL"], BLOCKED_REF);
});

test("#4289 self-heal: stale BLOCKED refs from a pre-fix session migrate to numeric refs on the next turn", () => {
  const messages = mainGeometry();
  const config = biliConfig();
  // Simulate the pre-upgrade ledger: every compress half was BLOCKED back
  // then (name-based exemption), everything else held a live ref.
  const state = createInitialState();
  state.messageRefs = {
    byRaw: {
      U1: "m00001",
      A1: "m00002",
      C_OK: BLOCKED_REF,
      R_OK: BLOCKED_REF,
      REASON: "m00003",
      C_FAIL: BLOCKED_REF,
      R_FAIL: BLOCKED_REF,
      U2: "m00004",
      A2: "m00005",
    },
    byRef: {},
  };
  const turn = runTurn(messages, config, state);
  const refs = turn.state.messageRefs.byRaw;

  assert.match(refs["C_FAIL"]!, /^m\d+$/, "stale failed call migrated");
  assert.match(refs["R_FAIL"]!, /^m\d+$/, "stale failed result migrated");
  assert.equal(refs["C_OK"], BLOCKED_REF, "successful call stays BLOCKED through the pass");
  assert.equal(refs["R_OK"], BLOCKED_REF, "successful result stays BLOCKED through the pass");
  for (const id of ["C_FAIL", "R_FAIL"]) {
    assert.ok(
      (turn.state.renderDeferredRefs ?? []).includes(refs[id]!),
      `${id}'s fresh ref defers its tag re-render to the next fold boundary (#3939②)`,
    );
  }
});

test("#4289 MCP dialect: mcp__bili__compress failure folds, success stays BLOCKED (isToolProtected path)", () => {
  const messages = [
    mk("U1", "user", "text"),
    mk("C_MOK", "assistant", "tool-call", "mcp__bili__compress", "mok", "y".repeat(9000)),
    mk("R_MOK", "tool", "tool-result", "mcp__bili__compress", "mok", SUCCESS_RECEIPT),
    mk("C_MFAIL", "assistant", "tool-call", "mcp__bili__compress", "mfail", "z".repeat(9000)),
    mk("R_MFAIL", "tool", "tool-result", "mcp__bili__compress", "mfail", FAILED_RECEIPT),
    mk("U2", "user", "text"),
  ];
  const turn = runTurn(messages, biliConfig());
  const refs = turn.state.messageRefs.byRaw;
  assert.equal(refs["C_MOK"], BLOCKED_REF, "MCP success stays protected via the hook");
  assert.equal(refs["R_MOK"], BLOCKED_REF);
  assert.match(refs["C_MFAIL"]!, /^m\d+$/, "MCP failure lifted via the same carve-out");
  assert.match(refs["R_MFAIL"]!, /^m\d+$/);
});
