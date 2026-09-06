import assert from "node:assert/strict";

import type { EnvelopeDto, SearchResult } from "../../src/protocol/index.js";
import type { PageState } from "../../src/model/paging.js";
import { appendPage, emptyPage, patchEnvelope, removeEnvelope } from "../../src/model/paging.js";

function envelope(id: number, subject: string): EnvelopeDto {
  return {
    id,
    accountId: 2,
    folderId: 12,
    subject,
    from: "someone@example.test",
    date: "2026-08-30T12:34:56.000Z",
    flags: ["unread"],
    tags: ["unread"],
    hasAttachments: false,
    size: 2048,
    bodyFetched: false,
  };
}

function page(hits: readonly EnvelopeDto[], cursor?: string, truncated = false): SearchResult {
  const base: SearchResult = { hits, truncated };
  return cursor === undefined ? base : { ...base, nextCursor: cursor };
}

function ids(state: PageState): number[] {
  return state.hits.map((hit) => hit.id);
}

describe("emptyPage", () => {
  it("starts with nothing loaded and nothing lost", () => {
    const state = emptyPage();

    assert.deepEqual(state.hits, []);
    assert.equal(state.nextCursor, undefined);
    assert.equal(state.truncated, false);
    assert.equal(state.unreachable, false);
  });
});

describe("appendPage", () => {
  it("keeps the order the daemon returned across two pages", () => {
    const first = appendPage(emptyPage(), page([envelope(1, "one"), envelope(2, "two")], "c1", true));
    const second = appendPage(first, page([envelope(3, "three"), envelope(4, "four")]));

    assert.deepEqual(ids(second), [1, 2, 3, 4]);
    assert.equal(second.nextCursor, undefined);
  });

  it("dedupes an id that appears in two pages, keeping the first-seen copy and its position", () => {
    const first = appendPage(emptyPage(), page([envelope(1, "one"), envelope(2, "two")], "c1", true));
    const second = appendPage(first, page([envelope(2, "two again"), envelope(3, "three")]));

    assert.deepEqual(ids(second), [1, 2, 3]);
    assert.equal(second.hits[1]?.subject, "two");
  });

  it("dedupes ids repeated inside a single page", () => {
    const state = appendPage(
      emptyPage(),
      page([envelope(7, "first"), envelope(7, "again"), envelope(8, "other")]),
    );

    assert.deepEqual(ids(state), [7, 8]);
    assert.equal(state.hits[0]?.subject, "first");
  });

  it("leaves the previous state untouched", () => {
    const first = appendPage(emptyPage(), page([envelope(1, "one")], "c1", true));
    appendPage(first, page([envelope(2, "two")]));

    assert.deepEqual(ids(first), [1]);
  });

  it("carries the cursor forward so the next page can be requested", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")], "opaque-cursor", true));

    assert.equal(state.nextCursor, "opaque-cursor");
  });

  it("does not call truncated-with-a-cursor unreachable: another page exists", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")], "c1", true));

    assert.equal(state.truncated, true);
    assert.equal(state.unreachable, false);
  });

  it("calls truncated-without-a-cursor unreachable: matches were dropped", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")], undefined, true));

    assert.equal(state.truncated, true);
    assert.equal(state.unreachable, true);
  });

  it("treats a null cursor on the wire as no cursor", () => {
    const wire = { hits: [envelope(1, "one")], nextCursor: null, truncated: true } as unknown as SearchResult;
    const state = appendPage(emptyPage(), wire);

    assert.equal(state.nextCursor, undefined);
    assert.equal(state.unreachable, true);
  });

  it("is neither truncated nor unreachable on a complete result", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")]));

    assert.equal(state.truncated, false);
    assert.equal(state.unreachable, false);
  });

  it("clears an earlier unreachable flag once a later page is complete", () => {
    const first = appendPage(emptyPage(), page([envelope(1, "one")], undefined, true));
    const second = appendPage(first, page([envelope(2, "two")]));

    assert.equal(second.unreachable, false);
  });

  it("handles an empty folder", () => {
    const state = appendPage(emptyPage(), page([]));

    assert.deepEqual(state.hits, []);
    assert.equal(state.truncated, false);
    assert.equal(state.unreachable, false);
  });
});

describe("patchEnvelope", () => {
  it("replaces the envelope in place and keeps the ordering", () => {
    const state = appendPage(
      emptyPage(),
      page([envelope(1, "one"), envelope(2, "two"), envelope(3, "three")]),
    );
    const patched = patchEnvelope(state, envelope(2, "read now"));

    assert.deepEqual(ids(patched), [1, 2, 3]);
    assert.equal(patched.hits[1]?.subject, "read now");
  });

  it("keeps the paging fields", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")], "c1", true));
    const patched = patchEnvelope(state, envelope(1, "changed"));

    assert.equal(patched.nextCursor, "c1");
    assert.equal(patched.truncated, true);
    assert.equal(patched.unreachable, false);
  });

  it("returns the same state when the id is not loaded", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")]));

    assert.equal(patchEnvelope(state, envelope(99, "elsewhere")), state);
  });

  it("leaves the previous state untouched", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")]));
    patchEnvelope(state, envelope(1, "changed"));

    assert.equal(state.hits[0]?.subject, "one");
  });
});

describe("removeEnvelope", () => {
  it("drops exactly one row and keeps the rest in order", () => {
    const state = appendPage(
      emptyPage(),
      page([envelope(1, "one"), envelope(2, "two"), envelope(3, "three")]),
    );
    const without = removeEnvelope(state, 2);

    assert.deepEqual(ids(without), [1, 3]);
  });

  it("returns the same state when the id is not loaded", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one")]));

    assert.equal(removeEnvelope(state, 99), state);
  });

  it("keeps the paging fields and leaves the previous state untouched", () => {
    const state = appendPage(emptyPage(), page([envelope(1, "one"), envelope(2, "two")], "c1", true));
    const without = removeEnvelope(state, 1);

    assert.deepEqual(ids(state), [1, 2]);
    assert.deepEqual(ids(without), [2]);
    assert.equal(without.nextCursor, "c1");
    assert.equal(without.truncated, true);
  });
});
