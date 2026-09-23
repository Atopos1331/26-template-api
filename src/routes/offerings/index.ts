import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import {
  AcademicMeta,
  academicResponses,
  BundleSchema,
  OfferingSchema,
  PageSchema,
} from "../../http/academic-schemas.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { AcademicService } from "../../services/academic.js";

const offerings: FastifyPluginAsync<AppOptions> = async (
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
      const params = Type.Object({ offeringId: Type.String() });
      protectedRoutes.get(
        "/:offeringId",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "Get an offering and its sections",
            params,
            response: {
              ...academicResponses,
              200: Type.Object({ data: OfferingSchema, meta: AcademicMeta }),
            },
          },
        },
        async (request) => service.getOffering(request.params.offeringId),
      );
      protectedRoutes.get(
        "/:offeringId/bundles",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "List selectable section bundles",
            params,
            response: {
              ...academicResponses,
              200: Type.Object({
                items: Type.Array(BundleSchema),
                page: PageSchema,
                meta: AcademicMeta,
              }),
            },
          },
        },
        async (request) => service.listBundles(request.params.offeringId),
      );
    });
  });
};

export default offerings;
