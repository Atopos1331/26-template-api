import { describe, expect, test } from "bun:test";
import { formatRevisionEtag, parseIfMatch } from "../src/domain/revision.js";

describe("revision headers", () => {
  test("formats a positive revision as a strong ETag", () => {
    expect(formatRevisionEtag(12)).toBe('"12"');
  });

  test("rejects invalid revisions before formatting", () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatRevisionEtag(revision)).toThrow(RangeError);
    }
  });

  test("parses a quoted positive If-Match revision", () => {
    expect(parseIfMatch(' "12" ')).toBe(12);
  });

  test("reports a missing If-Match as a required precondition", () => {
    try {
      parseIfMatch(undefined);
      throw new Error("Expected a missing header to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "precondition_required",
        statusCode: 428,
      });
    }
  });

  test("rejects weak, wildcard, multiple, and invalid revision tags", () => {
    for (const header of [
      'W/"12"',
      "*",
      '"12", "13"',
      '"0"',
      '"01"',
      '"1.5"',
      '"9007199254740992"',
      ['"12"', '"13"'],
    ]) {
      try {
        parseIfMatch(header);
        throw new Error("Expected an invalid header to fail");
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid_request",
          statusCode: 400,
        });
      }
    }
  });
});
