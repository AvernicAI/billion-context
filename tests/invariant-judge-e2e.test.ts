// #3842 — I1/I2 judge on REAL traffic: host-behavior generator + defect fixtures.
// The judge is armed on EVERY request through the actual proxy path (handle.ts).
// Two end-to-end claims, deterministic (fixed seed, single wire):
//   (A) ZERO false positives across a seeded stream of legitimate host behaviors —
//       append / edit-prior / retry / model-switch / restart — including HOST-side
//       history rewrites, which the judge attributes to the client (entry==exit =>
//       green), never to bili;
//   (B) the wired path FIRES on each injected defect shape (rewrite / reorder /
//       drop / mid-insertion) — proof the attribution layer has teeth live;
//   (C) a REAL fold through preflight (tiny window) stays green end-to-end —
//       including the fold-creating request, which is judged on the FINAL body
//       (post-preflight) — and post-fold prefix corruption fires (I2 teeth live).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.ts";

const root = mkdtempSync(join(tmpdir(), "bili-invariant-judge-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
process.env.NODE_ENV = "test";

// Deterministic PRNG so CI runs are reproducible (tests must not rely on luck).
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Msg = { role: "user" | "assistant"; content: string };

async function harness(opts: { context?: number } = {}) {
  const ctx = opts.context ?? 400000;
  _resetSessionsForTest();
  _resetPluginStateForTest();
  resetToolRingForTest();
  _setForTest({});
  const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
  _setStoreForTest(store);
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      // Substantive content: preflight compression asks THIS mock for summaries,
      // and the kernel rejects sub-minimum-size summaries (#3842 I2 live path).
      res.end(JSON.stringify({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: `ok ${"lorem ipsum dolor sit amet ".repeat(18)}` }, finish_reason: "stop" }] }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const addr = upstream.address();
  assert(addr && typeof addr === "object");
  const upstreamUrl = `http://127.0.0.1:${addr.port}`;
  const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "model-test": { context: ctx }, "model-alt": { context: ctx } } } }, modelContextLimit: ctx, kernelConfig: defaultConfig(ctx), compress: { injectTool: false, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
  await once(proxy, "listening");
  const paddr = proxy.address();
  assert(paddr && typeof paddr === "object");
  const origin = `http://127.0.0.1:${paddr.port}`;
  const send = async (messages: Msg[], opts: { model?: string; conv?: string } = {}) => {
    const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "fixture", "x-bili-plugin-conversation": opts.conv ?? "invariant" }, body: JSON.stringify({ model: opts.model ?? "model-test", messages, max_tokens: 1024, stream: false }) });
    assert.equal(r.status, 200, await r.text());
  };
  return { send, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("generator: zero false positives across seeded legitimate host behaviors", async () => {
  const h = await harness();
  const send = h.send;
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => { if (!v.ok) seen.push(v); });
  try {
    const rand = mulberry32(0xc0ffee);
    const pool = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const pick = (): string => pool[Math.floor(rand() * pool.length)] ?? "word";
    const history: Msg[] = [];
    const pushTurn = () => {
      const last = history[history.length - 1];
      const role: Msg["role"] = !last || last.role === "user" ? "assistant" : "user";
      history.push({ role, content: `${pick()} ${pick()} ${pick()}` });
    };
    for (let step = 0; step < 60; step++) {
      const r = rand();
      if (history.length < 2 || r < 0.45) {
        pushTurn();
      } else if (r < 0.65) {
        const i = Math.floor(rand() * history.length);
        const cur = history[i];
        if (cur) history[i] = { ...cur, content: `${pick()} EDIT` };
      } else if (r >= 0.8) {
        await send(history.map((m) => ({ ...m })), { model: rand() < 0.5 ? "model-alt" : "model-test" });
        continue;
      }
      await send(history.map((m) => ({ ...m })));
    }
    for (let k = 0; k < 3; k++) {
      await send([{ role: "user", content: `${pick()} ${pick()}` }], { conv: `restart-${k}` });
    }
    assert.equal(seen.length, 0, JSON.stringify(seen.slice(0, 3)));
  } finally {
    _setInvariantJudgeForTest(false);
    await h.close();
  }
});

test("wired path fires on each injected defect shape", async () => {
  const h = await harness();
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => { if (!v.ok) seen.push(v); });
  const base: Msg[] = [
    { role: "user", content: "one one one one" },
    { role: "assistant", content: "two two two two" },
    { role: "user", content: "three three three three" },
  ];
  const faults: Array<[string, (c: CoreMessage[]) => CoreMessage[]]> = [
    ["rewrite", (c) => c.map((m, i) => (i === 1 ? { ...m, text: `${m.text ?? ""} MUTATED` } : m))],
    ["reorder", (c) => { if (c.length < 3) return c; const a = [...c]; const t = a[1]!; a[1] = a[2]!; a[2] = t; return a; }],
    ["drop", (c) => c.filter((_, i) => i !== 1)],
    ["mid-insertion", (c) => { if (c.length < 2) return c; const a = [...c]; a.splice(1, 0, { ...(a[1] as CoreMessage), text: "INJECTED INJECTED" }); return a; }],
  ];
  try {
    await h.send(base.map((m) => ({ ...m })));
    assert.equal(seen.length, 0, JSON.stringify(seen));
    for (const [name, fn] of faults) {
      const before = seen.length;
      _setInvariantJudgeFaultForTest(fn);
      await h.send(base.map((m) => ({ ...m })));
      assert.ok(seen.length > before, `judge must fire on ${name}: ${JSON.stringify(seen.slice(before))}`);
      _setInvariantJudgeFaultForTest(null);
    }
  } finally {
    _setInvariantJudgeFaultForTest(null);
    _setInvariantJudgeForTest(false);
    await h.close();
  }
});

test("I2 live path: real preflight fold stays green; post-fold corruption fires", async () => {
  const h = await harness({ context: 8000 });
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    const history: Msg[] = [];
    let folded = false;
    for (let step = 0; step < 60 && !folded; step++) {
      const role: Msg["role"] = history.length % 2 === 0 ? "user" : "assistant";
      history.push({ role, content: `turn ${step} ${"lorem ipsum dolor sit amet ".repeat(30)}` });
      await h.send(history.map((m) => ({ ...m })));
      folded = seen.some((v) => v.folded);
    }
    assert.ok(folded, "preflight must fold within 60 turns on an 8K window");
    assert.equal(seen.filter((v) => !v.ok).length, 0, JSON.stringify(seen.filter((v) => !v.ok).slice(0, 3)));
    for (let k = 0; k < 3; k++) await h.send(history.map((m) => ({ ...m })));
    assert.equal(seen.filter((v) => !v.ok).length, 0, JSON.stringify(seen.filter((v) => !v.ok).slice(0, 3)));
    // Teeth: corrupt the frozen prefix (or plant an unexplained element when the
    // whole prefix was folded away) -> the armed live judge must fire.
    const isSum = (m: CoreMessage) => m.summaryOfBlockId !== undefined || (m.text ?? "").includes("[Compressed conversation section]") || m.id.startsWith("acp_summary");
    _setInvariantJudgeFaultForTest((c) => {
      const a = [...c];
      const s = a.findIndex(isSum);
      if (s <= 0) {
        const donor = a[a.length - 1]!;
        a.unshift({ ...donor, text: "UNEXPLAINED PLANTED ELEMENT" });
        return a;
      }
      let k = s - 1;
      while (k >= 0 && isSum(a[k]!)) k--;
      if (k < 0) {
        const donor = a[a.length - 1]!;
        a.unshift({ ...donor, text: "UNEXPLAINED PLANTED ELEMENT" });
        return a;
      }
      return a.map((m, i) => (i === k ? { ...m, text: `${m.text ?? ""} MUTATED` } : m));
    });
    const before = seen.filter((v) => !v.ok).length;
    await h.send(history.map((m) => ({ ...m })));
    assert.ok(seen.filter((v) => !v.ok).length > before, "judge must fire on post-fold corruption");
  } finally {
    _setInvariantJudgeFaultForTest(null);
    _setInvariantJudgeForTest(false);
    await h.close();
  }
});
