import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import {
  AcademicMeta,
  academicResponses,
  CourseSummarySchema,
  courseFilters,
  PageSchema,
  pageLimit,
  TermSchema,
} from "../../http/academic-schemas.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { AcademicService } from "../../services/academic.js";

const terms: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  const service = new AcademicService(fastify.mongo.db!, {
    structureTtlSeconds: opts.academicStructureTtlSeconds ?? 86400,
    currentTermCode: opts.academicCurrentTermCode,
    quotaTtlSeconds: opts.academicQuotaTtlSeconds ?? 900,
    cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
    cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
  });
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.get(
        "/",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "List academic terms",
            querystring: Type.Object(
              {
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: {
              ...academicResponses,
              200: Type.Object({
                items: Type.Array(TermSchema),
                page: PageSchema,
                meta: AcademicMeta,
              }),
            },
          },
        },
        async (request) =>
          service.listTerms(
            pageLimit(request.query.limit),
            request.query.cursor,
          ),
      );
      protectedRoutes.get(
        "/:termCode/courses",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "List course offerings in a term",
            params: Type.Object({ termCode: Type.String() }),
            querystring: Type.Object(
              {
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
                search: Type.Optional(Type.String()),
                subject: Type.Optional(Type.String()),
                catalogNumber: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: {
              ...academicResponses,
              200: Type.Object({
                items: Type.Array(CourseSummarySchema),
                page: PageSchema,
                meta: AcademicMeta,
              }),
            },
          },
        },
        async (request) =>
          service.listCourses(request.params.termCode, {
            limit: pageLimit(request.query.limit),
            cursor: request.query.cursor,
            ...courseFilters(request.query),
          }),
      );
    });
  });
};

export default terms;
