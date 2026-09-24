import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { CourseCatalogRepository } from "../../repositories/course-catalog.js";
import { SharingService } from "../../services/sharing.js";

const sharedPlans: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  let instance: SharingService | undefined;
  const service = () =>
    (instance ??= new SharingService(
      fastify.mongo.db!,
      fastify.collections.coursePlans,
      fastify.collections.sharedPlans,
      fastify.collections.idempotencyRecords,
      new CourseCatalogRepository(fastify.mongo.db!),
      {
        defaultExpirySeconds: opts.shareDefaultExpirySeconds ?? 604800,
        maxExpirySeconds: opts.shareMaxExpirySeconds ?? 2592000,
        discoverabilityDefaultExpirySeconds:
          opts.discoverabilityDefaultExpirySeconds ?? 1209600,
        discoverabilityMaxExpirySeconds:
          opts.discoverabilityMaxExpirySeconds ?? 7776000,
        replayKey:
          opts.shareTokenReplayEncryptionKey ??
          "development-only-share-replay-key-32-bytes",
        cursorKey:
          opts.cursorSigningKey ?? "development-only-cursor-signing-key",
        cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
        shareReadsPerMinute: opts.shareReadsPerMinute ?? 60,
        friendSearchesPerMinute: opts.friendSearchesPerMinute ?? 30,
        idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
      },
    ));

  fastify.setErrorHandler(sendApiError);
  fastify.get(
    "/:shareToken",
    {
      logLevel: "silent",
      schema: {
        tags: ["Planning"],
        summary: "Read a shared plan snapshot",
        params: Type.Object({ shareToken: Type.String() }),
        response: {
          200: Type.Object({
            data: Type.Object({}, { additionalProperties: true }),
            meta: Type.Object({}, { additionalProperties: true }),
          }),
          400: Type.Object({
            error: Type.Object({}, { additionalProperties: true }),
          }),
          404: Type.Object({
            error: Type.Object({}, { additionalProperties: true }),
          }),
          429: Type.Object({
            error: Type.Object({}, { additionalProperties: true }),
          }),
        },
      },
    },
    async (request) => ({
      data: await service().read(request.params.shareToken, request.ip),
      meta: {},
    }),
  );
};

export default sharedPlans;
