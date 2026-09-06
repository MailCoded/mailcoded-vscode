import * as vscode from "vscode";

import { readConfiguration } from "../config.js";
import { searchMessages } from "../daemon/client.js";
import type { MailcodedDaemonSupervisor } from "../daemon/supervisor.js";
import { RpcError } from "../daemon/types.js";
import type { DaemonNotification, Disposable } from "../daemon/types.js";
import { appendPage, emptyPage, patchEnvelope } from "../model/paging.js";
import type { PageState } from "../model/paging.js";
import { SearchOrders } from "../protocol/index.js";
import type { EnvelopeDto, RpcMethodName, SearchParams } from "../protocol/index.js";

import { loadMoreNode, messageNode, noticeNode, threadNode, toTreeItem } from "./messageItems.js";
import type { MessageTreeNode } from "./messageItems.js";

export type { MessageTreeNode } from "./messageItems.js";

export const MESSAGES_VIEW_ID = "mailcoded.messages";

/** An IDLE storm can emit one notification per message; the list is repainted once per burst. */
const ARRIVAL_DEBOUNCE_MS = 250;

const UNREACHABLE_TEXT = "Some matches were dropped";
const UNREACHABLE_DETAIL =
  "Relevance paging cannot reach every match for this query. Narrow the query, or sort by date, whose cursor reaches any depth.";

export interface FolderScope {
  readonly accountId: number;
  readonly folderId: number;
  readonly folderName: string;
}

export interface QueryScope {
  readonly accountId: number;
  readonly query: string;
}

export type MessageScope = FolderScope | QueryScope;

function isFolderScope(scope: MessageScope): scope is FolderScope {
  return "folderId" in scope;
}

function newer(left: EnvelopeDto, right: EnvelopeDto): number {
  if (left.date !== right.date) {
    return left.date < right.date ? 1 : -1;
  }
  return right.id - left.id;
}

function group(hits: readonly EnvelopeDto[]): MessageTreeNode[] {
  const order: string[] = [];
  const groups = new Map<string, EnvelopeDto[]>();

  for (const hit of hits) {
    const key = hit.threadKey ?? `#${String(hit.id)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [hit]);
      order.push(key);
      continue;
    }
    existing.push(hit);
  }

  const nodes: MessageTreeNode[] = [];
  for (const key of order) {
    const members = groups.get(key) ?? [];
    const first = members[0];
    if (first === undefined) {
      continue;
    }
    nodes.push(members.length === 1 ? messageNode(first) : threadNode(String(first.id), members));
  }
  return nodes;
}

/** The messages of one folder or one query, in `mailcoded.messages`. */
export class MessagesTreeProvider implements vscode.TreeDataProvider<MessageTreeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<MessageTreeNode | undefined>();

  readonly onDidChangeTreeData: vscode.Event<MessageTreeNode | undefined> = this.#changed.event;

  readonly #supervisor: MailcodedDaemonSupervisor;
  readonly #subscriptions: Disposable[] = [];

  #scope: MessageScope | undefined;
  #page: PageState = emptyPage();
  #arrivals: EnvelopeDto[] = [];
  #reloadPending = false;
  #loaded = false;
  #loading: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #disposed = false;

  constructor(supervisor: MailcodedDaemonSupervisor) {
    this.#supervisor = supervisor;
    this.#subscriptions.push(
      supervisor.onNotification((notification) => {
        this.#onNotification(notification);
      }),
    );
  }

  get scope(): MessageScope | undefined {
    return this.#scope;
  }

  get messageCount(): number {
    return this.#page.hits.length;
  }

  getTreeItem(element: MessageTreeNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  async getChildren(element?: MessageTreeNode): Promise<MessageTreeNode[]> {
    try {
      if (element !== undefined) {
        return element.kind === "thread" ? element.envelopes.map(messageNode) : [];
      }
      if (this.#scope === undefined) {
        return [];
      }
      if (!this.#loaded) {
        await this.#load(undefined);
      }
      return this.#rows();
    } catch (error: unknown) {
      this.#log("search", error);
      return [];
    }
  }

  show(scope: MessageScope): void {
    this.#scope = scope;
    this.#reset();
    this.#changed.fire(undefined);
  }

  refresh(): void {
    this.#reset();
    this.#changed.fire(undefined);
  }

  /** One row, in place: a tag change must not re-run the search the reader is paging through. */
  patch(envelope: EnvelopeDto): void {
    const patched = patchEnvelope(this.#page, envelope);
    if (patched === this.#page) {
      return;
    }
    this.#page = patched;
    this.#changed.fire(undefined);
  }

  async loadMore(): Promise<void> {
    const cursor = this.#page.nextCursor;
    if (this.#scope === undefined || cursor === undefined) {
      return;
    }
    await this.#load(cursor);
    this.#changed.fire(undefined);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#scope = undefined;
    this.#page = emptyPage();
    this.#arrivals = [];
    this.#changed.dispose();
  }

  #rows(): MessageTreeNode[] {
    const hits = this.#page.hits;
    const nodes = readConfiguration().threadGrouping ? group(hits) : hits.map(messageNode);

    if (this.#page.nextCursor !== undefined) {
      nodes.push(loadMoreNode());
    }
    if (this.#page.unreachable) {
      nodes.push(noticeNode(UNREACHABLE_TEXT, UNREACHABLE_DETAIL));
    }
    return nodes;
  }

  async #load(cursor: string | undefined): Promise<void> {
    const inflight = this.#loading;
    if (inflight !== undefined) {
      await inflight;
      return;
    }
    const running = this.#fetch(cursor);
    this.#loading = running;
    try {
      await running;
    } finally {
      this.#loading = undefined;
    }
  }

  async #fetch(cursor: string | undefined): Promise<void> {
    const scope = this.#scope;
    if (scope === undefined) {
      return;
    }
    const generation = this.#generation;

    try {
      const result = await searchMessages(this.#supervisor.client, this.#params(scope, cursor));
      if (this.#disposed || generation !== this.#generation) {
        return;
      }
      this.#page = appendPage(cursor === undefined ? emptyPage() : this.#page, result);
      this.#loaded = true;
    } catch (error: unknown) {
      this.#log("search", error);
      // Latched even on failure: otherwise every repaint of the view fires the search again.
      if (!this.#disposed && generation === this.#generation) {
        this.#loaded = true;
      }
    }
  }

  #params(scope: MessageScope, cursor: string | undefined): SearchParams {
    const limit = readConfiguration().pageSize;
    const base: SearchParams = isFolderScope(scope)
      ? {
          query: "",
          accountId: scope.accountId,
          folderId: scope.folderId,
          order: SearchOrders.Date,
          includeSnippet: false,
          limit,
        }
      : {
          query: scope.query,
          accountId: scope.accountId,
          order: SearchOrders.Relevance,
          includeSnippet: true,
          limit,
        };
    return cursor === undefined ? base : { ...base, cursor };
  }

  #onNotification(notification: DaemonNotification): void {
    if (this.#disposed || notification.method !== "notify.mail.added") {
      return;
    }
    const scope = this.#scope;
    if (scope === undefined || !isFolderScope(scope)) {
      return;
    }
    const arrival = notification.params;
    if (arrival.accountId !== scope.accountId || arrival.folderId !== scope.folderId) {
      return;
    }

    if (arrival.coalesced) {
      this.#reloadPending = true;
    } else {
      this.#arrivals.push(...arrival.messages);
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, ARRIVAL_DEBOUNCE_MS);
  }

  async #flush(): Promise<void> {
    const reload = this.#reloadPending;
    const arrivals = this.#arrivals;
    this.#reloadPending = false;
    this.#arrivals = [];

    if (this.#disposed || this.#scope === undefined) {
      return;
    }
    if (reload) {
      this.#reset();
      await this.#load(undefined);
    } else if (!this.#prepend(arrivals)) {
      return;
    }
    this.#changed.fire(undefined);
  }

  /** Only ever a date-ordered folder: a relevance page has no position for an arrival to take. */
  #prepend(arrivals: readonly EnvelopeDto[]): boolean {
    const scope = this.#scope;
    if (scope === undefined || !isFolderScope(scope) || !this.#loaded) {
      return false;
    }

    const seen = new Set(this.#page.hits.map((hit) => hit.id));
    const fresh: EnvelopeDto[] = [];
    for (const envelope of arrivals) {
      if (envelope.folderId !== scope.folderId || seen.has(envelope.id)) {
        continue;
      }
      seen.add(envelope.id);
      fresh.push(envelope);
    }
    if (fresh.length === 0) {
      return false;
    }

    fresh.sort(newer);
    this.#page = { ...this.#page, hits: [...fresh, ...this.#page.hits] };
    return true;
  }

  #reset(): void {
    this.#generation += 1;
    this.#page = emptyPage();
    this.#arrivals = [];
    this.#reloadPending = false;
    this.#loaded = false;
    this.#loading = undefined;
    this.#clearTimer();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Method and code only: params and results carry mail content. A disposed output channel
   * throws, and reporting a failure must never be what fails. */
  #log(method: RpcMethodName, error: unknown): void {
    const code = error instanceof RpcError ? String(error.code) : "no code";
    try {
      this.#supervisor.output.appendLine(`Messages view: ${method} failed (${code})`);
    } catch {
      return;
    }
  }
}
