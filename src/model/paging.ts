import type { EnvelopeDto, SearchResult } from "../protocol/index.js";

export interface PageState {
  readonly hits: readonly EnvelopeDto[];
  readonly nextCursor: string | undefined;
  readonly truncated: boolean;
  /** Matches were dropped that no further page can reach — rpc.md §7.1, the strong `truncated`. */
  readonly unreachable: boolean;
}

const EMPTY: PageState = Object.freeze({
  hits: [],
  nextCursor: undefined,
  truncated: false,
  unreachable: false,
});

export function emptyPage(): PageState {
  return EMPTY;
}

export function appendPage(state: PageState, result: SearchResult): PageState {
  const cursor = result.nextCursor ?? undefined;
  const seen = new Set(state.hits.map((hit) => hit.id));
  const hits = [...state.hits];

  // A message that arrives between two pages shifts the keyset window, so the same id can come
  // back twice; first seen wins and the order the user is looking at does not move.
  for (const hit of result.hits) {
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      hits.push(hit);
    }
  }

  return {
    hits,
    nextCursor: cursor,
    truncated: result.truncated,
    unreachable: result.truncated && cursor === undefined,
  };
}

export function patchEnvelope(state: PageState, envelope: EnvelopeDto): PageState {
  const at = state.hits.findIndex((hit) => hit.id === envelope.id);
  if (at < 0) {
    return state;
  }

  const hits = [...state.hits];
  hits[at] = envelope;
  return { ...state, hits };
}

export function removeEnvelope(state: PageState, id: number): PageState {
  const at = state.hits.findIndex((hit) => hit.id === id);
  if (at < 0) {
    return state;
  }

  const hits = [...state.hits];
  hits.splice(at, 1);
  return { ...state, hits };
}
