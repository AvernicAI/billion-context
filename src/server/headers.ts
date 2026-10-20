/** Session ids are client-provided verbatim (#286) — sanitize before using
 *  one in a debug-dump FILENAME so a hostile value cannot escape the dir. */
export function safeSessionId(id: string | undefined): string {
    return (id ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** 400 body for requests carrying no client-provided conversation identity
 *  AND no usable replayed history. Anonymous requests with a real message
 *  history are resolved by prefix affinity (#309); only degenerate probes
 *  (empty / system-only, or a fingerprint-sized history) fail explicitly. */
export const NO_IDENTITY_MESSAGE =
    "Missing stable conversation identity. Send one of the headers: x-session-id, x-session-affinity, x-acp-session, x-opencode-session-id, x-opencode-session, x-claude-code-session-id, session-id — or body session_id / prompt_cache_key (responses/openai/anthropic). Requests replaying a conversation history are matched by content prefix affinity (#309); this one carries no usable history signal.";

export const UPSTREAM_HOP_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    // RFC 7230 §6.1 hop-by-hop headers. proxy-authorization in particular
    // carries client→proxy credentials that must never reach the model
    // endpoint. (#80)
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    // #1117: bili-internal passthrough marker (native fetch patch → proxy);
    // never meaningful to a real upstream.
    "x-bili-passthrough",
    "te",
    "trailer",
    "upgrade",
]);

/** #3884 Step3+ (owner-approved 2026-10-20): per-request DECLARATION from a
 * plugin host of which bili tools it actually exposed for THIS request
 * (comma-separated tool names; present-but-empty = "exposes none"). The
 * registration state lives only in the host, so where hosts adopt this the
 * declaration replaces wire-shape name-guessing (#3600/#3884 fragility
 * class). Absent header = undeclared host — consumers fall back to the
 * legacy inference bit-for-bit; an absent header must never change behavior
 * (owner constraint, #3884 thread). Precedence rules live in
 * resolveLaneDecisions (#3417 lane-decisions). */
export const EXPOSED_TOOLS_HEADER = "x-bili-plugin-exposed-tools";

/** Parse the declaration: undefined header → null (absent); any other value
 * → trimmed, lowercased names ([] when nothing was declared). */
export function parseExposedToolsHeader(value: string | string[] | undefined): string[] | null {
    if (value === undefined) return null;
    const raw = Array.isArray(value) ? value.join(",") : value;
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

// content-encoding is end-to-end (RFC 9110 §7.2), NOT hop-by-hop — but the two
// directions need opposite treatment. RESPONSES: Node's fetch transparently
// decodes compressed bodies, so the upstream's encoding marker must not reach
// the client (it would try to decompress already-plain bytes) — stripped at
// the response-forward sites below. REQUESTS: the marker describes exactly the
// bytes bili forwards — decoded/rebuilt bodies have it dropped at decode time
// (handle()), while verbatim passthrough bodies (#619 undecodable encodings,
// unknown paths) MUST keep it so upstream applies its own decode; forwarding
// encoded request bytes without the marker made upstream reject undeclared
// binary bodies (#677).
export const RESPONSE_ONLY_STRIP_HEADERS = new Set(["content-encoding"]);

// RFC 7230 §6.1: the Connection header names additional hop-by-hop headers
// that must be stripped per-message. Returns their lowercased names.
export function connectionNamedHeaders(conn: string | string[] | undefined): Set<string> {
    const out = new Set<string>();
    if (!conn) return out;
    for (const part of Array.isArray(conn) ? conn : [conn]) {
        for (const name of part.split(",")) {
            const t = name.trim().toLowerCase();
            if (t) out.add(t);
        }
    }
    return out;
}

/** Codex advertises its own server-side context compaction via this beta
 *  feature. It conflicts with bili's client-side compress (bili IS the
 *  compression layer) and third-party aggregators reject it with
 *  "invalid range / ref not found". Strip it so bili's compress is the sole
 *  mechanism. Used by BOTH outbound derivations — the HTTP forward path
 *  (buildForwardTarget) and the WS lane's final egress
 *  (finalizeResponsesWsUpstreamHeaders, #3073) — so every outbound Responses
 *  request carries the same surface regardless of which internal code path
 *  produced it. */
export function stripRemoteCompactionBetaFeature(headers: Record<string, string>): void {
    const betaKey = Object.keys(headers).find((h) => h.toLowerCase() === "x-codex-beta-features");
    if (!betaKey) return;
    const kept = headers[betaKey]
        .split(",")
        .map((s) => s.trim())
        .filter((f) => f && f !== "remote_compaction_v2");
    if (kept.length > 0) headers[betaKey] = kept.join(",");
    else delete headers[betaKey];
}

export function buildForwardHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
        out[k] = v;
    }
    out["content-type"] = "application/json";
    return out;
}
