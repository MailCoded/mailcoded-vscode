import assert from "node:assert/strict";

import type { RpcErrorData } from "../../src/protocol/index.js";
import { RpcErrorCode } from "../../src/protocol/index.js";
import { RpcError } from "../../src/daemon/types.js";
import { explain } from "./harness.test.js";

function rpcError(code: number, message: string, data?: RpcErrorData): RpcError {
  return data === undefined ? new RpcError(code, message) : new RpcError(code, message, data);
}

describe("errors.explain", () => {
  it("stops and asks the human on 1000 rather than retrying", async () => {
    const explained = await explain(
      rpcError(RpcErrorCode.Auth, "Authentication failed.", {
        category: "auth",
        requiresUserAction: true,
        accountId: 1,
      }),
    );

    assert.match(explained.text, /authenticat|password|sign in/i);
    assert.ok(
      explained.actions.some((action) => /update password/i.test(action.title)),
      `expected an "Update password" action, got [${explained.actions.map((a) => a.title).join(", ")}]`,
    );
    assert.ok(
      !explained.actions.some((action) => /^retry$/i.test(action.title)),
      "repeated auth failures lock accounts, so there is no retry action",
    );
  });

  it("names the closed gate on 1006 and offers no retry", async () => {
    const explained = await explain(
      rpcError(RpcErrorCode.Forbidden, "Sending is disabled for this caller.", {
        category: "permanent",
        detail: "MAILCODED_SEND=1",
        requiresUserAction: true,
      }),
    );

    assert.ok(explained.text.includes("MAILCODED_SEND=1"), `the gate must be named: ${explained.text}`);
    assert.ok(!explained.actions.some((action) => /retry/i.test(action.title)), "no retry opens a gate");
  });

  it("puts the wait from retryAfterMs into the text on 1005", async () => {
    const explained = await explain(
      rpcError(RpcErrorCode.RateLimited, "Too many requests.", { category: "busy", retryAfterMs: 45_000 }),
    );

    assert.match(explained.text, /45/, `expected the 45 second wait in: ${explained.text}`);
    assert.match(explained.text, /second|sec\b/i);
  });

  it("tells the user to refresh on 1002 and to re-preview on 1003", async () => {
    const notFound = await explain(rpcError(RpcErrorCode.NotFound, "No account with id 999.", { category: "notFound" }));
    assert.match(notFound.text, /no longer|refresh|gone|moved|not found/i);

    const confirm = await explain(
      rpcError(RpcErrorCode.ConfirmRequired, "A valid one-time token is required.", {
        category: "protocol",
        requiresUserAction: true,
      }),
    );
    assert.match(confirm.text, /preview|confirm|review/i);
  });

  it("covers the whole code table without falling back to the daemon's prose", async () => {
    const codes = [
      -32700, -32600, -32601, -32602, -32603, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008,
    ];
    for (const code of codes) {
      const explained = await explain(rpcError(code, "Something the daemon said."));
      assert.ok(explained.text.trim().length > 0, `code ${code} produced no text`);
      assert.ok(Array.isArray(explained.actions), `code ${code} produced no actions array`);
    }
  });

  it("classifies transient failures and gates the way the C# client does", () => {
    assert.equal(rpcError(RpcErrorCode.Network, "reset").isTransient, true);
    assert.equal(rpcError(RpcErrorCode.RateLimited, "busy").isTransient, true);
    assert.equal(rpcError(RpcErrorCode.Auth, "auth").isTransient, false);
    assert.equal(rpcError(RpcErrorCode.Forbidden, "gate").isGate, true);
    assert.equal(rpcError(RpcErrorCode.ConfirmRequired, "token").isGate, true);
    assert.equal(rpcError(RpcErrorCode.NotFound, "gone").isGate, false);
    assert.equal(rpcError(RpcErrorCode.NotFound, "gone").requiresUserAction, false);
  });
});
