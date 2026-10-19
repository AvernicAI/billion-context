// #3842 — I1/I2 outbound-invariant judge: unit-level proof of the decision logic.
// Positive fixtures pin the exemption list at zero false positives; negative
// controls prove the judge goes red on the within-request rewrite/drop/reorder/
// insert shapes (#3676/#3769 family) and on fold-boundary drift (I2).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { judgeInboundOutbound } from "../src/invariant-judge.js";

let n = 0;
function mk(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string, extra: Partial<CoreMessage> = {}): CoreMessage {
  n++;
  return { id: `m${String(n).padStart(5, "0")}`, role, contentType, ...(text !== undefined ? { text } : {}), ...extra };
}
const TAG = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
function tagged(t: string): string { return `${t}\n${TAG}`; }

test("I1 identity: entry == exit passes", () => {
  const a = [mk("user", "text", "hello"), mk("assistant", "text", "hi there")];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true);
  assert.equal(v.matched, 2);
});

test("I1 render tags added on exit are normalized away (no false positive)", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi there")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", tagged("hi there"))];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 tail append (this turn's new message) is allowed", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi")];
  const exit = [...entry, mk("user", "text", "follow-up question")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 trailing chain-checkpoint carrier is exempt", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "hi")];
  const exit = [...entry, mk("user", "text", "\x3cbili-chain \"abc\"/>\x3c/bili-chain>")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 policy reasoning drop is exempt", () => {
  const entry = [mk("user", "text", "q"), mk("assistant", "reasoning", "thinking..."), mk("assistant", "text", "a")];
  const exit = [mk("user", "text", "q"), mk("assistant", "text", "a")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 deterministic crush transform of a tool-result is exempt", () => {
  const entry = [mk("user", "text", "run"), mk("tool", "tool-result", "[{\"a\":1},{\"a\":2},{\"a\":3}]"), mk("assistant", "text", "done")];
  const crushed = JSON.stringify({ __acp_crush: "rows", rows: 3, const: { a: 1 }, items: [] });
  const exit = [mk("user", "text", "run"), mk("tool", "tool-result", crushed), mk("assistant", "text", "done")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("I1 tool-call id re-mint with identical content does not false-positive (#2821)", () => {
  const entry = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_1" })];
  const exit = [mk("assistant", "tool-call", "{\"cmd\":\"ls\"}", { toolName: "bash", toolCallId: "call_REMINTED" })];
  assert.equal(judgeInboundOutbound(entry, exit).ok, true);
});

test("NEG mid-history rewrite (stable assistant text altered) -> red", () => {
  const entry = [mk("user", "text", "hello"), mk("assistant", "text", "the answer is 42"), mk("user", "text", "thanks")];
  const exit = [mk("user", "text", "hello"), mk("assistant", "text", "the answer is 43"), mk("user", "text", "thanks")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-rewrite"));
});

test("NEG mid-history drop (stable message vanished, no fold) -> red", () => {
  const entry = [mk("user", "text", "one"), mk("assistant", "text", "two"), mk("user", "text", "three")];
  const exit = [mk("user", "text", "one"), mk("user", "text", "three")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-history-drop" || x.kind === "mid-history-rewrite"));
});

test("NEG reorder (stable messages out of order) -> red", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B"), mk("user", "text", "C")];
  const exit = [mk("user", "text", "A"), mk("user", "text", "C"), mk("assistant", "text", "B")];
  assert.equal(judgeInboundOutbound(entry, exit).ok, false);
});

test("NEG mid-insertion (non-carrier element lands before a stable match) -> red", () => {
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [mk("user", "text", "A"), mk("system", "text", "INJECTED MIDDLE"), mk("assistant", "text", "B")];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === "mid-insertion"));
});

test("I2 fold: frozen prefix intact, folded region replaced by summary carrier -> green", () => {
  const entry = [
    mk("user", "text", "preamble"),
    mk("assistant", "text", "old-1"),
    mk("user", "text", "old-2"),
    mk("assistant", "text", "old-3"),
  ];
  const exit = [
    mk("user", "text", "preamble"),
    mk("user", "text", "[Compressed conversation section]\nold stuff summarized", { summaryOfBlockId: "b5" }),
    mk("user", "text", "new question"),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true);
  assert.equal(v.folded, true);
  assert.equal(v.foldStart, 1);
});

test("I2 fold boundary drift: frozen-prefix element altered before the summary -> red", () => {
  const entry = [
    mk("user", "text", "preamble"),
    mk("assistant", "text", "old-1"),
    mk("user", "text", "old-2"),
  ];
  const exit = [
    mk("user", "text", "PREAMBLE MUTATED"),
    mk("user", "text", "[Compressed conversation section]", { summaryOfBlockId: "b5" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, false);
  assert.equal(v.folded, true);
});

test("I1 stateful-host echo: inbound acp_summary carrier matches its twin (entry==exit) -> green", () => {
  const a = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nold stuff", { summaryOfBlockId: "b3" }),
    mk("assistant", "text", "still here"),
  ];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I1 stateful-host echo: inbound chain-checkpoint carrier matches its twin -> green", () => {
  const a = [
    mk("user", "text", "hello"),
    mk("user", "text", "\x3cbili-chain \"abc\"/>\x3c/bili-chain>"),
    mk("assistant", "text", "hi"),
  ];
  const v = judgeInboundOutbound(a, a);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("I1 five consecutive injected carriers before the next stable match stay exempt (gap counts non-carriers)", () => {
  const ck = (t: string) => mk("user", "text", t);
  const entry = [mk("user", "text", "A"), mk("assistant", "text", "B")];
  const exit = [
    entry[0]!,
    ck("\x3cbili-chain \"c1\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c2\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c3\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c4\"/>\x3c/bili-chain>"),
    ck("\x3cbili-chain \"c5\"/>\x3c/bili-chain>"),
    entry[1]!,
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("carrier text drift in place stays green: inbound elements at/after the fold point live in bili's owned render region (host edits to persisted summaries are normalized by the canonical re-render, so they are not attributable to the host)", () => {
  const entry = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nold stuff", { summaryOfBlockId: "b3" }),
  ];
  const exit = [
    mk("user", "text", "hello"),
    mk("user", "text", "[Compressed conversation section]\nDIFFERENT CONTENT", { summaryOfBlockId: "b3" }),
  ];
  const v = judgeInboundOutbound(entry, exit);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.folded, true);
  assert.equal(v.matched, 1);
});
