import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { PlanError } from "../../domain/plans.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { WatchingService } from "../../services/watching.js";

const ErrorResponse = Type.Object(
  { error: Type.Object({}, { additionalProperties: true }) },
  { additionalProperties: true },
);
const ListResponse = Type.Object(
  {
    items: Type.Array(Type.Object({}, { additionalProperties: true })),
    page: Type.Object({
      nextCursor: Type.Union([Type.String(), Type.Null()]),
      hasMore: Type.Boolean(),
    }),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const common = {
  tags: ["Watching"],
  security: [{ Auth: [] }],
  response: {
    400: ErrorResponse,
    401: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
  },
};

function limit(value: string | undefined) {
  if (value === undefined) return 50;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100)
    throw new PlanError("invalid_request", 400, "Invalid limit", {
      limit: "must be an integer from 1 to 100",
    });
  return Number(value);
}

function booleanQuery(value: string | undefined, field: string) {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new PlanError("invalid_request", 400, `Invalid ${field}`, {
    [field]: "must be true or false",
  });
}

function service(fastify: FastifyTypebox, opts: AppOptions) {
  return new WatchingService(fastify.mongo.db!, {
    cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
    cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
    quotaTtlSeconds: opts.academicQuotaTtlSeconds ?? 900,
  });
}

const watching: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.get(
        "/",
        {
          schema: {
            ...common,
            querystring: Type.Object(
              {
                termCode: Type.Optional(Type.String()),
                targetType: Type.Optional(
                  Type.Union([Type.Literal("course"), Type.Literal("section")]),
                ),
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: { ...common.response, 200: ListResponse },
          },
        },
        async (request) =>
          service(fastify, opts).list(request.user.username, {
            ...request.query,
            limit: limit(request.query.limit),
          }),
      );
      protectedRoutes.get(
        "/notifications",
        {
          schema: {
            ...common,
            querystring: Type.Object(
              {
                unreadOnly: Type.Optional(Type.String()),
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: { ...common.response, 200: ListResponse },
          },
        },
        async (request) =>
          service(fastify, opts).notifications(request.user.username, {
            unreadOnly: booleanQuery(request.query.unreadOnly, "unreadOnly"),
            limit: limit(request.query.limit),
            cursor: request.query.cursor,
          }),
      );
      protectedRoutes.patch(
        "/notifications/:notificationId",
        {
          schema: {
            ...common,
            params: Type.Object({ notificationId: Type.String() }),
            body: Type.Object(
              { read: Type.Literal(true) },
              { additionalProperties: false },
            ),
            response: {
              ...common.response,
              200: Type.Object({}, { additionalProperties: true }),
            },
          },
        },
        async (request) => ({
          data: await service(fastify, opts).acknowledge(
            request.user.username,
            request.params.notificationId,
          ),
          meta: {},
        }),
      );
    });
  });
};

export default watching;
