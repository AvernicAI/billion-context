/**
 * #3417 lane-decisions: the single source of truth for per-lane gating
 * decisions ("are the tools reachable? is the compress surface on? may the
 * nudge ride this turn?").
 *
 * History: the same gating expressions were copied into all four wire
 * adapters and drifted (#3293 prompt/tool gate drift, #3401 lane-name
 * reachability misjudged 4x). This module is the extraction point:
 *
 *   ① HostProfile — per-agent DECLARED defaults (the registry is the only
 *      place a lane name is compared; identity lives here, properties flow out)
 *   ② WireObservation — per-request OBSERVED facts (which bili tools the
 *      request actually declares, per wire shape). Environment-varying
 *      properties are OBSERVED, not name-derived: the same dsh agent name has
 *      profiles where the agent sees bili's tools and profiles where it
 *      cannot (#3401) — so the observation layer may override the profile
 *      default.
 *   ③ LaneDecisions — the one resolver: consumers (the four prepares, the
 *      loop, plugin paths) read the frozen decision object and never
 *      re-derive a gate from `pluginAgent === "..."` themselves.
 *
 * Kernel purity: host-side only, imports nothing from kernel internals.
 */

import { biliToolsDeclaredOnWire } from "../session-self-heal.js";

type LaneProtocol = "anthropic" | "openai" | "google" | "responses";

// ① HostProfile registry — the ONLY place lane names are compared (#3417).
// Properties here are per-AGENT constants. Anything that can vary per
// environment/profile/request belongs in ② WireObservation instead.
interface HostProfile {
    readonly identity: string;
    /**
     * Declared default: does this host register bili's ACP tools host-scope
     * (invisible to the model) by default? dsh does (#3177: 0/3939 preset
     * requests carried the tools); pi/omp/opencode expose them visibly. The
     * observation layer overrides this when the request itself declares the
     * tools (#3401: some dsh profiles DO surface them).
     */
    readonly toolsHostScopedByDefault: boolean;
    /**
     * Declared: this host's upstream requests need the billing block carried
     * from the client request (#2189, subscription-OAuth lanes 429 without it).
     */
    readonly wantsBillingBlock: boolean;
    /**
     * Declared: this host compacts histories CLIENT-SIDE and resends the
     * compacted form (dsh native compaction, #2432) — the four prepares run
     * the dual-signal compact-guard rebase for such hosts. Registry property,
     * not a name comparison in each adapter (#3417).
     */
    readonly compactsClientSide: boolean;
}

const PROFILES: Record<string, HostProfile> = {
    dsh: { identity: "dsh", toolsHostScopedByDefault: true, wantsBillingBlock: true, compactsClientSide: true },
    pi: { identity: "pi", toolsHostScopedByDefault: false, wantsBillingBlock: false, compactsClientSide: false },
    omp: { identity: "omp", toolsHostScopedByDefault: false, wantsBillingBlock: false, compactsClientSide: false },
    opencode: { identity: "opencode", toolsHostScopedByDefault: false, wantsBillingBlock: false, compactsClientSide: false },
};

const ANONYMOUS: HostProfile = { identity: "", toolsHostScopedByDefault: false, wantsBillingBlock: false, compactsClientSide: false };

/** Resolve the declared profile for a plugin agent header value. Trimmed
 * exact match — the historical shape of every pluginAgent comparison. */
function resolveHostProfile(pluginAgent: string | undefined | null): HostProfile {
    const key = (pluginAgent ?? "").trim();
    return PROFILES[key] ?? { ...ANONYMOUS, identity: key };
}

// ② WireObservation — facts read off THIS request body.
interface WireObservation {
    /** The specific bili tools the request declares (named-tool precision —
     * the nudge advertises `compress`, so THAT name decides reachability,
     * #3403 review follow-up). */
    readonly declaredTools: ReadonlySet<string>;
}

function observeDeclaredTools(parsed: unknown, protocol: LaneProtocol): ReadonlySet<string> {
    const out = new Set<string>();
    if (parsed === null || typeof parsed !== "object") return out;
    const tools = (parsed as Record<string, unknown>)["tools"];
    if (!Array.isArray(tools)) return out;
    for (const t of tools) {
        if (t === null || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec["name"] === "string" && biliToolsDeclaredOnWire({ tools: [t] }, protocol, rec["name"])) out.add(rec["name"]);
        const fn = rec["function"];
        if (fn !== null && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string") {
            const n = (fn as Record<string, unknown>)["name"] as string;
            if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
        }
        const decls = rec["functionDeclarations"];
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>)["name"] === "string") {
                    const n = (d as Record<string, unknown>)["name"] as string;
                    if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
                }
            }
        }
    }
    return out;
}

// ③ LaneDecisions — the frozen decision object every gate reads.
interface LaneDecisions {
    /** The resolved profile (identity + declared defaults). */
    readonly profile: HostProfile;
    /** Observed per-request facts. */
    readonly observed: WireObservation;
    /** Is the tool the nudge/standing prompt advertises (`compress`) actually
     * declared on this request's wire? Environment truth — overrides the
     * profile default when the tools ARE visible (#3401). */
    readonly toolsReachable: { readonly compress: boolean };
    /**
     * Should the model-side compress surface (standing system prompt + nudge)
     * be ON for this request? Plugin lanes whose agent cannot reach the
     * compress tool must not advertise it ("unknown tool" loops, #3177/#3401).
     * Suppression here also keeps the developer/system slot append-stable.
     *
     * Cache-sensitivity note (#3403 review): the flag is recomputed per
     * request from `parsed.tools`; it stays prefix-cache stable as long as the
     * host's tool table is per-session stable (a mid-session flip breaks the
     * cache prefix once — observed only on hosts that violate that premise).
     */
    readonly compressSurfaceOn: boolean;
    /** Legacy alias kept for the four prepares' migration: TRUE when the
     * surface must be OFF (the old `dshCompressSurfaceOff` variable). */
    readonly compressSurfaceOff: boolean;
}

interface LaneDecisionInput {
    readonly protocol: LaneProtocol;
    readonly pluginMode: boolean;
    readonly pluginAgent: string | undefined;
    readonly parsed: unknown;
    /** injectTool config (`shouldInject`) — the config-level master switch. */
    readonly shouldInject: boolean;
}

export function resolveLaneDecisions(input: LaneDecisionInput): LaneDecisions {
    const profile = resolveHostProfile(input.pluginAgent);
    const declaredTools = observeDeclaredTools(input.parsed, input.protocol);
    // Reachability truth: in PROXY mode bili itself injects the tool
    // definitions into the outbound body, so the surface is structurally on.
    // In PLUGIN mode the host owns the tool table: reach when this request
    // declares `compress` (observed — some dsh profiles DO surface it, #3401)
    // or the host exposes bili tools to the model by design (profile default,
    // #3177).
    const compressReachable = !input.pluginMode
        || declaredTools.has("compress")
        || !profile.toolsHostScopedByDefault;
    const compressSurfaceOn = input.shouldInject && compressReachable;
    return Object.freeze({
        profile,
        observed: Object.freeze({ declaredTools }),
        toolsReachable: Object.freeze({ compress: compressReachable }),
        compressSurfaceOn,
        compressSurfaceOff: !compressSurfaceOn,
    });
}
