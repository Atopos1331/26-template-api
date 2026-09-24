import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { PlanError } from "../../domain/plans.js";
import { formatRevisionEtag, parseIfMatch } from "../../domain/revision.js";
import { sendApiError } from "../../http/api-errors.js";
import type { AppOptions } from "../../options.js";
import { CommonCoreRepository } from "../../repositories/common-core.js";
import { CourseCatalogRepository } from "../../repositories/course-catalog.js";
import { CoursePlanRepository } from "../../repositories/course-plans.js";
import { EventRepository } from "../../repositories/events.js";
import { CoursePlanService } from "../../services/course-plans.js";
import { SharingService } from "../../services/sharing.js";

const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    fields: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
});

const PlanInput = Type.Object(
  {
    name: Type.String(),
    termCode: Type.String(),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const PlanPatch = Type.Object(
  {
    name: Type.Optional(Type.String()),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    ),
  },
  { additionalProperties: true },
);
const ItemInput = Type.Object(
  {
    offeringId: Type.String(),
    bundleId: Type.String(),
    status: Type.Optional(
      Type.Union([Type.Literal("selected"), Type.Literal("alternative")]),
    ),
    note: Type.Optional(Type.String()),
    colorOverride: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const ItemPatch = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal("selected"),
        Type.Literal("alternative"),
        Type.Literal("rejected"),
      ]),
    ),
    note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    colorOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);
const PlanResponse = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        termCode: Type.String(),
        status: Type.String(),
        revision: Type.Number(),
        items: Type.Array(Type.Object({}, { additionalProperties: true })),
      },
      { additionalProperties: true },
    ),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const ListResponse = Type.Object({
  items: Type.Array(Type.Object({}, { additionalProperties: true })),
  page: Type.Object({
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
  meta: Type.Object({}, { additionalProperties: true }),
});
const RecommendationResponse = Type.Object(
  {
    data: Type.Object(
      {
        planId: Type.String(),
        generatedAt: Type.String(),
        constraints: Type.Object({}, { additionalProperties: true }),
        items: Type.Array(Type.Object({}, { additionalProperties: true })),
      },
      { additionalProperties: true },
    ),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const AutoPlanResponse = Type.Object(
  {
    data: Type.Object(
      {
        searchStatus: Type.Union([
          Type.Literal("completed"),
          Type.Literal("time_limited"),
          Type.Literal("infeasible"),
        ]),
        planId: Type.String(),
        planRevision: Type.Number(),
        normalizedRequest: Type.Object({}, { additionalProperties: true }),
        options: Type.Array(Type.Object({}, { additionalProperties: true })),
        diagnostics: Type.Array(
          Type.Object({}, { additionalProperties: true }),
        ),
      },
      { additionalProperties: true },
    ),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const ApplyResponse = PlanResponse;
const ShareResponse = Type.Object(
  {
    data: Type.Object({}, { additionalProperties: true }),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const ShareListResponse = Type.Object(
  {
    items: Type.Array(Type.Object({}, { additionalProperties: true })),
    meta: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const common = {
  tags: ["Planning"],
  security: [{ Auth: [] }],
  response: {
    400: ErrorResponse,
    401: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
    429: ErrorResponse,
    428: ErrorResponse,
  },
};

function service(fastify: FastifyTypebox, opts: AppOptions) {
  return new CoursePlanService(
    new CoursePlanRepository(fastify.collections.coursePlans),
    new CourseCatalogRepository(fastify.mongo.db!),
    new EventRepository(
      fastify.collections.events,
      fastify.collections.eventImports,
    ),
    fastify.collections.idempotencyRecords,
    {
      timezone: opts.appTimezone ?? "Asia/Hong_Kong",
      cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
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
      commonCoreMaxAgeDays: opts.commonCoreMaxAgeDays,
      academicQuotaTtlSeconds: opts.academicQuotaTtlSeconds,
    },
    new CommonCoreRepository(fastify.mongo.db!),
  );
}

function sharing(fastify: FastifyTypebox, opts: AppOptions) {
  return new SharingService(
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
      cursorKey: opts.cursorSigningKey ?? "development-only-cursor-signing-key",
      cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
      shareReadsPerMinute: opts.shareReadsPerMinute ?? 60,
      friendSearchesPerMinute: opts.friendSearchesPerMinute ?? 30,
      idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
    },
  );
}

function listLimit(value: string | undefined) {
  if (value === undefined) return 50;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100)
    throw new PlanError("invalid_request", 400, "Invalid limit", {
      limit: "must be an integer from 1 to 100",
    });
  return Number(value);
}

const plans: FastifyPluginAsync<AppOptions> = async (
  fastify: FastifyTypebox,
  opts,
) => {
  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      const params = Type.Object({ id: Type.String() });
      const itemParams = Type.Object({
        id: Type.String(),
        itemId: Type.String(),
      });

      protectedRoutes.post(
        "/:id/shares",
        {
          schema: {
            ...common,
            summary: "Create a read-only plan share",
            params,
            body: Type.Object(
              { expiresInSeconds: Type.Optional(Type.Integer({ minimum: 1 })) },
              { additionalProperties: false },
            ),
            response: { ...common.response, 201: ShareResponse },
          },
        },
        async (request, reply) => {
          const result = await sharing(fastify, opts).create(
            request.user.username,
            request.params.id,
            request.body,
            request.headers["idempotency-key"],
          );
          return reply
            .code(result.status)
            .send({ data: result.body, meta: {} });
        },
      );

      protectedRoutes.get(
        "/:id/shares",
        {
          schema: {
            ...common,
            summary: "List plan share metadata",
            params,
            response: { ...common.response, 200: ShareListResponse },
          },
        },
        async (request) => ({
          items: await sharing(fastify, opts).list(
            request.user.username,
            request.params.id,
          ),
          meta: {},
        }),
      );

      protectedRoutes.delete(
        "/:id/shares/:shareId",
        {
          schema: {
            ...common,
            summary: "Revoke a plan share",
            params: Type.Object({ id: Type.String(), shareId: Type.String() }),
            response: { ...common.response, 204: Type.Null() },
          },
        },
        async (request, reply) => {
          await sharing(fastify, opts).revoke(
            request.user.username,
            request.params.id,
            request.params.shareId,
          );
          return reply.code(204).send(null);
        },
      );

      protectedRoutes.post(
        "/",
        {
          schema: {
            ...common,
            summary: "Create a course plan",
            body: PlanInput,
            response: { ...common.response, 201: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).create(
            request.user.username,
            request.body,
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return reply.code(201).send({ data: result, meta: {} });
        },
      );

      protectedRoutes.get(
        "/",
        {
          schema: {
            ...common,
            summary: "List course plans",
            querystring: Type.Object(
              {
                termCode: Type.Optional(Type.String()),
                status: Type.Optional(
                  Type.Union([
                    Type.Literal("draft"),
                    Type.Literal("active"),
                    Type.Literal("archived"),
                  ]),
                ),
                limit: Type.Optional(Type.String()),
                cursor: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            response: { ...common.response, 200: ListResponse },
          },
        },
        async (request) => ({
          ...(await service(fastify, opts).list(request.user.username, {
            limit: listLimit(request.query.limit),
            termCode: request.query.termCode,
            status: request.query.status,
            cursor: request.query.cursor,
          })),
        }),
      );

      protectedRoutes.get(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Get a course plan",
            params,
            response: { ...common.response, 200: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).get(
            request.user.username,
            request.params.id,
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return { data: result, meta: {} };
        },
      );

      protectedRoutes.patch(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Update a course plan",
            params,
            body: PlanPatch,
            response: { ...common.response, 200: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).patch(
            request.user.username,
            request.params.id,
            parseIfMatch(request.headers["if-match"]),
            request.body,
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return { data: result, meta: {} };
        },
      );

      protectedRoutes.delete(
        "/:id",
        {
          schema: {
            ...common,
            summary: "Archive a course plan",
            params,
            response: { ...common.response, 204: Type.Null() },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).remove(
            request.user.username,
            request.params.id,
            parseIfMatch(request.headers["if-match"]),
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return reply.code(204).send(null);
        },
      );

      protectedRoutes.post(
        "/:id/recommendations",
        {
          schema: {
            ...common,
            summary: "Recommend bundles for one course",
            params,
            body: Type.Object({}, { additionalProperties: true }),
            response: { ...common.response, 200: RecommendationResponse },
          },
        },
        async (request) => ({
          data: await service(fastify, opts).recommendations(
            request.user.username,
            request.params.id,
            request.body,
          ),
          meta: {},
        }),
      );

      protectedRoutes.post(
        "/:id/auto-plans",
        {
          schema: {
            ...common,
            summary: "Generate whole-timetable options",
            params,
            body: Type.Object({}, { additionalProperties: true }),
            response: { ...common.response, 200: AutoPlanResponse },
          },
        },
        async (request) => ({
          data: await service(fastify, opts).autoPlans(
            request.user.username,
            request.params.id,
            request.body,
          ),
          meta: {},
        }),
      );

      protectedRoutes.post(
        "/:id/auto-plans/apply",
        {
          schema: {
            ...common,
            summary: "Apply a generated timetable option",
            params,
            body: Type.Object(
              { optionToken: Type.String() },
              { additionalProperties: false },
            ),
            response: { ...common.response, 200: ApplyResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).applyAutoPlan(
            request.user.username,
            request.params.id,
            parseIfMatch(request.headers["if-match"]),
            request.body.optionToken,
            request.headers["idempotency-key"],
          );
          const data = result.body.data as { revision: number };
          reply.header("ETag", formatRevisionEtag(data.revision));
          return reply.code(result.status).send(
            result.body as {
              data: {
                id: string;
                name: string;
                termCode: string;
                status: string;
                revision: number;
                items: object[];
              };
              meta: Record<string, unknown>;
            },
          );
        },
      );

      protectedRoutes.post(
        "/:id/items",
        {
          schema: {
            ...common,
            summary: "Add a bundle to a course plan",
            params,
            body: ItemInput,
            response: { ...common.response, 200: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).addItem(
            request.user.username,
            request.params.id,
            parseIfMatch(request.headers["if-match"]),
            request.body,
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return { data: result, meta: {} };
        },
      );

      protectedRoutes.patch(
        "/:id/items/:itemId",
        {
          schema: {
            ...common,
            summary: "Update a course plan item",
            params: itemParams,
            body: ItemPatch,
            response: { ...common.response, 200: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).patchItem(
            request.user.username,
            request.params.id,
            request.params.itemId,
            parseIfMatch(request.headers["if-match"]),
            request.body,
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return { data: result, meta: {} };
        },
      );

      protectedRoutes.delete(
        "/:id/items/:itemId",
        {
          schema: {
            ...common,
            summary: "Remove a course plan item",
            params: itemParams,
            response: { ...common.response, 200: PlanResponse },
          },
        },
        async (request, reply) => {
          const result = await service(fastify, opts).removeItem(
            request.user.username,
            request.params.id,
            request.params.itemId,
            parseIfMatch(request.headers["if-match"]),
          );
          reply.header("ETag", formatRevisionEtag(result.revision));
          return { data: result, meta: {} };
        },
      );
    });
  });
};

export default plans;
