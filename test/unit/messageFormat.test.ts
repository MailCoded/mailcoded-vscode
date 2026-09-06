import assert from "node:assert/strict";

import type { AttachmentDto, EnvelopeDto, MessageGetResult } from "../../src/protocol/index.js";
import { hardenLine, messageDocument, senderLabel, shortDate } from "../../src/model/messageFormat.js";

const ESC = "\u001b";
const RIGHT_TO_LEFT_OVERRIDE = "\u202e";
const ZERO_WIDTH_SPACE = "​";
const TAG_LATIN_A = "\u{e0041}";

interface EnvelopeOptions {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  tags?: readonly string[];
  hasAttachments?: boolean;
  bodyFetched?: boolean;
}

function envelope(options: EnvelopeOptions = {}): EnvelopeDto {
  const base: EnvelopeDto = {
    id: 4213,
    accountId: 2,
    folderId: 12,
    date: options.date ?? "2026-08-30T12:34:56.000Z",
    flags: ["unread"],
    tags: options.tags ?? [],
    hasAttachments: options.hasAttachments ?? false,
    size: 20481,
    bodyFetched: options.bodyFetched ?? true,
  };

  return {
    ...base,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.cc === undefined ? {} : { cc: options.cc }),
  };
}

interface MessageOptions {
  bodyText?: string;
  bodyFetched?: boolean;
  attachments?: readonly AttachmentDto[];
  parseWarnings?: readonly string[];
}

function message(from: EnvelopeDto, options: MessageOptions = {}): MessageGetResult {
  const base: MessageGetResult = {
    envelope: from,
    attachments: options.attachments ?? [],
    bodyFetched: options.bodyFetched ?? true,
    parseWarnings: options.parseWarnings ?? [],
  };
  return options.bodyText === undefined ? base : { ...base, bodyText: options.bodyText };
}

function attachment(index: number, filename: string | undefined, mime: string, size: number): AttachmentDto {
  const base: AttachmentDto = { index, mime, size, isInline: false };
  return filename === undefined ? base : { ...base, filename };
}

function lineFor(document: string, label: string): string {
  const hit = document.split("\n").find((line) => line.startsWith(`${label}:`));
  assert.ok(hit !== undefined, `no "${label}:" line in the document`);
  return hit;
}

function valueFor(document: string, label: string): string {
  return lineFor(document, label).slice(`${label}:`.length).trim();
}

describe("hardenLine", () => {
  it("returns an empty string for an absent value", () => {
    assert.equal(hardenLine(undefined), "");
  });

  it("strips an ANSI escape sequence", () => {
    assert.equal(hardenLine(`${ESC}[31mpay now${ESC}[0m`), "[31mpay now[0m");
    assert.ok(!hardenLine(`${ESC}[31mpay now`).includes(ESC));
  });

  it("strips a bidi override that would reverse the text around it", () => {
    const spoofed = `invoice${RIGHT_TO_LEFT_OVERRIDE}fdp.exe`;

    assert.equal(hardenLine(spoofed), "invoicefdp.exe");
    assert.ok(!hardenLine(spoofed).includes(RIGHT_TO_LEFT_OVERRIDE));
  });

  it("strips a zero-width space", () => {
    assert.equal(hardenLine(`pay${ZERO_WIDTH_SPACE}pal`), "paypal");
  });

  it("strips a tag-block character", () => {
    assert.equal(hardenLine(`hello${TAG_LATIN_A}`), "hello");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    assert.equal(hardenLine("  re:\t\tlunch\n\nplans  "), "re: lunch plans");
  });

  it("caps a long line with an ellipsis and never exceeds the cap", () => {
    const capped = hardenLine("x".repeat(500), 10);

    assert.equal(capped, `${"x".repeat(9)}…`);
    assert.equal(Array.from(capped).length, 10);
  });

  it("caps at 200 code points by default", () => {
    assert.equal(Array.from(hardenLine("y".repeat(500))).length, 200);
  });

  it("counts astral characters as one code point when capping", () => {
    assert.equal(hardenLine("😀".repeat(8), 4), "😀😀😀…");
  });

  it("leaves a line shorter than the cap untouched", () => {
    assert.equal(hardenLine("short", 200), "short");
  });
});

describe("senderLabel", () => {
  it("prefers the display name over the address", () => {
    assert.equal(senderLabel(envelope({ from: "Andrew Lin <andrew@example.test>" })), "Andrew Lin");
  });

  it("unquotes a display name that contains a comma", () => {
    assert.equal(senderLabel(envelope({ from: '"Lin, Andrew" <andrew@example.test>' })), "Lin, Andrew");
  });

  it("falls back to the address when there is no display name", () => {
    assert.equal(senderLabel(envelope({ from: "<andrew@example.test>" })), "andrew@example.test");
  });

  it("uses a bare address as it stands", () => {
    assert.equal(senderLabel(envelope({ from: "andrew@example.test" })), "andrew@example.test");
  });

  it("names the sender unknown when From is absent", () => {
    assert.equal(senderLabel(envelope()), "(unknown sender)");
  });

  it("names the sender unknown when From is blank", () => {
    assert.equal(senderLabel(envelope({ from: "   " })), "(unknown sender)");
  });

  it("hardens a hostile display name", () => {
    const label = senderLabel(envelope({ from: `"${ESC}[2Jbank${RIGHT_TO_LEFT_OVERRIDE}" <evil@example.test>` }));

    assert.ok(!label.includes(ESC));
    assert.ok(!label.includes(RIGHT_TO_LEFT_OVERRIDE));
    assert.equal(label, "[2Jbank");
  });
});

describe("shortDate", () => {
  const original = process.env["TZ"];

  before(() => {
    process.env["TZ"] = "UTC";
  });

  after(() => {
    if (original === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = original;
    }
  });

  it("shows the time for a message from today", () => {
    const now = new Date("2026-09-07T23:10:00.000Z");

    assert.equal(shortDate("2026-09-07T09:05:00.000Z", now), "09:05");
  });

  it("shows the month and day for a message from another day", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");

    assert.equal(shortDate("2026-03-01T12:00:00.000Z", now), "Mar 01");
  });

  it("does not treat the same day of another year as today", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");

    assert.equal(shortDate("2025-09-07T12:00:00.000Z", now), "Sep 07");
  });

  it("says so rather than guessing when the date will not parse", () => {
    assert.equal(shortDate("not a date", new Date("2026-09-07T12:00:00.000Z")), "??? ??");
  });
});

describe("messageDocument", () => {
  const original = process.env["TZ"];

  before(() => {
    process.env["TZ"] = "UTC";
  });

  after(() => {
    if (original === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = original;
    }
  });

  const normal = message(
    envelope({
      subject: "Invoice 41",
      from: "Andrew Lin <andrew@example.test>",
      to: "billing@example.test",
      date: "2026-08-30T12:34:56.000Z",
    }),
    { bodyText: "Line one.\r\nLine two.\r\n" },
  );

  it("renders the header block, a blank line, then the body", () => {
    const document = messageDocument(normal);
    const lines = document.split("\n");

    assert.deepEqual(lines.slice(0, 5), [
      "Subject: Invoice 41",
      "From:    Andrew Lin <andrew@example.test>",
      "To:      billing@example.test",
      "Date:    2026-08-30 12:34",
      "",
    ]);
    assert.equal(lines[5], "Line one.");
    assert.equal(lines[6], "Line two.");
  });

  it("normalises CRLF and ends with a single newline", () => {
    const document = messageDocument(normal);

    assert.ok(!document.includes("\r"));
    assert.ok(document.endsWith("Line two.\n"));
  });

  it("omits Cc and Tags when the message has none", () => {
    const document = messageDocument(normal);

    assert.ok(!document.includes("Cc:"));
    assert.ok(!document.includes("Tags:"));
    assert.ok(!document.includes("Warn:"));
    assert.ok(!document.includes("Attach:"));
  });

  it("shows Cc and Tags when they are present", () => {
    const withBoth = messageDocument(
      message(
        envelope({
          subject: "Invoice 41",
          from: "andrew@example.test",
          to: "billing@example.test",
          cc: "audit@example.test",
          tags: ["unread", "triaged"],
        }),
        { bodyText: "hello" },
      ),
    );

    assert.equal(valueFor(withBoth, "Cc"), "audit@example.test");
    assert.equal(valueFor(withBoth, "Tags"), "unread triaged");
  });

  it("names the subject and sender when the headers are absent", () => {
    const document = messageDocument(message(envelope(), { bodyText: "hello" }));

    assert.equal(valueFor(document, "Subject"), "(no subject)");
    assert.equal(valueFor(document, "From"), "(unknown sender)");
    assert.equal(valueFor(document, "To"), "(none)");
  });

  it("lists one line per attachment with index, name, type and size", () => {
    const document = messageDocument(
      message(envelope({ subject: "Invoice 41", hasAttachments: true }), {
        bodyText: "see attached",
        attachments: [
          attachment(0, "invoice.pdf", "application/pdf", 20481),
          attachment(1, undefined, "image/png", 512),
          attachment(2, "scan.tiff", "image/tiff", 3 * 1024 * 1024),
        ],
      }),
    );
    const lines = document.split("\n").filter((line) => line.startsWith("Attach:"));

    assert.deepEqual(lines, [
      "Attach:  0  invoice.pdf  application/pdf  20 KB",
      "Attach:  1  (unnamed)  image/png  512 B",
      "Attach:  2  scan.tiff  image/tiff  3 MB",
    ]);
  });

  it("lists the parse warnings", () => {
    const document = messageDocument(
      message(envelope({ subject: "Invoice 41" }), {
        bodyText: "hello",
        parseWarnings: ["missing-date", "bad-charset"],
      }),
    );

    assert.equal(valueFor(document, "Warn"), "missing-date bad-charset");
  });

  it("says the body was never fetched rather than showing an empty reader", () => {
    const document = messageDocument(message(envelope({ bodyFetched: false }), { bodyFetched: false }));

    assert.ok(document.endsWith("(body not fetched)\n"));
    assert.ok(!document.includes("no plaintext part"));
  });

  it("says the message has no plaintext part when the body was fetched and is empty", () => {
    const document = messageDocument(message(envelope(), { bodyFetched: true, bodyText: "   \n" }));

    assert.ok(document.endsWith("(this message has no plaintext part)\n"));
    assert.ok(!document.includes("not fetched"));
  });

  it("hardens a hostile subject without disturbing the header block", () => {
    const hostile = `Re:${ESC}[2K${RIGHT_TO_LEFT_OVERRIDE}gnp.exe${ZERO_WIDTH_SPACE}${TAG_LATIN_A}\nSubject: forged`;
    const document = messageDocument(message(envelope({ subject: hostile }), { bodyText: "hello" }));

    assert.equal(valueFor(document, "Subject"), "Re:[2Kgnp.exe Subject: forged");
    assert.equal(document.split("\n").filter((line) => line.startsWith("Subject:")).length, 1);
    for (const scalar of [ESC, RIGHT_TO_LEFT_OVERRIDE, ZERO_WIDTH_SPACE, TAG_LATIN_A]) {
      assert.ok(!document.includes(scalar));
    }
  });

  it("strips control scalars from the body but keeps its line breaks", () => {
    const document = messageDocument(
      message(envelope({ subject: "Invoice 41" }), {
        bodyText: `first${ESC}[31m\n\tsecond${RIGHT_TO_LEFT_OVERRIDE}\n\nfourth`,
      }),
    );
    const body = document.slice(document.indexOf("\n\n") + 2);

    assert.equal(body, "first[31m\n\tsecond\n\nfourth\n");
    assert.ok(!document.includes(ESC));
  });
});
