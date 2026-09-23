import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import {
  AcademicMeta,
  academicResponses,
  QuotaSchema,
} from "../../http/academic-schemas.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { AcademicService } from "../../services/academic.js";

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
    });
  });
};

export default sections;
