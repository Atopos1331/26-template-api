import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import {
  AcademicMeta,
  academicResponses,
  pageLimit,
  QuotaSchema,
  QuotaTrendResponse,
} from "../../http/academic-schemas.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { AcademicService } from "../../services/academic.js";
import { WatchingService } from "../../services/watching.js";

const WatchErrorResponse = Type.Object(
  { error: Type.Object({}, { additionalProperties: true }) },
  { additionalProperties: true },
);

const sections: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  const service = new AcademicService(fastify.mongo.db!, {
    structureTtlSeconds: opts.academicStructureTtlSeconds ?? 86400,
    quotaTtlSeconds: opts.academicQuotaTtlSeconds ?? 900,
    cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
    cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
  });
  const watching = new WatchingService(fastify.mongo.db!, {
    cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
    cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
    quotaTtlSeconds: opts.academicQuotaTtlSeconds ?? 900,
  });
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.get(
        "/:sectionId/quota",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "Get the latest section quota",
            params: Type.Object({ sectionId: Type.String() }),
            response: {
              ...academicResponses,
              200: Type.Object({ data: QuotaSchema, meta: AcademicMeta }),
            },
          },
        },
        async (request) => service.getQuota(request.params.sectionId),
      );
      protectedRoutes.get(
        "/:sectionId/quota/trends",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "Get bounded section quota history and trends",
            params: Type.Object({ sectionId: Type.String() }),
            querystring: Type.Object(
              {
                window: Type.Optional(
                  Type.Union([
                    Type.Literal("7d"),
                    Type.Literal("14d"),
                    Type.Literal("term"),
                  ]),
                ),
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: {
              ...academicResponses,
              200: QuotaTrendResponse,
            },
          },
        },
        async (request) =>
          service.getQuotaTrends(
            request.params.sectionId,
            request.query.window ?? "14d",
            pageLimit(request.query.limit),
            request.query.cursor,
          ),
      );
      protectedRoutes.post(
        "/:sectionId/watch",
        {
          schema: {
            tags: ["Watching"],
            security: [{ Auth: [] }],
            params: Type.Object({ sectionId: Type.String() }),
            body: Type.Object(
              {
                notificationPreference: Type.Optional(
                  Type.Union([Type.Literal("none"), Type.Literal("in_app")]),
                ),
              },
              { additionalProperties: false },
            ),
            response: {
              400: WatchErrorResponse,
              401: WatchErrorResponse,
              404: WatchErrorResponse,
              409: WatchErrorResponse,
              200: Type.Object({}, { additionalProperties: true }),
            },
          },
        },
        async (request) => ({
          data: await watching.createSectionWatch(
            request.user.username,
            request.params.sectionId,
            request.body.notificationPreference,
          ),
          meta: {},
        }),
      );
      protectedRoutes.delete(
        "/:sectionId/watch",
        {
          schema: {
            tags: ["Watching"],
            security: [{ Auth: [] }],
            params: Type.Object({ sectionId: Type.String() }),
            response: {
              400: WatchErrorResponse,
              401: WatchErrorResponse,
              404: WatchErrorResponse,
              409: WatchErrorResponse,
              204: Type.Null(),
            },
          },
        },
        async (request, reply) => {
          await watching.remove(
            request.user.username,
            "section",
            request.params.sectionId,
          );
          return reply.code(204).send(null);
        },
      );
    });
  });
};

export default sections;
