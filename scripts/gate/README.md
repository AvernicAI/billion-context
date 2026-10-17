# Plugin Lanes (Lane P) — real host CLIs × real model

(中文版见 [README.zh-CN.md](./README.zh-CN.md))

These lanes drive billion-context's two activation paths with **real host CLIs**
(dsh / pi / codex / claude-code / opencode) and a **real model**, closing the
#3416 blind spot: the old gate only exercised proxy mode, so regressions like
#3401 ("plugin session has the tools on the wire, but the prompts were
silently switched off") sailed through the gate all green.

## Two activation paths

| Path | Hosts | Mechanism |
|------|-------|-----------|
| native | dsh, pi, opencode (v1/v2) | a thin plugin / native extension intercepts the host's fetch, stamps the `x-bili-plugin` header, and **self-spawns the proxy (port 0)** — never start a proxy externally |
| prefix | codex, claude | the host config points at the bili proxy's `/bili/` URL prefix (proxy mode); this script starts that proxy manually |

## What gets asserted (the wire is the source of truth)

`upstream-recorder.mjs` sits between bili and the real model and records every
request body / response as JSONL; every assertion is made on what the model
actually received — internal logs can be fooled by suppression-class bugs
(#3401), the wire cannot:

- upstream saw traffic (requests really reached the model)
- ACP tools (compress / acp_status / …) really appear in the wire's tools
- plugin claim: session file `payload.metadata.pluginAgent == "<agent>"`
- **hard nudge assertion**: the nudge text must appear on the wire (a "log
  shows INJECT" is not accepted — the injection can land in an in-band error
  response that is never forwarded; that is a fake green)
- fold fired (`acp-compress-obs] shrink N%`)
- codeword recall before/after the fold (corpus of 40 sections; S07 early /
  S40 last CODEWORDS markers)
- no `unknown tool` loops

## Lane flow

1. **t1 @ big window**: read the corpus, echo the S40 codeword (fold must NOT
   fire in this phase)
2. **window shrink**: rewrite the **host's own** model config (dsh cordis /
   pi models.json / opencode.json limit / codex config.toml / claude model
   alias) — the effective window reaches bili via the
   `x-bili-plugin-context-window` header; native proxies keep a sticky zone
   port that re-reads it every request, no proxy restart needed
3. **t2 @ mid window**: S07 recall (intact context) + the hard nudge-on-wire
   assertion; the mid window self-calibrates from actual t1/t2 usage into the
   75–95% pressure band
4. **t3 @ small window**: "DONE" — the preflight fold must fire
5. **t4**: S07 recall after the fold

## How to run

Prerequisites: node ≥ 20, the host CLIs installed (dsh / pi / codex / claude /
opencode), one OpenAI-compatible real-model endpoint, and the candidate as an
`npm pack` tarball.

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=http://127.0.0.1:8199 \
MODEL1_MODEL=<model-id> \
GATE_AGENTS=dsh,pi,codex,opencode,claude \
node scripts/gate/plugin-lanes.mjs
```

- `GATE_AGENTS` selects a subset of lanes; `GATE_TURN_TIMEOUT_MS` (default
  300000), `GATE_BIG/MID/SMALL_WINDOW`, and `PLUGIN_LANES_WORK` (artifact
  dir, default `./plugin-lanes/`) are tunable
- per-lane artifacts: `<work>/<agent>/turn-t{1..4}.txt`, `upstream.jsonl`,
  `bili.log`
- the opencode2 lane is not in the default set: transport websocket passes
  Responses-WS straight through (HTTP-only upstreams die on the handshake),
  and transport http depends on upstream `/v1/responses` quality — see
  #3461; the lane still asserts tools / claim / traffic
- **red/green contrast** (#3416 acceptance): a master build (carrying the
  #3401 bug) fails this lane with nudge wire MISSING / log:ARMED-SUPPRESSED;
  a build containing #3403 is all green

## Relation to the out-of-repo harness

The lane scripts live in this repo (versioned with the code under test); the
containerized wrapper (Dockerfile, verdaccio, custom image, model endpoints)
stays in its own gate-harness repo / machine and does not enter this repo.
Remote CI does not run by default: `.github/workflows/ci-gate-plugins.yml` is
workflow_dispatch-only, with no push/PR triggers.
