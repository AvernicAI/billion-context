import { test } from "node:test";
import assert from "node:assert/strict";
import {
    wrapStreamWithRunawayGuard,
    TEXT_RUN_THRESHOLD,
    type RunawayVerdict,
} from "../src/runaway-guard.ts";

// #3358 regression: the google lane nests tool calls under
// candidates[].content.parts[].functionCall.args. Neither "functionCall" nor "args"
// sat in EXCLUDED_BRANCHES, and google frames carry no top-level "type" for the
// event-level exemption (processParsed), so an arg value field named content/text —
// both in TEXT_LEAF_KEYS — was fed to the text-run tracker: a write-tool payload of
// 300 '=' aborted the whole answer (#1039: tool args are user intent, never counted).
// Pins BOTH directions: excluded args must NOT trip while a genuine parts[].text run
// of the same length MUST still trip (guards against over-exclusion).

const enc = new TextEncoder();

function sseFrame(json: string): Uint8Array {
    return enc.encode(`data: ${json}\n\n`);
}

function googleFrame(...parts: Record<string, unknown>[]): string {
    return JSON.stringify({
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        modelVersion: "gemini-2.5-flash",
    });
}

async function drive(parts: Uint8Array[]): Promise<{ verdicts: RunawayVerdict[]; out: Buffer }> {
    const verdicts: RunawayVerdict[] = [];
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
        },
    });
    const r = wrapStreamWithRunawayGuard(src, (v) => verdicts.push(v)).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        chunks.push(value);
    }
    return { verdicts, out: Buffer.concat(chunks) };
}

test("wrap: google functionCall.args.content with 300 '=' does NOT trip (#1039 user intent)", async () => {
    const frame = googleFrame({
        functionCall: { name: "write_file", args: { path: "/tmp/blob.txt", content: "=".repeat(300) } },
    });
    const parts = [sseFrame(frame), sseFrame(googleFrame({ text: " done." }))];
    const { verdicts, out } = await drive(parts);
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: google functionCall.args.text (second leaf-key spelling) with 300 '-' does NOT trip", async () => {
    const frame = googleFrame({
        functionCall: { name: "edit_file", args: { text: "-".repeat(300) } },
    });
    const parts = [sseFrame(frame)];
    const { verdicts, out } = await drive(parts);
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: control — google parts[].text with 250 '=' DOES trip as text-run (no over-exclusion)", async () => {
    const parts = [sseFrame(googleFrame({ text: "=".repeat(TEXT_RUN_THRESHOLD + 50) }))];
    const { verdicts } = await drive(parts);
    assert.equal(verdicts.length, 1, JSON.stringify(verdicts));
    assert.equal(verdicts[0].reason, "text-run");
    assert.equal(verdicts[0].detail?.textRunChar, "=");
});

test("wrap: mixed google frame — prose part + 300-'=' arg part coexist without tripping", async () => {
    const frame = googleFrame(
        { text: "Writing the file now." },
        { functionCall: { name: "write_file", args: { path: "/tmp/x.txt", content: "=".repeat(300) } } },
    );
    const parts = [sseFrame(frame), sseFrame(googleFrame({ text: " done." }))];
    const { verdicts, out } = await drive(parts);
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});
