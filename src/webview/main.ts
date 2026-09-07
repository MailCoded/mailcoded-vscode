import { parseHostMessage, toOrigin } from "../reader/protocol.js";
import type { WebviewToHostMessage } from "../reader/protocol.js";

import { createReader } from "./render.js";
import type { Reader } from "./render.js";
import { createSanitizer } from "./sanitize.js";
import styles from "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const UNKNOWN_MESSAGE = "This build does not understand a message the reader just sent it.";
const RENDER_FAILED = "This message could not be shown safely. Use the plain text view.";
const NO_ORIGIN = "inline";

const queued: WebviewToHostMessage[] = [];

/** Replaced the moment the host API is in hand. It starts as a queue so the policy-violation
 * listener can be installed before anything else, including `acquireVsCodeApi`. */
let deliver = (message: WebviewToHostMessage): void => {
  queued.push(message);
};

function post(message: WebviewToHostMessage): void {
  deliver(message);
}

/** First, before anything else can be blocked. The blocked URI is reduced to an origin: it is
 * derived from mail, and the host writes what it receives into a log. */
document.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
  post({
    type: "cspViolation",
    directive: event.effectiveDirective || event.violatedDirective,
    blockedOrigin: toOrigin(event.blockedURI) || NO_ORIGIN,
  });
});

const host = acquireVsCodeApi();
deliver = (message: WebviewToHostMessage): void => {
  host.postMessage(message);
};
for (const message of queued.splice(0)) {
  deliver(message);
}

const sheet = document.createElement("style");
sheet.textContent = styles;
document.head.append(sheet);

const reader: Reader = createReader(document, createSanitizer(window), { post });

/** A sanitiser that throws must not leave a half-drawn panel and no signal: the message id still
 * goes back, and the plain text view is the standing fallback. */
window.addEventListener("message", (event: MessageEvent) => {
  const message = parseHostMessage(event.data);
  if (message === undefined) {
    reader.status(UNKNOWN_MESSAGE);
    return;
  }
  if (message.type === "status") {
    reader.status(message.text);
    return;
  }

  const started = performance.now();
  try {
    reader.render(message);
  } catch {
    reader.status(RENDER_FAILED);
  }
  post({
    type: "rendered",
    messageId: message.messageId,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
  });
});

post({ type: "ready" });
