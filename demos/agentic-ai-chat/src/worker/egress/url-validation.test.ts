import { describe, expect, it } from "vitest";
import { validateUrlFloor } from "./url-validation";

describe("validateUrlFloor", () => {
  it("accepts an ordinary https URL, unchanged", () => {
    const result = validateUrlFloor(
      "https://developers.cloudflare.com/workers/",
    );
    expect(result).toEqual({
      ok: true,
      url: "https://developers.cloudflare.com/workers/",
    });
  });

  it("accepts an ordinary http URL", () => {
    const result = validateUrlFloor("http://example.com/");
    expect(result.ok).toBe(true);
  });

  it("rejects a value that does not parse as an absolute URL", () => {
    const result = validateUrlFloor("not a url");
    expect(result).toEqual({
      ok: false,
      error: '"not a url" is not a valid absolute URL.',
    });
  });

  it("rejects a relative path with no scheme/host", () => {
    const result = validateUrlFloor("/workers/");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    const result = validateUrlFloor("file:///etc/passwd");
    expect(result).toEqual({
      ok: false,
      error: 'The URL scheme must be http or https, not "file".',
    });
  });

  it("rejects a data: URL", () => {
    const result = validateUrlFloor("data:text/plain;base64,aGVsbG8=");
    expect(result.ok).toBe(false);
  });

  it.each([
    "http://localhost/",
    "http://LOCALHOST/",
    "http://0.0.0.0/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://[::1]/",
    "http://printer.local/",
    "http://db.internal/",
  ])("rejects the obviously-internal address %s", (raw) => {
    const result = validateUrlFloor(raw);
    expect(result.ok).toBe(false);
  });

  it("does not reject a public address that merely starts similarly to a private one", () => {
    // 172.32.x.x is outside the private 172.16.0.0/12 block -- a naive prefix check on "172."
    // alone would wrongly reject this.
    expect(validateUrlFloor("http://172.32.0.1/").ok).toBe(true);
    // 10 is a valid public TLD-adjacent-looking host component but not literally "10." prefixed
    // the way the private-range pattern requires.
    expect(validateUrlFloor("http://example.com/10.0.0.5").ok).toBe(true);
  });
});
