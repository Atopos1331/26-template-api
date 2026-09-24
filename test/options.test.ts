import { describe, expect, test } from "bun:test";
import { loadOptions } from "../src/options.js";

describe("loadOptions", () => {
  test("loads options from an explicit env object", () => {
    const options = loadOptions({
      MONGO_URI: "mongodb://localhost:27017/template-api-test",
      MONGO_TEST_URI: "mongodb://localhost:27018/template-api-test",
      AUTH_SKIP: "true",
    });

    expect(options.pluginTimeout).toBe(5 * 60 * 1000);
    expect(options.test).toBe(false);
    expect(options.mongoUri).toBe(
      "mongodb://localhost:27017/template-api-test",
    );
    expect(options.mongoTestUri).toBe(
      "mongodb://localhost:27018/template-api-test",
    );
    expect(options.authSkip).toBe(true);
  });

  test("parses AUTH_SKIP=false as false", () => {
    const options = loadOptions({ AUTH_SKIP: "false" });

    expect(options.authSkip).toBe(false);
  });

  test("blank mongo URIs count as unset", () => {
    // Candidates blank a variable in .env to "remove" it; the in-memory
    // fallback must kick in rather than crash startup.
    const options = loadOptions({
      MONGO_URI: "",
      MONGO_TEST_URI: "   ",
    });

    expect(options.mongoUri).toBeUndefined();
    expect(options.mongoTestUri).toBeUndefined();
  });

  test("leaves every option unset by default", () => {
    const options = loadOptions({});

    // The Mongo URIs are undefined when unset; init-mongo resolves the
    // default (production) or in-memory fallback at runtime.
    expect(options.mongoUri).toBeUndefined();
    expect(options.mongoTestUri).toBeUndefined();
    expect(options.authSkip).toBeUndefined();
  });

  test("loading with an empty env succeeds", () => {
    // There are no required environment variables; every option is optional.
    expect(() => loadOptions({})).not.toThrow();
  });

  test("uses the campus timezone when APP_TIMEZONE is unset", () => {
    expect(loadOptions({}).appTimezone).toBe("Asia/Hong_Kong");
  });

  test("validates the optional current term without guessing one", () => {
    expect(loadOptions({}).academicCurrentTermCode).toBeUndefined();
    expect(
      loadOptions({ ACADEMIC_CURRENT_TERM_CODE: " 2610 " })
        .academicCurrentTermCode,
    ).toBe("2610");
    expect(() =>
      loadOptions({ ACADEMIC_CURRENT_TERM_CODE: "2026-fall" }),
    ).toThrow("ACADEMIC_CURRENT_TERM_CODE");
  });

  test("accepts a supplied IANA timezone", () => {
    expect(loadOptions({ APP_TIMEZONE: " America/Chicago " }).appTimezone).toBe(
      "America/Chicago",
    );
  });

  test("rejects a blank or unknown APP_TIMEZONE without echoing its value", () => {
    for (const value of [" ", "Not/A_Real_Timezone"]) {
      try {
        loadOptions({ APP_TIMEZONE: value });
        throw new Error("Expected invalid timezone to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("ConfigurationError");
        expect((error as Error).message).toContain("APP_TIMEZONE");
        if (value.trim()) {
          expect((error as Error).message).not.toContain(value.trim());
        }
      }
    }
  });

  test("requires a stable cursor key in production", () => {
    expect(() => loadOptions({ NODE_ENV: "production" })).toThrow(
      "CURSOR_SIGNING_KEY",
    );
    expect(() => loadOptions({ CURSOR_SIGNING_KEY: "short" })).toThrow(
      "CURSOR_SIGNING_KEY",
    );
    const configured = loadOptions({
      NODE_ENV: "production",
      CURSOR_SIGNING_KEY: "x".repeat(32),
      AUTO_PLAN_TOKEN_SIGNING_KEY: "y".repeat(32),
      SHARE_TOKEN_REPLAY_ENCRYPTION_KEY: "z".repeat(32),
    });
    expect(configured.cursorSigningKey).toBe("x".repeat(32));
    expect(configured.autoPlanTokenSigningKey).toBe("y".repeat(32));
    expect(configured.shareTokenReplayEncryptionKey).toBe("z".repeat(32));
  });

  test("requires an independent auto-plan token key in production", () => {
    expect(() =>
      loadOptions({
        NODE_ENV: "production",
        CURSOR_SIGNING_KEY: "x".repeat(32),
        SHARE_TOKEN_REPLAY_ENCRYPTION_KEY: "z".repeat(32),
      }),
    ).toThrow("AUTO_PLAN_TOKEN_SIGNING_KEY");
    expect(() => loadOptions({ AUTO_PLAN_TOKEN_SIGNING_KEY: "short" })).toThrow(
      "AUTO_PLAN_TOKEN_SIGNING_KEY",
    );
  });

  test("requires a production share replay key and validates sharing limits", () => {
    expect(() =>
      loadOptions({
        NODE_ENV: "production",
        CURSOR_SIGNING_KEY: "x".repeat(32),
        AUTO_PLAN_TOKEN_SIGNING_KEY: "y".repeat(32),
      }),
    ).toThrow("SHARE_TOKEN_REPLAY_ENCRYPTION_KEY");
    expect(() =>
      loadOptions({ SHARE_TOKEN_REPLAY_ENCRYPTION_KEY: "short" }),
    ).toThrow("SHARE_TOKEN_REPLAY_ENCRYPTION_KEY");
    expect(() =>
      loadOptions({
        SHARE_DEFAULT_EXPIRY_SECONDS: "20",
        SHARE_MAX_EXPIRY_SECONDS: "10",
      }),
    ).toThrow("SHARE_DEFAULT_EXPIRY_SECONDS");
    for (const name of [
      "SHARE_DEFAULT_EXPIRY_SECONDS",
      "SHARE_MAX_EXPIRY_SECONDS",
      "SHARE_READS_PER_MINUTE",
      "DISCOVERABILITY_DEFAULT_EXPIRY_SECONDS",
      "DISCOVERABILITY_MAX_EXPIRY_SECONDS",
      "FRIEND_SEARCHES_PER_MINUTE",
    ]) {
      expect(() => loadOptions({ [name]: "0" })).toThrow(name);
      expect(() => loadOptions({ [name]: "1.5" })).toThrow(name);
    }
  });

  test("validates positive event retention and cursor limits", () => {
    for (const name of [
      "CURSOR_TTL_SECONDS",
      "RECURRENCE_MAX_SPAN_DAYS",
      "IDEMPOTENCY_RETENTION_SECONDS",
      "CALENDAR_MAX_WINDOW_DAYS",
      "CALENDAR_MAX_ITEMS",
      "CALENDAR_MAX_CONFLICTS",
      "TIME_BANNER_UPCOMING_HOURS",
      "AUTO_PLAN_TOKEN_TTL_SECONDS",
      "AUTO_PLAN_MAX_DESIRED_COURSES",
      "AUTO_PLAN_MAX_SELECTED_COURSES",
      "AUTO_PLAN_MAX_CANDIDATE_BUNDLES",
      "AUTO_PLAN_MAX_CANDIDATE_OCCURRENCES",
      "AUTO_PLAN_MAX_CONFLICT_EDGES",
      "AUTO_PLAN_MAX_HORIZON_DAYS",
      "AUTO_PLAN_MAX_REQUEST_BYTES",
      "AUTO_PLAN_MAX_OPTION_TOKEN_BYTES",
      "AUTO_PLAN_SOLVER_TIMEOUT_MS",
      "AUTO_PLAN_SOLVER_CONCURRENCY",
    ]) {
      expect(() => loadOptions({ [name]: "0" })).toThrow(name);
      expect(() => loadOptions({ [name]: "1.5" })).toThrow(name);
    }
  });

  test("loads calendar safety limits", () => {
    const options = loadOptions({
      CALENDAR_MAX_WINDOW_DAYS: "30",
      CALENDAR_MAX_ITEMS: "200",
      CALENDAR_MAX_CONFLICTS: "300",
      TIME_BANNER_UPCOMING_HOURS: "12",
    });
    expect(options.calendarMaxWindowDays).toBe(30);
    expect(options.calendarMaxItems).toBe(200);
    expect(options.calendarMaxConflicts).toBe(300);
    expect(options.timeBannerUpcomingHours).toBe(12);
  });
});
