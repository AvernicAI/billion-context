import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore } from "../src/wire/anthropic.js";
import { openaiToCore } from "../src/wire/openai.js";
import { responsesToCore } from "../src/wire/responses.js";
import { googleToCore } from "../src/wire/google.js";
import { CANONICAL_IMAGE_TEXT } from "../src/wire/identity.js";

/**
 * #3751: image core ids must be seeded by a payload fingerprint, not the
 * shared "[image]" placeholder. With the constant seed the ClusterCounter
 * suffix was the only discriminator — the Nth occurrence in THIS conversion
 * pass — so folding any earlier image re-minted every surviving image's id
 * (identity as a function of set membership). One prefix-cache break per fold
 * on the wire, one fresh wrapper blob + rc=0 orphan per image in the CAS
 * (#3748's unbounded growth).
 */

const IMG = {
  a: btoa("PIXEL-A"),
  b: btoa("PIXEL-B"),
  c: btoa("PIXEL-C"),
};

/** OpenAI body with one [text, image] user turn per tag. */
function openaiBody(tags: string[]) {
  return {
    model: "gpt-x",
    messages: tags.flatMap((t, i) => [
      {
        role: "user",
        content: [
          { type: "text", text: `q${i}` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${t}` } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: `a${i}` }] },
    ]),
  };
}

const imageIds = (tags: string[]) =>
  openaiToCore(openaiBody(tags))
    .msgs.filter((m) => m.text === CANONICAL_IMAGE_TEXT)
    .map((m) => m.id);

test("#3751: folding an earlier image never re-mints surviving image ids", () => {
  const before = imageIds(["A", "B", "C"]);
  // The fold removes the FIRST image pair; B and C survive untouched.
  const after = imageIds(["B", "C"]);
  assert.equal(before.length, 3);
  assert.equal(after.length, 2);
  assert.equal(after[0], before[1], "surviving image B keeps its id");
  assert.equal(after[1], before[2], "surviving image C keeps its id");
});

test("#3751: different pixels get different base ids (no more shared cluster)", () => {
  const ids = imageIds(["A", "B", "C"]);
  assert.equal(new Set(ids).size, 3, "three distinct images → three distinct ids, no _N suffixes");
  assert.ok(ids.every((id) => !/_\d+$/.test(id)), "no cluster suffixes when bases differ");
});

test("#3751: true duplicates of the same image still get distinct cluster ids", () => {
  const ids = imageIds(["A", "A"]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "same pixels twice → cluster suffix keeps them distinct");
  assert.ok(ids[1].endsWith("_1"), "second occurrence carries the _1 suffix");
});

test("#3751: unparseable image parts keep the legacy constant-seed id", () => {
  // url source (not base64): no imageBase64 sidecar → fallback to the
  // pre-#3751 shared seed, so these ids never move on upgrade.
  const o = openaiToCore({
    model: "gpt-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "q" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  });
  const img = o.msgs.find((m) => m.text === CANONICAL_IMAGE_TEXT)!;
  assert.equal(img.id, "h_88b5433245c4751e", "raw-only sidecar keeps the legacy shared seed id");
});

test("#3751: fingerprint is protocol-invariant — same pixels, same id across all four dialects", () => {
  const anthropic = anthropicToCore({
    model: "claude-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "q" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMG.a } },
        ],
      },
    ],
  }).msgs;
  const openai = openaiToCore({
    model: "gpt-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "q" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${IMG.a}` } },
        ],
      },
    ],
  }).msgs;
  const responses = responsesToCore({
    model: "gpt-x",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "q" },
          { type: "input_image", image_url: `data:image/png;base64,${IMG.a}` },
        ],
      },
    ],
  }).msgs;
  const google = googleToCore({
    contents: [
      {
        role: "user",
        parts: [{ text: "q" }, { inlineData: { mimeType: "image/png", data: IMG.a } }],
      },
    ],
  }).msgs;
  const pick = (msgs: { text?: string }[]) => msgs.find((m) => m.text === CANONICAL_IMAGE_TEXT)!.id;
  const ids = [pick(anthropic), pick(openai), pick(responses), pick(google)];
  assert.equal(new Set(ids).size, 1, `all four dialects mint the same id: ${ids.join(" ")}`);
});

test("#3751: responses single-part and multi-part shapes of one image mint the same id", () => {
  const dataUrl = `data:image/png;base64,${IMG.a}`;
  // Multi-part shape → per-part splittable path.
  const multi = responsesToCore({
    model: "gpt-x",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "q" },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  }).msgs;
  // Single-part shape → collapsed path (content.length > 1 is false).
  const single = responsesToCore({
    model: "gpt-x",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: dataUrl }],
      },
    ],
  }).msgs;
  const pick = (msgs: { text?: string }[]) => msgs.find((m) => m.text === CANONICAL_IMAGE_TEXT)!.id;
  assert.equal(pick(single), pick(multi), "collapsed and splittable paths mint the same id for one image");
});
