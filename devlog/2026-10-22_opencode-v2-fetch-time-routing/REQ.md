# REQ: opencode V2 lanes — stop rewriting the shared http.request payload; route at fetch time

Issue: https://github.com/ranxianglei/billion-context/issues/4276

## Problem

Both opencode V2 entries (native `src/agent/opencode-native.ts` and launcher
`src/agent/opencode.ts`) rewrote `event.request.url` IN PLACE inside their
unscoped `http.request` hook (`replaceRequestTarget(e, \`${origin}/bili/${url}\`)`).
opencode dispatches ONE mutable event object to every matching hook — including
provider-ID-scoped hooks from other plugins and opencode's own built-in
provider hooks (verified against the opencode 2.x binary: the host sends the
POST-HOOK request through a call-time-resolved `globalThis.fetch`). Provider
plugins that pattern-match or validate the upstream URL therefore saw the
proxied URL:

- Kiro (`@servoy/opencode-kiro-auth`): response-hook gate
  `q.*.amazonaws.com|runtime.*.kiro.dev` failed → AWS bridge never engaged →
  raw OpenAI-shaped POST hit AWS → non-SSE 200 → ~10 retries → silent EMPTY
  assistant message.
- Antigravity (`@cortexkit/opencode-antigravity-auth`): request hook requires
  origin === `generativelanguage.googleapis.com`, threw on the proxied URL.

Both worked with `BILLION_CONTEXT_PLUGIN=0`. The same /bili/ rewrite shape
existed in every native lane, but only opencode hands the mutated payload to
provider-scoped hooks that validate URLs.

Second half of the issue: `providers.<url>.direct` (documented as ACTIVE client
exemption) was implemented only in the ZCode store-rewriting lane — the
opencode lanes had no exemption at all.

## Root cause

The hook treated `event.request` as bili-private scratch space. It is not: it
is the shared wire payload every later hook reads and the exact Request the
host eventually fetches. Rewriting it leaked the proxy URL into third-party
plugin logic. The repo already had the correct mechanism — the shared native
fetch intercept chain (`installNativeFetchIntercept`) rewrites model-API URLs
to `<origin>/bili/<url>` AT FETCH TIME, leaving every hook-visible payload
untouched. The V1 path used it; the V2 setup path never installed it (the
`state.prepareDirectSend`/`state.onResponse` wirings in opencode-native.ts were
dead code in V2 processes as a result).

## Fix

Part A (root cause): the V2 routes stop mutating `e.request.url` — they keep
owning discovery/degrade (resolveLive → s.proxyBase, #1958 conflict warning,
#3308/#3654 oversize local refusal) and nothing else. Both entries' `setup()`
installs the shared chain with their own state (same guards as the V1 install:
kill switch off ⇒ no install; NODE_TEST_CONTEXT ⇒ no install). The WS
handshake hook builds its tunnel itself now (raw model URL branch, byte-
identical output to the old rewrite+replace pipeline for formerly-working
shapes; already-routed URLs keep the old conversion verbatim).

Part B (documented exemption): `providers.<url>.direct` honored in the
opencode lanes — the hook marks matching requests (`biliDirect`, no stamping,
no incremental swap, no ws tunneling) and the shared chain sends them direct
before any proxy resolution (once-per-prefix log).

## Acceptance criteria

1. After the hook, `e.request` is the SAME object with the ORIGINAL url for
   every later hook; the proxied URL appears only at fetch time.
   (`tests/issue4276-opencode-v2-hook-payload.test.ts`)
2. A provider plugin rewriting the request to a non-model endpoint (Antigravity
   pool shape) passes through unproxied, byte-identical.
3. `providers.<url>.direct` upstreams are sent direct, unstamped, unswapped.
4. `setup()` installs the chain by default and stays fully inert under
   `BILLION_CONTEXT_PLUGIN=0` (child-process probe).
5. Launcher lane lifecycle unchanged end-to-end at the wire level: steady-state
   routing, death-respawn re-targeting (#1135), failed-respawn direct send —
   now observed through real fetches against recording servers
   (`tests/opencode-launcher.test.ts`).
6. All pre-existing suites green: opencode-native (flipped contract assertions),
   opencode-v2, responses-websocket (WS tunnel parity), native-intercept(+
   selfheal), opencode-incremental, zcode-json-edit.

## Constraints / behavior change disclosure

- Provider-scoped plugins and opencode built-in provider hooks NOW SEE THE
  ORIGINAL UPSTREAM URL (the bug fix itself). Plugins that relied on seeing the
  proxied URL (none known; would be a bug per #4276's expected behavior) break.
- Signed-body model requests (APIG scheme) in the opencode V2 lane are now
  locally refused (chain signed arm, #1884 owner ruling) instead of riding
  unsigned through bili into an upstream 401.
- #3304 `prepareDirectSend` body restore + #3248 incremental acks
  (`onResponse`) activate in V2 processes — previously dead code, now live on
  the degrade/fallback paths only.
- Launcher dead-origin handling moves from preemptive unwrap in the hook to the
  chain's recover→retry→give-up-direct (may respawn where the old code gave up
  immediately — strictly more recovery).
- Known limitation (documented in PR): a V1 config-hook-rewritten baseURL
  (proxy already baked by another hook earlier in the chain) bypasses the
  `direct` exemption match in the opencode lane — same class as the existing
  ZCode store-lane boundary; not a regression (previously no exemption existed
  there at all).
