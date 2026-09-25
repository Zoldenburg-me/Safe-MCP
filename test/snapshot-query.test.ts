import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  assertQueryOnly,
  RAW_QUERY_MAX_BYTES,
  rawQuery,
  readBodyCapped,
} from "../src/platforms/snapshot.js";
import type { Config } from "../src/config.js";

const config = { SNAPSHOT_HUB_URL: "https://hub.example" } as Config;
const realFetch = globalThis.fetch;

/** A body streamed in chunks, with no Content-Length header. */
function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(encoder.encode(chunks[pulled++]));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("snapshot_query read-only guard", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("allows named, anonymous and shorthand queries", () => {
    assert.doesNotThrow(() => assertQueryOnly('query { space(id: "ens.eth") { id } }'));
    assert.doesNotThrow(() => assertQueryOnly("query Spaces($n: Int = 5) { spaces(first: $n) { id } }"));
    assert.doesNotThrow(() => assertQueryOnly("{ proposals(first: 1) { id } }"));
  });

  it("allows fragments alongside a query", () => {
    assert.doesNotThrow(() =>
      assertQueryOnly("query { space(id: \"x\") { ...F } } fragment F on Space { id }")
    );
  });

  it("does not trip on the word mutation inside fields, strings, comments or names", () => {
    assert.doesNotThrow(() => assertQueryOnly("query { mutation { id } }"));
    assert.doesNotThrow(() => assertQueryOnly('query { space(id: "mutation { x }") { id } }'));
    assert.doesNotThrow(() => assertQueryOnly("# mutation Evil { x }\nquery { a }"));
    assert.doesNotThrow(() => assertQueryOnly("query mutation { a }"));
    assert.doesNotThrow(() => assertQueryOnly('query Q($f: In = {a: "}"}) { a }'));
  });

  it("rejects mutations and subscriptions, including after a query", () => {
    assert.throws(() => assertQueryOnly("mutation { vote { id } }"), /read-only queries only.*mutation/);
    assert.throws(() => assertQueryOnly("subscription { votes { id } }"), /subscription/);
    assert.throws(
      () => assertQueryOnly("query A { a } mutation B { b }"),
      /mutation/
    );
  });

  it("rejects before any request is made", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    await assert.rejects(rawQuery(config, "mutation { x }"), /read-only/);
    assert.equal(called, false);
  });
});

describe("snapshot_query response cap", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a response whose declared length is over the cap, before reading it", async () => {
    const response = new Response("{}", {
      headers: { "content-length": String(RAW_QUERY_MAX_BYTES + 1) },
    });
    await assert.rejects(readBodyCapped(response, RAW_QUERY_MAX_BYTES), /over the 1000000-byte limit/);
  });

  it("aborts a streamed response once it passes the cap", async () => {
    const chunk = "x".repeat(400);
    let pulledChunks = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulledChunks += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    });

    await assert.rejects(
      readBodyCapped(new Response(stream), 1_000),
      /exceeded the 1000-byte limit/
    );
    // An endless body stops being read shortly after the cap, not at EOF.
    assert.ok(pulledChunks < 10);
  });

  it("returns a body under the cap intact", async () => {
    assert.equal(
      await readBodyCapped(streamedResponse(['{"data":', '{"a":1}}']), 1_000),
      '{"data":{"a":1}}'
    );
  });

  it("rawQuery returns data from a normal response", async () => {
    globalThis.fetch = (async () =>
      streamedResponse(['{"data":{"space":{"id":"ens.eth"}}}'])) as typeof fetch;

    assert.deepEqual(await rawQuery(config, 'query { space(id: "ens.eth") { id } }'), {
      space: { id: "ens.eth" },
    });
  });

  it("rawQuery surfaces the hub's GraphQL error message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "bad"' }] }))) as typeof fetch;

    await assert.rejects(rawQuery(config, "query { bad }"), /Cannot query field "bad"/);
  });

  it("rawQuery refuses an oversized hub response", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        headers: { "content-length": String(RAW_QUERY_MAX_BYTES * 5) },
      })) as typeof fetch;

    await assert.rejects(rawQuery(config, "query { votes(first: 1000) { id } }"), /byte limit/);
  });
});
