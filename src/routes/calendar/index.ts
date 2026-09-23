import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { calendarWindow } from "../../domain/calendar.js";
import { EventError } from "../../domain/events.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { CourseCatalogRepository } from "../../repositories/course-catalog.js";
import { CoursePlanRepository } from "../../repositories/course-plans.js";
import { EventRepository } from "../../repositories/events.js";
import {
  CalendarService,
  CoursePlanCalendarSource,
  ManualCalendarSource,
} from "../../services/calendar.js";
import { CoursePlanService } from "../../services/course-plans.js";

const Occurrence = Type.Object(
  {
    calendarKey: Type.String(),
    source: Type.String(),
    sourceId: Type.String(),
    title: Type.String(),
    startsAt: Type.String(),
    endsAt: Type.String(),
    localStartsAt: Type.String(),
    localEndsAt: Type.String(),
    allDay: Type.Boolean(),
    timezone: Type.String(),
    blocksTime: Type.Boolean(),
    readonly: Type.Boolean(),
  },
  { additionalProperties: true },
);
const Conflict = Type.Object({
  firstCalendarKey: Type.String(),
  secondCalendarKey: Type.String(),
  severity: Type.Union([
    Type.Literal("blocking"),
    Type.Literal("informational"),
  ]),
  kind: Type.Union([Type.Literal("time_overlap"), Type.Literal("day_overlap")]),
  localDate: Type.String(),
  startTime: Type.Union([Type.String(), Type.Null()]),
  endTime: Type.Union([Type.String(), Type.Null()]),
  startsAt: Type.Union([Type.String(), Type.Null()]),
  endsAt: Type.Union([Type.String(), Type.Null()]),
});
const Meta = Type.Object({ warnings: Type.Array(Type.String()) });
const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    fields: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
});
const common = {
  tags: ["Calendar"],
  security: [{ Auth: [] }],
  response: { 400: ErrorResponse, 401: ErrorResponse },
};

function noUnsupportedOptions(
  query: Record<string, unknown>,
  allowed: string[],
) {
  for (const name of Object.keys(query)) {
    if (!allowed.includes(name)) {
      throw new EventError(
        "invalid_request",
        400,
        "Request validation failed",
        { [name]: "is not available for the manual calendar" },
      );
    }
  }
}

const calendar: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  const planService = () =>
    new CoursePlanService(
      new CoursePlanRepository(fastify.collections.coursePlans),
      new CourseCatalogRepository(fastify.mongo.db!),
      new EventRepository(fastify.collections.events),
      fastify.collections.idempotencyRecords,
      {
        timezone: opts.appTimezone ?? "Asia/Hong_Kong",
        cursorKey:
          opts.cursorSigningKey ?? "development-only-cursor-signing-key",
        cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
        autoPlanTokenKey:
          opts.autoPlanTokenSigningKey ??
          "development-only-auto-plan-token-key-32-bytes",
        autoPlanTokenTtlSeconds: opts.autoPlanTokenTtlSeconds ?? 600,
        autoPlanMaxTokenBytes: opts.autoPlanMaxOptionTokenBytes,
        autoPlanMaxDesiredCourses: opts.autoPlanMaxDesiredCourses,
        autoPlanMaxSelectedCourses: opts.autoPlanMaxSelectedCourses,
        autoPlanMaxCandidateBundles: opts.autoPlanMaxCandidateBundles,
        autoPlanMaxCandidateOccurrences: opts.autoPlanMaxCandidateOccurrences,
        autoPlanMaxConflictEdges: opts.autoPlanMaxConflictEdges,
        autoPlanMaxHorizonDays: opts.autoPlanMaxHorizonDays,
        autoPlanSolverTimeoutMs: opts.autoPlanSolverTimeoutMs,
        autoPlanSolverConcurrency: opts.autoPlanSolverConcurrency,
        autoPlanMaxRequestBytes: opts.autoPlanMaxRequestBytes,
        idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
        defaultTermCode: opts.academicCurrentTermCode,
      },
    );
  const service = (planId?: string, termCode?: string) => {
    const manual = new ManualCalendarSource(
      new EventRepository(fastify.collections.events),
    );
    const course = new CoursePlanCalendarSource(
      (owner, window, requestedPlanId, requestedTermCode) =>
        planService().calendarItems(
          owner,
          window,
          requestedPlanId,
          requestedTermCode,
        ),
      (owner, key) => planService().resolvesCalendarKey(owner, key),
      planId,
      termCode,
    );
    return new CalendarService(manual, [manual, course], {
      timezone: opts.appTimezone ?? "Asia/Hong_Kong",
      maxItems: opts.calendarMaxItems ?? 1000,
      maxConflicts: opts.calendarMaxConflicts ?? 10000,
      upcomingHours: opts.timeBannerUpcomingHours ?? 24,
    });
  };
  const timezone = opts.appTimezone ?? "Asia/Hong_Kong";
  const maxWindowDays = opts.calendarMaxWindowDays ?? 366;

  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      const querystring = Type.Object(
        {
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          termCode: Type.Optional(Type.String()),
          planId: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      );

      protectedRoutes.get(
        "/",
        {
          schema: {
            ...common,
            summary: "List calendar occurrences",
            querystring,
            response: {
              ...common.response,
              200: Type.Object({
                items: Type.Array(Occurrence),
                page: Type.Object({
                  nextCursor: Type.Null(),
                  hasMore: Type.Literal(false),
                }),
                meta: Meta,
              }),
            },
          },
        },
        async (request) => {
          noUnsupportedOptions(request.query, [
            "from",
            "to",
            "termCode",
            "planId",
          ]);
          const window = calendarWindow(
            request.query.from,
            request.query.to,
            timezone,
            maxWindowDays,
          );
          const calendarService = service(
            request.query.planId,
            request.query.termCode,
          );
          return {
            items: await calendarService.list(request.user.username, window),
            page: { nextCursor: null, hasMore: false as const },
            meta: {
              warnings: await planService().calendarWarnings(
                request.user.username,
                request.query.planId,
                request.query.termCode,
              ),
            },
          };
        },
      );

      protectedRoutes.get(
        "/conflicts",
        {
          schema: {
            ...common,
            summary: "Find calendar conflicts",
            querystring,
            response: {
              ...common.response,
              200: Type.Object({
                data: Type.Object({
                  blocking: Type.Array(Conflict),
                  informational: Type.Array(Conflict),
                }),
                meta: Meta,
              }),
            },
          },
        },
        async (request) => {
          noUnsupportedOptions(request.query, [
            "from",
            "to",
            "termCode",
            "planId",
          ]);
          const window = calendarWindow(
            request.query.from,
            request.query.to,
            timezone,
            maxWindowDays,
          );
          const calendarService = service(
            request.query.planId,
            request.query.termCode,
          );
          return {
            data: await calendarService.conflicts(
              request.user.username,
              window,
            ),
            meta: {
              warnings: await planService().calendarWarnings(
                request.user.username,
                request.query.planId,
                request.query.termCode,
              ),
            },
          };
        },
      );

      protectedRoutes.get(
        "/banner",
        {
          schema: {
            ...common,
            summary: "Read the Time Banner",
            querystring: Type.Object(
              {
                termCode: Type.Optional(Type.String()),
                planId: Type.Optional(Type.String()),
              },
              { additionalProperties: true },
            ),
            response: {
              ...common.response,
              200: Type.Object({
                data: Type.Object({
                  state: Type.Union([
                    Type.Literal("current"),
                    Type.Literal("upcoming"),
                    Type.Literal("free"),
                  ]),
                  item: Type.Union([Occurrence, Type.Null()]),
                  minutesRemaining: Type.Union([Type.Number(), Type.Null()]),
                  minutesUntilStart: Type.Union([Type.Number(), Type.Null()]),
                  evaluatedAt: Type.String(),
                }),
                meta: Meta,
              }),
            },
          },
        },
        async (request) => {
          noUnsupportedOptions(request.query, ["termCode", "planId"]);
          const calendarService = service(
            request.query.planId,
            request.query.termCode,
          );
          return {
            data: await calendarService.banner(request.user.username),
            meta: {
              warnings: await planService().calendarWarnings(
                request.user.username,
                request.query.planId,
                request.query.termCode,
              ),
            },
          };
        },
      );
    });
  });
};

export default calendar;
