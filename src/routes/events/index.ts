import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { EventError, eventResponse } from "../../domain/events.js";
import {
  formatRevisionEtag,
  parseIfMatch,
  RevisionHeaderError,
} from "../../domain/revision.js";
import type { AppOptions } from "../../options.js";
import {
  AuthorizationHeaderError,
  UnauthorizedError,
} from "../../plugins/auth.js";
import { EventRepository } from "../../repositories/events.js";
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
    );

  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler((error, request, reply) => {
        let status = 500;
        let code = "internal_error";
        let message = "Internal server error";
        let fields: Record<string, string> | undefined;
        if (
          error instanceof EventError ||
          error instanceof RevisionHeaderError
        ) {
          status = error.statusCode;
          code = error.code;
          message = error.message;
          if (error instanceof EventError) fields = error.fields;
        } else if (
          error instanceof UnauthorizedError ||
          error instanceof AuthorizationHeaderError
        ) {
          status = error.statusCode;
          code = status === 401 ? "unauthorized" : "invalid_request";
          message =
            status === 401
              ? "Authentication required"
              : "Invalid Authorization header";
        } else if (
          error instanceof Error &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode < 500
        ) {
          status = error.statusCode;
          code = "invalid_request";
          message = "Request validation failed";
        } else {
          request.log.error(error);
        }
        const body = {
          error: {
            code,
            message,
            ...(fields ? { fields } : {}),
            requestId: request.id,
          },
        };
        return reply
          .code(status)
          .header("content-type", "application/json; charset=utf-8")
          .send(JSON.stringify(body));
      });

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
