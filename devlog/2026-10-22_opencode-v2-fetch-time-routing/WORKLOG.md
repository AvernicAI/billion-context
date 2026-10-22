# Worklog

## 2026-10-22

- Triage: reproduced the mechanism against source + the opencode 2.x binary.
  Hook dispatch shares ONE mutable event across all matching hooks (`e.has`
  counts unscoped handlers; `trigger` spreads `{...c, request}` once); the host
  sends the post-hook request through call-time-resolved `globalThis.fetch`
  (provider SDK thunks `() => globalThis.fetch`; no node:undici). opencode's
  own built-in provider hooks (githubCopilot signs from `c.request.url`) sit in
  the same breakage class as third-party plugins.
- Part A:
  - `src/agent/opencode-native.ts`: `createNativeRoute` no longer calls
    `replaceRequestTarget`; it records `s.proxyBase` only. `setup()` installs
    `installNativeFetchIntercept(state)` (guarded: plan off / NODE_TEST_CONTEXT
    ⇒ skip) and logs once on install.
  - `src/agent/opencode.ts`: launcher route de-mutated the same way (dead-origin
    unwrap + live re-bake now happen in the chain's routed branch — recover →
    retry at `${again}${pathname}${search}`, give-up → direct send).
  - `src/agent/opencode-v2.ts`: WS handshake hook builds the tunnel itself —
    routed branch byte-identical to the old conversion, new raw-model-URL
    branch `${proxyBase}/bili/responses/${httpUrl}` (same bytes the old
    rewrite+replace pipeline produced), then `/^http/→ws`.
- Part B:
  - `src/agent/native-intercept.ts`: `directPrefixes?: readonly string[]` on
    `NativeInterceptState`, exported `directExemptMatch(url, prefixes)`
    (boundary rule identical to the ZCode lane: exact key or key+"/"),
    dispatch exemption branch before the signed arm with a once-per-prefix log
    (`noteDirectExempt`, mirrors `noteSignedDirect`).
  - Both entries populate it via `zcodeDirectPrefixes(process.env)` (existing
    config reader — no new config surface); the factory marks exempt requests
    (`e.biliDirect`) before routing/stamping/incremental.
  - `CONFIGURATION.md` `direct` section updated to list the new lane coverage.
- Tests:
  - NEW `tests/issue4276-opencode-v2-hook-payload.test.ts` — hook payload
    immutability + fetch-time routing, Antigravity pool-endpoint passthrough,
    direct exemption, install-gate directions (child-process probe in attach
    mode to stay hermetic).
  - `tests/opencode-native.test.ts` — 9 contract assertions flipped from
    "hook rewrote e.request.url" to "hook left it untouched; proxyBase carries
    the routed origin".
  - `tests/opencode-launcher.test.ts` — lifecycle tests now drive REAL fetches
    through the installed chain against recording fake proxies (+ local
    upstream recorder for the give-up-direct path; avoids any real network).
  - Unchanged-and-green: opencode-v2, responses-websocket (pins WS tunnel
    parity), native-intercept(+selfheal), opencode-incremental, zcode-json-edit,
    issue3304-incremental-direct-send.
- Verification: typecheck clean; build clean; targeted suites 186/186 green
  locally (full regression = remote CI per §7.2).
