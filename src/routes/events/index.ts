import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { optionalCalendarWindow } from "../../domain/calendar.js";
import { EventError, eventResponse } from "../../domain/events.js";
import { formatRevisionEtag, parseIfMatch } from "../../domain/revision.js";
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
import { EventService } from "../../services/events.js";

const EventInput = Type.Object(
  {
    title: Type.String(),
    description: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    startsAt: Type.Optional(Type.String()),
    endsAt: Type.Optional(Type.String()),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    allDay: Type.Optional(Type.Boolean()),
    timezone: Type.Optional(Type.String()),
    color: Type.Optional(Type.String()),
    recurrence: Type.Optional(
      Type.Object(
        {
          frequency: Type.String(),
          interval: Type.Number(),
          weekdays: Type.Array(Type.String()),
          until: Type.String(),
        },
        { additionalProperties: true },
      ),
    ),
    sourceName: Type.Optional(Type.String()),
    externalId: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    blocksTime: Type.Optional(Type.Boolean()),
    supersedesCalendarKey: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const PatchInput = Type.Omit(Type.Partial(EventInput), [
  "sourceName",
  "externalId",
]);

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    fields: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
});
const EventResponse = Type.Object({
  data: Type.Object(
    {
      id: Type.String(),
      title: Type.String(),
      startsAt: Type.String(),
      endsAt: Type.String(),
      allDay: Type.Boolean(),
      timezone: Type.String(),
      source: Type.String(),
      readonly: Type.Boolean(),
      blocksTime: Type.Boolean(),
      revision: Type.Number(),
    },
    { additionalProperties: true },
  ),
  meta: Type.Object({}, { additionalProperties: true }),
});
const ListResponse = Type.Object({
  items: Type.Array(EventResponse.properties.data),
  page: Type.Object({
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
  meta: Type.Object({}, { additionalProperties: true }),
});
const common = {
  tags: ["Events"],
  security: [{ Auth: [] }],
  response: {
    400: ErrorResponse,
    401: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
    428: ErrorResponse,
  },
};

const events: FastifyPluginAsync<AppOptions> = async (
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
  const calendar = () => {
    const manual = new ManualCalendarSource(
      new EventRepository(fastify.collections.events),
    );
    const course = new CoursePlanCalendarSource(
      (owner, window, planId, termCode) =>
        planService().calendarItems(owner, window, planId, termCode),
      (owner, key) => planService().resolvesCalendarKey(owner, key),
    );
    return new CalendarService(manual, [manual, course], {
      timezone: opts.appTimezone ?? "Asia/Hong_Kong",
      maxItems: opts.calendarMaxItems ?? 1000,
      maxConflicts: opts.calendarMaxConflicts ?? 10000,
      upcomingHours: opts.timeBannerUpcomingHours ?? 24,
    });
  };
  const service = () =>
    new EventService(
      new EventRepository(fastify.collections.events),
      fastify.collections.idempotencyRecords,
      {
        timezone: opts.appTimezone ?? "Asia/Hong_Kong",
        maxSpanDays: opts.recurrenceMaxSpanDays ?? 1461,
        cursorKey:
          opts.cursorSigningKey ?? "development-only-cursor-signing-key",
        cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
        idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
      },
      (owner, key) => calendar().canSupersede(owner, key),
    );

  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);

      protectedRoutes.post(
        "/",
        {
          schema: {
            ...common,
            summary: "Create an event",
            body: EventInput,
            response: {
              ...common.response,
              200: EventResponse,
              201: EventResponse,
            },
          },
        },
        async (request, reply) => {
          const result = await service().create(
            request.user.username,
            request.body,
            request.headers["idempotency-key"],
          );
          reply.header("ETag", formatRevisionEtag(result.body.data.revision));
          return reply.code(result.status).send(result.body);
        },
      );

      protectedRoutes.get(
        "/",
        {
          schema: {
            ...common,
            summary: "List stored events",
            querystring: Type.Object(
              {
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
                source: Type.Optional(Type.String()),
                eventType: Type.Optional(Type.String()),
                readonly: Type.Optional(Type.String()),
                from: Type.Optional(Type.String()),
                to: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: { ...common.response, 200: ListResponse },
          },
        },
        async (request) => {
          const query = request.query;
          const limit = query.limit === undefined ? 50 : Number(query.limit);
          if (
            query.limit !== undefined &&
            (!/^[1-9]\d*$/.test(query.limit) ||
              !Number.isInteger(limit) ||
              limit > 100)
          ) {
            throw new EventError(
              "invalid_request",
              400,
              "Request validation failed",
              { limit: "must be an integer from 1 to 100" },
            );
          }
          if (
            query.eventType !== undefined &&
            !["class", "exam", "deadline", "reminder", "other"].includes(
              query.eventType,
            )
          ) {
            throw new EventError(
              "invalid_request",
              400,
              "Request validation failed",
              { eventType: "is not supported" },
            );
          }
          if (
            query.readonly !== undefined &&
            !["true", "false"].includes(query.readonly)
          ) {
            throw new EventError(
              "invalid_request",
              400,
              "Request validation failed",
              { readonly: "must be true or false" },
            );
          }
          if (
            query.source !== undefined &&
            (query.source.length < 1 || query.source.length > 64)
          ) {
            throw new EventError(
              "invalid_request",
              400,
              "Request validation failed",
              { source: "must be 1..64 characters" },
            );
          }
          return service().list(
            request.user.username,
            {
              ...(query.source === undefined ? {} : { source: query.source }),
              ...(query.eventType === undefined
                ? {}
                : {
                    eventType: query.eventType as
                      | "class"
                      | "exam"
                      | "deadline"
                      | "reminder"
                      | "other",
                  }),
              ...(query.readonly === undefined
                ? {}
                : { readonly: query.readonly === "true" }),
              ...(query.from === undefined && query.to === undefined
                ? {}
                : {
                    window: optionalCalendarWindow(
                      query.from,
                      query.to,
                      opts.appTimezone ?? "Asia/Hong_Kong",
                      opts.calendarMaxWindowDays ?? 366,
                    ),
                  }),
            },
            limit,
            query.cursor,
          );
        },
      );

      const params = Type.Object({ id: Type.String() });
      protectedRoutes.get(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Get an event",
            params,
            response: { ...common.response, 200: EventResponse },
          },
        },
        async (request, reply) => {
          const event = await service().get(
            request.user.username,
            request.params.id,
          );
          reply.header("ETag", formatRevisionEtag(event.revision));
          return { data: eventResponse(event), meta: {} };
        },
      );

      protectedRoutes.patch(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Update an event",
            params,
            body: PatchInput,
            response: { ...common.response, 200: EventResponse },
          },
        },
        async (request, reply) => {
          const revision = parseIfMatch(request.headers["if-match"]);
          const event = await service().patch(
            request.user.username,
            request.params.id,
            revision,
            request.body,
          );
          reply.header("ETag", formatRevisionEtag(event.revision));
          return { data: eventResponse(event), meta: {} };
        },
      );

      protectedRoutes.delete(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Delete an event",
            params,
            response: { ...common.response, 204: Type.Null() },
          },
        },
        async (request, reply) => {
          const revision = parseIfMatch(request.headers["if-match"]);
          reply.header(
            "ETag",
            await service().remove(
              request.user.username,
              request.params.id,
              revision,
            ),
          );
          return reply.code(204).send(null);
        },
      );
    });
  });
};

export default events;
