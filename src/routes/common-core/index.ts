import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { PlanError } from "../../domain/plans.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { CommonCoreRepository } from "../../repositories/common-core.js";

const commonCore: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  const repository = new CommonCoreRepository(fastify.mongo.db!);
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.get(
        "/presets",
        {
          schema: {
            tags: ["Academic"],
            security: [{ Auth: [] }],
            summary: "List Common Core categories for an admission cohort",
            querystring: Type.Object(
              {
                admissionYear: Type.String(),
                termCode: Type.String(),
              },
              { additionalProperties: false },
            ),
            response: {
              200: Type.Object({}, { additionalProperties: true }),
              400: Type.Object({}, { additionalProperties: true }),
              401: Type.Object({}, { additionalProperties: true }),
              404: Type.Object({}, { additionalProperties: true }),
              503: Type.Object({}, { additionalProperties: true }),
            },
          },
        },
        async (request) => {
          if (!/^\d{4}$/.test(request.query.admissionYear))
            throw new PlanError(
              "invalid_request",
              400,
              "Invalid admissionYear",
            );
          return {
            data: await repository.presets(
              request.query.termCode,
              Number(request.query.admissionYear),
              new Date(),
              opts.commonCoreMaxAgeDays ?? 365,
            ),
            meta: {},
          };
        },
      );
    });
  });
};

export default commonCore;
