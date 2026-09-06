import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GOLDEN_DIR = fileURLToPath(new URL("../fixtures/golden/", import.meta.url));

function golden(name) {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, name), "utf8"));
}

const GOLDEN_INITIALIZE = golden("initialize.response.json").result;
const GOLDEN_ACCOUNT_LIST = golden("account-list.response.json").result;
const GOLDEN_SEARCH = golden("search.response.json").result;
const GOLDEN_MESSAGE_GET = golden("message-get.response.json").result;
const GOLDEN_FOLDER_LIST_UNKNOWN = golden("folder-list-unknown-account.response.json").error;

/** Recognisable values the secrecy test hunts for; nothing here is a real credential. */
export const SECRET_SENTINEL = "sentinel-credential-4f7a91c2e0";
export const SEND_TOKEN_SENTINEL = "sentinel-one-time-send-token-8b3d02";

export const GOLDEN_ACCOUNT_EMAIL = GOLDEN_ACCOUNT_LIST.accounts[0].email;
export const GOLDEN_DAEMON_VERSION = GOLDEN_INITIALIZE.daemonVersion;
export const GOLDEN_METHODS = GOLDEN_INITIALIZE.capabilities.methods;

/** The engine canonicalises this field to a placeholder; a backend name is what a daemon sends. */
const SECRET_BACKEND = "libsecret";

const ENVELOPE = GOLDEN_MESSAGE_GET.envelope;

/** The engine records no happy `folder.list`, so this one is synthesised to the §4 FolderDto shape. */
const FOLDER_LIST_RESULT = {
  folders: [
    { id: 1, accountId: 1, name: "INBOX", role: "inbox", unread: 2, total: 41 },
    { id: 2, accountId: 1, name: "INBOX/Archive", role: "archive", unread: 0, total: 900 },
    { id: 3, accountId: 1, name: "Sent", role: "sent", unread: 0, total: 12 },
  ],
};

const STATS_RESULT = {
  stats: {
    daemonVersion: GOLDEN_DAEMON_VERSION,
    protocolVersion: 1,
    uptimeMs: 1234,
    schemaVersion: 7,
    openConnections: 1,
    tableCounts: { messages: 41 },
    folders: [
      {
        folderId: 1,
        accountId: 1,
        name: "INBOX",
        highestModSeq: "0",
        unread: 2,
        total: 41,
        lastSyncUtc: "2026-08-30T12:34:56.000Z",
      },
    ],
  },
};

const HEALTH_RESULT = {
  health: {
    status: "ok",
    storeOk: true,
    accounts: [
      {
        accountId: 1,
        email: GOLDEN_ACCOUNT_EMAIL,
        connection: "connected",
        auth: "ok",
        watching: true,
        consecutiveFailures: 0,
        outboxQueued: 0,
        outboxFailed: 0,
      },
    ],
    warnings: [],
  },
};

const SEND_PREVIEW_RESULT = {
  draftId: 17,
  preview: {
    from: GOLDEN_ACCOUNT_EMAIL,
    to: ["a@b.test"],
    cc: [],
    bcc: [],
    subject: "Re: invoice",
    bodyPreview: "Thanks - looking now.",
    bodyTruncated: false,
    sizeBytes: 812,
    messageId: "golden-outbox-1@example.test",
    requiresSmtpUtf8: false,
    warnings: [],
  },
  confirmToken: SEND_TOKEN_SENTINEL,
  confirmTokenExpiresUtc: "2026-08-30T12:39:56.000Z",
};

export function initializeResult({ protocolVersion = 1, watch = true, methods } = {}) {
  return {
    daemonVersion: GOLDEN_DAEMON_VERSION,
    protocolVersion,
    capabilities: {
      ...GOLDEN_INITIALIZE.capabilities,
      secretBackend: SECRET_BACKEND,
      methods: methods ?? GOLDEN_METHODS,
      watch,
    },
  };
}

function envelope(id) {
  return { ...ENVELOPE, id, messageId: `golden-${id}@example.test` };
}

const BASE_RESULTS = {
  "account.list": GOLDEN_ACCOUNT_LIST,
  "folder.list": FOLDER_LIST_RESULT,
  search: GOLDEN_SEARCH,
  "message.get": GOLDEN_MESSAGE_GET,
  "thread.get": { messages: [envelope(1)], truncated: false },
  "message.move": {},
  "tags.set": { tags: ["triaged", "unread"] },
  sync: { added: 0, updated: 0, expunged: 0, durationMs: 3 },
  "watch.subscribe": {},
  "secret.set": {},
  "send.preview": SEND_PREVIEW_RESULT,
  stats: STATS_RESULT,
  health: HEALTH_RESULT,
  shutdown: {},
};

function baseHandle(ctx, request) {
  const { method, id, params } = request;
  if (method === "initialize") {
    ctx.reply(id, initializeResult(ctx.initializeOptions));
    return;
  }
  if (method === "folder.list" && params && params.accountId !== 1) {
    ctx.error(id, GOLDEN_FOLDER_LIST_UNKNOWN.code, GOLDEN_FOLDER_LIST_UNKNOWN.message, GOLDEN_FOLDER_LIST_UNKNOWN.data);
    return;
  }
  if (method === "send") {
    ctx.error(id, 1003, "A valid one-time token from send.preview is required before a message is sent.", {
      category: "protocol",
      requiresUserAction: true,
    });
    return;
  }
  const result = BASE_RESULTS[method];
  if (result === undefined) {
    ctx.error(id, -32601, `No method named '${method}' exists on protocol version 1.`, { category: "unsupported" });
    return;
  }
  ctx.reply(id, result);
  if (method === "shutdown") ctx.exitAfter(50, 0);
}

function mailAdded({ count, size, folderId = 1 }) {
  return {
    accountId: 1,
    folderId,
    folderName: "INBOX",
    count,
    messages: Array.from({ length: size }, (_, index) => envelope(index + 1)),
  };
}

const SYNC_ERROR = {
  accountId: 1,
  folderId: 1,
  code: 1001,
  message: "The connection was reset.",
  category: "network",
  requiresUserAction: false,
  retryAfterMs: 5000,
  atUtc: "2026-08-30T12:34:56.000Z",
};

/** The store the sidebar is built for: one imported account, one Outlook-shaped one. */
export const TREE_ACCOUNTS = [
  {
    id: 1,
    email: "local@import.mailcoded.test",
    displayName: "Local import",
    provider: "imap",
    auth: "password",
    quirks: [],
  },
  {
    id: 2,
    email: "outlook.user@outlook.test",
    displayName: "Outlook",
    provider: "graph",
    auth: "oauth2",
    quirks: [],
  },
];

/** Deliberately not in role order, and 'Projects' is absent while 'Projects/Alpha' is listed. */
export const TREE_FOLDERS = {
  1: [{ id: 101, accountId: 1, name: "INBOX", role: "inbox", unread: 5, total: 37 }],
  2: [
    { id: 202, accountId: 2, name: "Archive", role: "archive", unread: 0, total: 1804 },
    { id: 207, accountId: 2, name: "Projects/Alpha", unread: 2, total: 8 },
    { id: 204, accountId: 2, name: "Sent", role: "sent", unread: 0, total: 512 },
    { id: 201, accountId: 2, name: "INBOX", role: "inbox", unread: 12, total: 240 },
    { id: 208, accountId: 2, name: "Newsletters", unread: 3, total: 96 },
    { id: 205, accountId: 2, name: "Papierkorb", role: "trash", unread: 0, total: 64 },
    { id: 203, accountId: 2, name: "Drafts", role: "drafts", unread: 1, total: 3 },
    { id: 206, accountId: 2, name: "Junk", role: "junk", unread: 7, total: 19 },
  ],
};

/** ESC, U+202E and U+200B, exactly as a server is free to name a folder. */
export const HOSTILE_FOLDER_NAME = [
  String.fromCodePoint(0x1b),
  "[31mAlerts",
  String.fromCodePoint(0x202e),
  "gnp.txt",
  String.fromCodePoint(0x200b),
].join("");

const HOSTILE_FOLDERS = {
  1: [
    { id: 101, accountId: 1, name: "INBOX", role: "inbox", unread: 5, total: 37 },
    { id: 102, accountId: 1, name: HOSTILE_FOLDER_NAME, unread: 1, total: 1 },
  ],
  2: TREE_FOLDERS[2],
};

/** What the `accounts` scenarios push on `watch.subscribe`, so a test can trigger one on demand. */
export const TREE_FOLDER_UPDATED = {
  accountId: 2,
  folder: { id: 201, accountId: 2, name: "INBOX", role: "inbox", unread: 13, total: 241 },
};


/** The message list is specified against the real store: one folder deeper than a page, one empty. */
export const MESSAGE_COUNTS = { 201: 257, 204: 0 };

export const HOSTILE_SUBJECT = [
  String.fromCodePoint(0x1b),
  "[31mPayment",
  String.fromCodePoint(0x202e),
  "fdp.exe",
  String.fromCodePoint(0x200b),
].join("");

/** Newest first, one minute apart, so date order is unambiguous and every id is distinct. */
function listEnvelope(folderId, index) {
  const at = new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - index * 60_000);
  return {
    ...ENVELOPE,
    id: folderId * 1000 + index,
    accountId: 2,
    folderId,
    threadKey: `thread-${String(Math.floor(index / 4))}`,
    messageId: `list-${String(folderId)}-${String(index)}@example.test`,
    subject: index === 0 ? HOSTILE_SUBJECT : `Message ${String(index)}`,
    from: `"Sender ${String(index)}" <sender${String(index)}@example.test>`,
    date: at.toISOString(),
    flags: index % 2 === 0 ? ["unread"] : [],
    tags: index % 2 === 0 ? ["unread"] : [],
    snippet: null,
  };
}

/** The mock's cursor is opaque to the client, which is the only property that matters here. */
function cursorAt(offset) {
  return Buffer.from(`offset:${String(offset)}`, "utf8").toString("base64");
}

function offsetOf(cursor) {
  if (typeof cursor !== "string" || cursor === "") return 0;
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const parsed = /^offset:(\d+)$/.exec(decoded);
  if (parsed === null) throw new Error(`the client sent a cursor it constructed: ${decoded}`);
  return Number(parsed[1]);
}

/** A folder browse pages to any depth; a relevance query drops what its offset cap cannot reach. */
function searchResult(params) {
  const limit = params?.limit;
  const query = typeof params?.query === "string" ? params.query.trim() : "";
  if (query !== "") {
    return { hits: [listEnvelope(201, 0), listEnvelope(201, 1)], nextCursor: null, truncated: true };
  }

  const folderId = params?.folderId;
  const total = MESSAGE_COUNTS[folderId] ?? 0;
  const from = offsetOf(params?.cursor);
  const to = Math.min(total, from + limit);
  const hits = [];
  for (let index = from; index < to; index += 1) hits.push(listEnvelope(folderId, index));
  const more = to < total;
  return { hits, nextCursor: more ? cursorAt(to) : null, truncated: more };
}

function accountsScenario({
  accounts = TREE_ACCOUNTS,
  folders = TREE_FOLDERS,
  failFor = [],
  watch = true,
  searchFails = false,
} = {}) {
  const failing = new Set(failFor);
  return {
    initializeOptions: { watch },
    handle(ctx, request) {
      const { method, id, params } = request;
      if (method === "account.list") {
        ctx.reply(id, { accounts });
        return;
      }
      if (method === "folder.list") {
        const accountId = params?.accountId;
        const owned = failing.has(accountId) ? undefined : folders[accountId];
        if (owned === undefined) {
          ctx.error(id, GOLDEN_FOLDER_LIST_UNKNOWN.code, `No folders for account ${accountId}.`, {
            category: "notFound",
            requiresUserAction: false,
            accountId,
          });
          return;
        }
        ctx.reply(id, { folders: owned });
        return;
      }
      if (method === "watch.subscribe") {
        ctx.reply(id, {});
        ctx.notify("notify.folder.updated", TREE_FOLDER_UPDATED);
        return;
      }
      if (method === "message.get") {
        if (params?.format !== "text") {
          ctx.error(id, -32602, `This mock serves plaintext only; '${String(params?.format)}' was asked for.`, {
            category: "protocol",
          });
          return;
        }
        if (params.messageId !== GOLDEN_MESSAGE_GET.envelope.id) {
          ctx.error(id, 1002, `No message with id ${String(params.messageId)} exists.`, {
            category: "notFound",
            requiresUserAction: false,
          });
          return;
        }
      }
      if (method === "search") {
        const limit = params?.limit;
        if (typeof limit !== "number" || limit < 1) {
          ctx.error(id, -32602, "This mock refuses an unbounded search: rpc.md \u00a78 requires a limit.", {
            category: "protocol",
          });
          return;
        }
        if (searchFails) {
          ctx.error(id, 1004, "The mail store could not be read.", {
            category: "storeCorrupt",
            requiresUserAction: true,
          });
          return;
        }
        ctx.reply(id, searchResult(params));
        return;
      }
      baseHandle(ctx, request);
    },
  };
}

export const SCENARIOS = {
  happy: { handle: baseHandle },

  secondary: {
    initializeOptions: { watch: false },
    handle: baseHandle,
  },

  mismatch: {
    initializeOptions: { protocolVersion: 2 },
    handle: baseHandle,
  },

  minimal: {
    initializeOptions: { methods: GOLDEN_METHODS.filter((name) => name !== "thread.get") },
    handle: baseHandle,
  },

  /** `stats` answers late so a later `health` answers first: correlation must be by id, not arrival. */
  slow: {
    handle(ctx, request) {
      if (request.method === "stats") {
        ctx.after(400, () => ctx.reply(request.id, STATS_RESULT));
        return;
      }
      baseHandle(ctx, request);
    },
  },

  notify: {
    handle(ctx, request) {
      if (request.method === "watch.subscribe") {
        ctx.notify("notify.mail.added", mailAdded({ count: 25, size: 2 }));
        ctx.notify("notify.mail.added", mailAdded({ count: 2, size: 2 }));
        ctx.notify("notify.sync.error", SYNC_ERROR);
        ctx.reply(request.id, {});
        ctx.notify("notify.folder.updated", {
          accountId: 1,
          folder: FOLDER_LIST_RESULT.folders[0],
        });
        return;
      }
      baseHandle(ctx, request);
    },
  },

  /** Answers -32700 with a null id and then stops reading, exactly as the daemon does. */
  fatal: {
    handle(ctx, request) {
      if (request.method === "initialize") {
        baseHandle(ctx, request);
        return;
      }
      ctx.errorNoId(-32700, "The request body was not valid JSON.", { category: "protocol" });
      ctx.stopReading();
      ctx.exitAfter(8000, 0);
    },
  },

  crash: {
    handle(ctx, request) {
      if (request.method === "initialize") {
        baseHandle(ctx, request);
        return;
      }
      ctx.exitAfter(10, 7);
    },
  },

  /** Never answers anything: the spawn succeeds and the child dies, which must back off, not spin. */
  crashOnStart: {
    onStart(ctx) {
      ctx.exitAfter(5, 9);
    },
    handle() {},
  },

  /** Two accounts and a folder set per account: the shape the sidebar is specified against. */
  accounts: accountsScenario(),

  /** Another mailcoded owns the store lock: every request answers, no notification arrives. */
  accountsSecondary: accountsScenario({ watch: false }),

  /** One account's folders are unreachable; the other account must still render. */
  accountsPartialFailure: accountsScenario({ failFor: [2] }),

  accountsHostileLabels: accountsScenario({ folders: HOSTILE_FOLDERS }),

  /** Every `search` answers 1004: the message list must render empty, never reject. */
  accountsSearchFails: accountsScenario({ searchFails: true }),
};

export function scenario(name) {
  const found = SCENARIOS[name];
  if (found === undefined) throw new Error(`Unknown mock daemon scenario '${name}'`);
  return found;
}
