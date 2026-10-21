import { markDirty, type Session } from "./session.js";

// #3846/#4079: local-413 refusal memory shared by the preflight fail-fast paths
// (server.ts) and the send-side window gate (server/relay.ts). A refusal is a
// verdict on (origin, model, window): an equal-or-wider recorded verdict covers
// the scope, so no forward-once escape may re-bet on an estimator already shown
// wrong there. Both sides must be known — evidence-permitlist discipline: an
// unprovenanced refusal proves nothing about an unprovenanced request.
interface LocalRefusalRecord {
    origin: string;
    model: string;
    window: number;
    at: number;
}

const LOCAL_REFUSAL_MAX_RECORDS = 16;

function readLocalRefusals(metadata: Record<string, unknown>): LocalRefusalRecord[] {
    const raw = metadata.localRefusals;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is LocalRefusalRecord =>
        !!r && typeof r === "object"
        && typeof (r as LocalRefusalRecord).origin === "string"
        && typeof (r as LocalRefusalRecord).model === "string"
        && typeof (r as LocalRefusalRecord).window === "number",
    );
}

/** Record a local 413 refusal for (origin, model, window). A wider refusal in
 *  the same scope already dominates (it covers every tighter window); a
 *  narrower one replaces it so the record tracks the widest verdict seen. */
export function noteLocalRefusal(session: Session, origin: string | undefined, model: string | undefined, window: number): void {
    if (!origin || !model || !Number.isFinite(window) || window <= 0) return;
    const records = readLocalRefusals(session.metadata);
    const existing = records.find((r) => r.origin === origin && r.model === model);
    if (existing !== undefined && existing.window >= window) return;
    session.metadata.localRefusals = [
        ...records.filter((r) => !(r.origin === origin && r.model === model)),
        { origin, model, window: Math.floor(window), at: Date.now() },
    ].slice(-LOCAL_REFUSAL_MAX_RECORDS);
    markDirty(session);
}

/** True when this session was locally refused (413) by the SAME origin+model
 *  at an equal or WIDER window — the current request may then not reopen any
 *  forward-once escape hatch (#3846). */
export function localRefusalCovers(metadata: Record<string, unknown>, origin: string | undefined, model: string | undefined, window: number): boolean {
    if (!origin || !model) return false;
    return readLocalRefusals(metadata).some((r) => r.origin === origin && r.model === model && r.window >= window);
}
