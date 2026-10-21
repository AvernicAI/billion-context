import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreToResponses,
  patchResponsesInput,
  responsesToCore,
  type ResponseInputItem,
} from "../src/wire/responses.js";

const IMG_A = "data:image/png;base64,AAAA";
const IMG_B = "data:image/png;base64,BBBB";

type MessageItem = {
  type: "message";
  role: string;
  content: unknown;
  [key: string]: unknown;
};

const userText = (content: string): MessageItem => ({
  type: "message",
  role: "user",
  content,
});

const multipart = (extra?: Record<string, unknown>): MessageItem => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: "look at this" },
    { type: "input_image", image_url: IMG_A },
  ],
  ...extra,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("#4150 issue matrix: adjacent plain-text + multi-part rebuilds verbatim", () => {
  const shapes: ResponseInputItem[][] = [
    // the reported bug: text BEFORE multipart dropped the image
    [userText("plain question"), multipart()],
    [userText("one"), userText("two"), multipart()],
    // these two already survived pre-fix — must stay verbatim
    [multipart(), userText("after")],
    [multipart()],
    // adjacent plain-text items used to merge into one array item
    [userText("one"), userText("two")],
  ];
  for (const input of shapes) {
    const proj = responsesToCore({ model: "m", input });
    const out = coreToResponses(proj.msgs);
    assert.deepEqual(
      out,
      clone(input),
      `shape ${JSON.stringify(input)} not rebuilt verbatim`,
    );
  }
});

test("#4150: each image resolves from its OWN item (no cross-item assignment)", () => {
  const input: ResponseInputItem[] = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: IMG_A }],
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "second" },
        { type: "input_image", image_url: IMG_B },
      ],
    },
  ];
  const proj = responsesToCore({ model: "m", input });
  assert.deepEqual(coreToResponses(proj.msgs), clone(input));
  // fold item 0 entirely: item 1 keeps its own image, not item 0's
  const survivors = proj.msgs.filter((m) => m.wireIndex !== 0);
  const out = coreToResponses(survivors);
  assert.deepEqual(out, [clone(input[1])]);
  assert.ok(!JSON.stringify(out).includes(IMG_A), "foreign image resurrected");
});

test("#4150: merged image-only item after a text item stays verbatim (no marker leak)", () => {
  const input: ResponseInputItem[] = [
    userText("q"),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: IMG_A }],
    },
  ];
  const proj = responsesToCore({ model: "m", input });
  const out = coreToResponses(proj.msgs);
  assert.deepEqual(out, clone(input));
  assert.ok(
    !JSON.stringify(out).includes("[image]"),
    "canonical marker leaked into the wire",
  );
});

test("#4150: partial folds rebuild per-item views, never stale bytes", () => {
  const input: ResponseInputItem[] = [
    userText("lead"),
    multipart({ status: "in_progress" }),
    userText("trail"),
  ];
  const proj = responsesToCore({ model: "m", input });
  const slot = proj.layout[1];
  const [textCoreId, imageCoreId] = slot.coreIds ?? [];
  assert.ok(textCoreId && imageCoreId, "multi-part item must split (#3642)");
  const textCore = proj.msgs.find((m) => m.id === textCoreId);
  assert.ok(textCore);

  // fold the TEXT part: the image survives, resolved from its own item
  let out = coreToResponses(proj.msgs.filter((m) => m.id !== textCoreId));
  assert.deepEqual(out, [
    clone(input[0]),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: IMG_A }],
    },
    clone(input[2]),
  ]);

  // fold the IMAGE part: the surviving text core renders exactly as it does
  // alone — a core's rendering must not depend on neighbouring runs
  out = coreToResponses(proj.msgs.filter((m) => m.id !== imageCoreId));
  assert.deepEqual(out, [
    clone(input[0]),
    { type: "message", role: "user", content: "look at this" },
    clone(input[2]),
  ]);
  assert.deepEqual(coreToResponses([textCore]), [out[1]]);

  // fold BOTH parts: the item drops entirely, neighbours intact
  out = coreToResponses(
    proj.msgs.filter((m) => m.id !== textCoreId && m.id !== imageCoreId),
  );
  assert.deepEqual(out, [clone(input[0]), clone(input[2])]);

  // rewritten text core (ref-tag/render injection): the filtered view carries
  // the NEW bytes plus the image — never the stale verbatim item
  const rewritten = proj.msgs.map((m) =>
    m.id === textCoreId ? { ...m, text: "look at this (ref)" } : m,
  );
  out = coreToResponses(rewritten);
  assert.deepEqual(out, [
    clone(input[0]),
    {
      type: "message",
      role: "user",
      status: "in_progress",
      content: [
        { type: "input_text", text: "look at this (ref)" },
        { type: "input_image", image_url: IMG_A },
      ],
    },
    clone(input[2]),
  ]);
});

test("#4150 obs 2: assistant array-content item round-trips verbatim", () => {
  const input: ResponseInputItem[] = [
    { type: "message", role: "user", content: "weather?" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "18C rainy" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It is 18C and rainy." }],
    },
  ];
  const proj = responsesToCore({ model: "m", input });
  const out = coreToResponses(proj.msgs);
  assert.deepEqual(out, clone(input));
});

test("#4150 obs 2: rewritten assistant text keeps the synthesized string form", () => {
  const input: ResponseInputItem[] = [
    { type: "message", role: "user", content: "weather?" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "18C rainy" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It is 18C and rainy." }],
    },
  ];
  const proj = responsesToCore({ model: "m", input });
  const assistantCore = proj.msgs.find(
    (m) => m.role === "assistant" && m.contentType === "text",
  );
  assert.ok(assistantCore);
  const edited = proj.msgs.map((m) =>
    m.id === assistantCore!.id ? { ...m, text: `${m.text} (edited)` } : m,
  );
  const out = coreToResponses(edited);
  const last = out[out.length - 1] as { content: unknown };
  assert.equal(last.content, "It is 18C and rainy. (edited)");
});

test("#4150: full state — patch lane and full-rebuild lane agree byte-for-byte", () => {
  const input: ResponseInputItem[] = [
    { role: "user", content: "first question" } as unknown as ResponseInputItem,
    multipart(),
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "18C rainy" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It is 18C and rainy." }],
    },
    userText("thanks"),
  ];
  const proj = responsesToCore({ model: "m", input });
  const patched = patchResponsesInput(proj, proj.msgs) as ResponseInputItem[];
  const rebuilt = coreToResponses(proj.msgs);
  assert.deepEqual(patched, rebuilt, "lanes diverge on the untouched state");
});
