import styles from "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const host = acquireVsCodeApi();

const sheet = document.createElement("style");
sheet.textContent = styles;
document.head.append(sheet);

document.addEventListener("securitypolicyviolation", (event) => {
  host.postMessage({
    type: "cspViolation",
    directive: event.violatedDirective,
    blockedUri: event.blockedURI,
  });
});

host.postMessage({ type: "ready" });
