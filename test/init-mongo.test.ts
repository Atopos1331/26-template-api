// Pins the URI-defaulting rules for MongoDB connection strings: the database
// name is appended only when missing, query parameters survive, and invalid
// URIs fail here with a clear message instead of at driver connect time.

import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  resolveMongoUri,
  withDefaultMongoDatabase,
} from "../src/plugins/init-mongo.js";

describe("withDefaultMongoDatabase", () => {
  test("appends the database name when none is present", () => {
    expect(
      withDefaultMongoDatabase("mongodb://localhost:27018", "template-api"),
    ).toBe("mongodb://localhost:27018/template-api");
  });

  test("keeps an explicitly named database unchanged", () => {
    expect(
      withDefaultMongoDatabase(
        "mongodb://localhost:27018/other",
        "template-api",
      ),
    ).toBe("mongodb://localhost:27018/other");
  });

  test("preserves query parameters while defaulting the database", () => {
    expect(
      withDefaultMongoDatabase("mongodb://localhost:27018/?tls=true", "db"),
    ).toBe("mongodb://localhost:27018/db?tls=true");
  });

  test("defaults the authSource for credentials without a database", () => {
    const uri = withDefaultMongoDatabase(
      "mongodb://user:pass@localhost:27018",
      "db",
    );
    const parsed = new URL(uri);
    expect(parsed.username).toBe("user");
    expect(parsed.searchParams.get("authSource")).toBe("admin");
  });

  test("rejects scheme-less URIs instead of failing at connect time", () => {
    expect(() => withDefaultMongoDatabase("localhost:27018", "db")).toThrow(
      "Invalid MongoDB URI",
    );
  });

  test("invalid MongoDB URI errors do not expose credentials", () => {
    const secret = "do-not-log-this";
    for (const uri of [
      `http://user:${secret}@localhost:27018/db`,
      `mongodb://user:${secret}@/db`,
    ]) {
      try {
        withDefaultMongoDatabase(uri, "db");
        throw new Error("Expected an invalid MongoDB URI");
      } catch (error) {
        expect((error as Error).message).toContain("Invalid MongoDB URI");
        expect((error as Error).message).not.toContain(secret);
        expect(String((error as Error).cause ?? "")).not.toContain(secret);
      }
    }
  });

  test("test mode selects the test URI, not the application URI", async () => {
    const app = Fastify();
    try {
      expect(
        await resolveMongoUri(app, "template-api", {
          test: true,
          mongoUri: "mongodb://localhost:27018/app",
          mongoTestUri: "mongodb://localhost:27018/template-api-test",
        }),
      ).toBe("mongodb://localhost:27018/template-api-test");
    } finally {
      await app.close();
    }
  });
});
