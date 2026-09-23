import { randomBytes } from "node:crypto";
import type { AutoloadPluginOptions } from "@fastify/autoload";
import type { FastifyServerOptions } from "fastify";
import type { AuthPluginOptions } from "./plugins/auth.js";
import type { InitMongoPluginOptions } from "./plugins/init-mongo.js";

export type Env = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  constructor(envName: string) {
    super(`Invalid configuration: ${envName}`);
    this.name = "ConfigurationError";
  }
}

function applicationTimezone(env: Env): string {
  const configured = env.APP_TIMEZONE;
  if (configured === undefined) return "Asia/Hong_Kong";

  const timezone = configured.trim();
  if (!timezone) throw new ConfigurationError("APP_TIMEZONE");

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ConfigurationError("APP_TIMEZONE");
  }

  return timezone;
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new ConfigurationError(name);
  }
  return parsed;
}

function cursorSigningKey(env: Env): string {
  const value = env.CURSOR_SIGNING_KEY;
  if (value !== undefined) {
    if (Buffer.byteLength(value) < 32) {
      throw new ConfigurationError("CURSOR_SIGNING_KEY");
    }
    return value;
  }
  if (env.NODE_ENV === "production") {
    throw new ConfigurationError("CURSOR_SIGNING_KEY");
  }
  return randomBytes(32).toString("base64url");
}

function autoPlanTokenSigningKey(env: Env): string {
  const value = env.AUTO_PLAN_TOKEN_SIGNING_KEY;
  if (value !== undefined) {
    if (Buffer.byteLength(value) < 32) {
      throw new ConfigurationError("AUTO_PLAN_TOKEN_SIGNING_KEY");
    }
    return value;
  }
  if (env.NODE_ENV === "production") {
    throw new ConfigurationError("AUTO_PLAN_TOKEN_SIGNING_KEY");
  }
  return randomBytes(32).toString("base64url");
}

type OptionArgs = {
  env: Env;
  envName: string;
  required: boolean;
};

function optionArgs(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required = true,
): OptionArgs {
  if (typeof envOrEnvName === "string") {
    return {
      env: Bun.env,
      envName: envOrEnvName,
      required:
        typeof envNameOrRequired === "boolean" ? envNameOrRequired : required,
    };
  }

  if (typeof envNameOrRequired !== "string") {
    throw new Error("Environment variable name is required");
  }

  return { env: envOrEnvName, envName: envNameOrRequired, required };
}

export type GetOption = {
  (envName: string): string;
  (envName: string, required: true): string;
  (envName: string, required: false): string | undefined;
  (envName: string, required: boolean): string | undefined;
  (env: Env, envName: string): string;
  (env: Env, envName: string, required: true): string;
  (env: Env, envName: string, required: false): string | undefined;
  (env: Env, envName: string, required: boolean): string | undefined;
};

export const getOption = function getOption(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required: boolean = true,
): string | undefined {
  const args = optionArgs(envOrEnvName, envNameOrRequired, required);
  const env = args.env[args.envName];
  if (env === undefined && args.required) {
    throw new Error(`Missing required environment variable: ${args.envName}`);
  }
  return env;
} as GetOption;

export type GetBooleanOption = {
  (envName: string): boolean | undefined;
  (envName: string, required: true): boolean | undefined;
  (envName: string, required: false): boolean | undefined;
  (envName: string, required: boolean): boolean | undefined;
  (env: Env, envName: string): boolean | undefined;
  (env: Env, envName: string, required: true): boolean | undefined;
  (env: Env, envName: string, required: false): boolean | undefined;
  (env: Env, envName: string, required: boolean): boolean | undefined;
};

export const getBooleanOption = function getBooleanOption(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required: boolean = true,
): boolean | undefined {
  const args = optionArgs(envOrEnvName, envNameOrRequired, required);
  const val = getOption(args.env, args.envName, args.required);
  if (val === undefined) return undefined;
  const normalized = val.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return undefined;
} as GetBooleanOption;

export function lazyOptions<T extends object>(loadOptions: () => T): T {
  let options: T | undefined;
  const getOptions = () => {
    options ??= loadOptions();
    return options;
  };

  return new Proxy({} as T, {
    get(_target, property) {
      return Reflect.get(getOptions(), property);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        getOptions(),
        property,
      );
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(getOptions());
    },
    has(_target, property) {
      return property in getOptions();
    },
    ownKeys() {
      return Reflect.ownKeys(getOptions());
    },
    set(_target, property, value) {
      return Reflect.set(getOptions(), property, value);
    },
  });
}

export type AppOptions = {
  // Place your custom options for app below here.
  // Optional: Are we in tests?
  test?: boolean;
  appTimezone?: string;
  cursorSigningKey?: string;
  cursorTtlSeconds?: number;
  autoPlanTokenSigningKey?: string;
  autoPlanTokenTtlSeconds?: number;
  autoPlanMaxDesiredCourses?: number;
  autoPlanMaxSelectedCourses?: number;
  autoPlanMaxCandidateBundles?: number;
  autoPlanMaxCandidateOccurrences?: number;
  autoPlanMaxConflictEdges?: number;
  autoPlanMaxHorizonDays?: number;
  autoPlanMaxRequestBytes?: number;
  autoPlanMaxOptionTokenBytes?: number;
  autoPlanSolverTimeoutMs?: number;
  autoPlanSolverConcurrency?: number;
  recurrenceMaxSpanDays?: number;
  idempotencyRetentionSeconds?: number;
  calendarMaxWindowDays?: number;
  calendarMaxItems?: number;
  calendarMaxConflicts?: number;
  timeBannerUpcomingHours?: number;
  academicStructureTtlSeconds?: number;
  academicCurrentTermCode?: string;
  academicQuotaTtlSeconds?: number;
  academicQuotaMinIntervalSeconds?: number;
  academicQuotaMaxJobsPerPoll?: number;
  refreshFailureCooldownSeconds?: number;
  refreshMaxAttempts?: number;
  refreshLeaseSeconds?: number;
  academicProviderBaseUrl?: string;
  commonCoreMaxAgeDays?: number;
} & FastifyServerOptions &
  Partial<AutoloadPluginOptions> &
  InitMongoPluginOptions &
  AuthPluginOptions;

export function loadOptions(env: Env = Bun.env): AppOptions {
  const currentTerm = env.ACADEMIC_CURRENT_TERM_CODE?.trim();
  if (currentTerm && !/^\d{2}(10|20|30|40)$/.test(currentTerm))
    throw new ConfigurationError("ACADEMIC_CURRENT_TERM_CODE");
  const options: AppOptions = {
    // Launching lots of services on the server,
    // especially at the same time by something such as docker compose up,
    // leads to slow startups.
    // This increases the timeout for plugins to 5 minutes.
    pluginTimeout: 5 * 60 * 1000,

    test: false,
    // Blank values count as unset: people blank a variable in .env to
    // "remove" it, and the in-memory fallback should kick in rather than
    // crash startup.
    mongoUri: getOption(env, "MONGO_URI", false)?.trim() || undefined,
    mongoTestUri: getOption(env, "MONGO_TEST_URI", false)?.trim() || undefined,
    authSkip: getBooleanOption(env, "AUTH_SKIP", false),
    appTimezone: applicationTimezone(env),
    cursorSigningKey: cursorSigningKey(env),
    cursorTtlSeconds: positiveInteger(env, "CURSOR_TTL_SECONDS", 900),
    autoPlanTokenSigningKey: autoPlanTokenSigningKey(env),
    autoPlanTokenTtlSeconds: positiveInteger(
      env,
      "AUTO_PLAN_TOKEN_TTL_SECONDS",
      600,
    ),
    autoPlanMaxDesiredCourses: positiveInteger(
      env,
      "AUTO_PLAN_MAX_DESIRED_COURSES",
      20,
    ),
    autoPlanMaxSelectedCourses: positiveInteger(
      env,
      "AUTO_PLAN_MAX_SELECTED_COURSES",
      12,
    ),
    autoPlanMaxCandidateBundles: positiveInteger(
      env,
      "AUTO_PLAN_MAX_CANDIDATE_BUNDLES",
      600,
    ),
    autoPlanMaxCandidateOccurrences: positiveInteger(
      env,
      "AUTO_PLAN_MAX_CANDIDATE_OCCURRENCES",
      50_000,
    ),
    autoPlanMaxConflictEdges: positiveInteger(
      env,
      "AUTO_PLAN_MAX_CONFLICT_EDGES",
      100_000,
    ),
    autoPlanMaxHorizonDays: positiveInteger(
      env,
      "AUTO_PLAN_MAX_HORIZON_DAYS",
      240,
    ),
    autoPlanMaxRequestBytes: positiveInteger(
      env,
      "AUTO_PLAN_MAX_REQUEST_BYTES",
      32_768,
    ),
    autoPlanMaxOptionTokenBytes: positiveInteger(
      env,
      "AUTO_PLAN_MAX_OPTION_TOKEN_BYTES",
      131_072,
    ),
    autoPlanSolverTimeoutMs: positiveInteger(
      env,
      "AUTO_PLAN_SOLVER_TIMEOUT_MS",
      8_000,
    ),
    autoPlanSolverConcurrency: positiveInteger(
      env,
      "AUTO_PLAN_SOLVER_CONCURRENCY",
      2,
    ),
    recurrenceMaxSpanDays: positiveInteger(
      env,
      "RECURRENCE_MAX_SPAN_DAYS",
      1461,
    ),
    idempotencyRetentionSeconds: positiveInteger(
      env,
      "IDEMPOTENCY_RETENTION_SECONDS",
      86400,
    ),
    calendarMaxWindowDays: positiveInteger(
      env,
      "CALENDAR_MAX_WINDOW_DAYS",
      366,
    ),
    calendarMaxItems: positiveInteger(env, "CALENDAR_MAX_ITEMS", 1000),
    calendarMaxConflicts: positiveInteger(env, "CALENDAR_MAX_CONFLICTS", 10000),
    timeBannerUpcomingHours: positiveInteger(
      env,
      "TIME_BANNER_UPCOMING_HOURS",
      24,
    ),
    academicStructureTtlSeconds: positiveInteger(
      env,
      "ACADEMIC_STRUCTURE_TTL_SECONDS",
      86400,
    ),
    academicCurrentTermCode: currentTerm || undefined,
    academicQuotaTtlSeconds: positiveInteger(
      env,
      "ACADEMIC_QUOTA_TTL_SECONDS",
      900,
    ),
    academicQuotaMinIntervalSeconds: positiveInteger(
      env,
      "ACADEMIC_QUOTA_MIN_INTERVAL_SECONDS",
      300,
    ),
    academicQuotaMaxJobsPerPoll: positiveInteger(
      env,
      "ACADEMIC_QUOTA_MAX_JOBS_PER_POLL",
      100,
    ),
    refreshFailureCooldownSeconds: positiveInteger(
      env,
      "REFRESH_FAILURE_COOLDOWN_SECONDS",
      3600,
    ),
    refreshMaxAttempts: positiveInteger(env, "REFRESH_MAX_ATTEMPTS", 3),
    refreshLeaseSeconds: positiveInteger(env, "REFRESH_LEASE_SECONDS", 60),
    academicProviderBaseUrl:
      env.ACADEMIC_PROVIDER_BASE_URL?.trim() ||
      "https://w5.ab.ust.hk/wcq/cgi-bin",
    commonCoreMaxAgeDays: positiveInteger(env, "COMMON_CORE_MAX_AGE_DAYS", 365),
  };

  return options;
}

// Pass --options via CLI arguments in command to enable these options.
export const options: AppOptions = lazyOptions(() => loadOptions());
