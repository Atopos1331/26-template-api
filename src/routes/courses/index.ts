import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { WatchingService } from "../../services/watching.js";

const ErrorResponse = Type.Object(
  { error: Type.Object({}, { additionalProperties: true }) },
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

function service(fastify: FastifyTypebox, opts: AppOptions) {
  return new WatchingService(fastify.mongo.db!, {
    cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
    cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
    quotaTtlSeconds: opts.academicQuotaTtlSeconds ?? 900,
  });
}

const courses: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.post(
        "/:courseId/watch",
        {
          schema: {
            ...common,
            params: Type.Object({ courseId: Type.String() }),
            querystring: Type.Object(
              { termCode: Type.String() },
              { additionalProperties: false },
            ),
            body: Type.Object(
              {
                notificationPreference: Type.Optional(
                  Type.Union([Type.Literal("none"), Type.Literal("in_app")]),
                ),
              },
              { additionalProperties: false },
            ),
            response: {
              ...common.response,
              200: Type.Object({}, { additionalProperties: true }),
            },
          },
        },
        async (request) => ({
          data: await service(fastify, opts).createCourseWatch(
            request.user.username,
            request.params.courseId,
            request.query.termCode,
            request.body.notificationPreference,
          ),
          meta: {},
        }),
      );
      protectedRoutes.delete(
        "/:courseId/watch",
        {
          schema: {
            ...common,
            params: Type.Object({ courseId: Type.String() }),
            querystring: Type.Object(
              { termCode: Type.String() },
              { additionalProperties: false },
            ),
            response: { ...common.response, 204: Type.Null() },
          },
        },
        async (request, reply) => {
          await service(fastify, opts).remove(
            request.user.username,
            "course",
            request.params.courseId,
            request.query.termCode,
          );
          return reply.code(204).send(null);
        },
      );
    });
  });
};

export default courses;
