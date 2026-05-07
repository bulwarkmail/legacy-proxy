import { describe, expect, it } from "vitest";
import { generateScript } from "../../src/sieve/vacation.js";

describe("vacation Sieve script", () => {
  it("emits a vacation action when enabled", () => {
    const s = generateScript({
      isEnabled: true,
      subject: "Out of office",
      textBody: "Back next week.",
      fromDate: null,
      toDate: null,
      htmlBody: null,
    });
    expect(s).toContain('require ["vacation"];');
    expect(s).toContain("vacation");
    expect(s).toContain(":subject \"Out of office\"");
    expect(s).toContain("\"Back next week.\"");
  });

  it("preserves subject/text/html through markers when disabled", () => {
    // The disabled script still carries the user's last-edited fields so
    // re-enabling later doesn't blank them.
    const s = generateScript({
      isEnabled: false,
      subject: "S",
      textBody: "T",
      htmlBody: "<b>H</b>",
      fromDate: "2025-01-01T00:00:00Z",
      toDate: "2025-01-08T00:00:00Z",
    });
    expect(s).toContain("# bulwark-vacation: disabled");
    expect(s).not.toMatch(/^vacation\b/m);
    expect(s).toContain("# bulwark.subject=" + Buffer.from("S").toString("base64"));
    expect(s).toContain("# bulwark.text=" + Buffer.from("T").toString("base64"));
    expect(s).toContain("# bulwark.html=" + Buffer.from("<b>H</b>").toString("base64"));
    expect(s).toContain("# bulwark.from=" + Buffer.from("2025-01-01T00:00:00Z").toString("base64"));
    expect(s).toContain("# bulwark.to=" + Buffer.from("2025-01-08T00:00:00Z").toString("base64"));
  });

  it("escapes embedded quotes and backslashes in body", () => {
    const s = generateScript({
      isEnabled: true,
      textBody: 'He said "hi" \\ then left',
      subject: null,
      htmlBody: null,
      fromDate: null,
      toDate: null,
    });
    expect(s).toContain('"He said \\"hi\\" \\\\ then left"');
  });
});
