import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import { calendarWindow, optionalCalendarWindow } from "../domain/calendar.js";
import { serializeIcs } from "../domain/ics-export.js";
import { sendApiError } from "../http/api-errors.js";
import type { AppOptions } from "../options.js";
import { CourseCatalogRepository } from "../repositories/course-catalog.js";
import { CoursePlanRepository } from "../repositories/course-plans.js";
import { EventRepository } from "../repositories/events.js";
import {
  CalendarService,
  CoursePlanCalendarSource,
  ImportedCalendarSource,
  ManualCalendarSource,
} from "../services/calendar.js";
import { CoursePlanService } from "../services/course-plans.js";
import { IcsService } from "../services/ics.js";

export const prefixOverride = "";

const route: FastifyPluginAsync<AppOptions> = async (fastify, opts) => {
  type ExportQuery = {
    from?: string;
    to?: string;
    termCode?: string;
    planId?: string;
  };
  const events = () =>
    new EventRepository(
      fastify.collections.events,
      fastify.collections.eventImports,
    );
  const plans = () =>
    new CoursePlanService(
      new CoursePlanRepository(fastify.collections.coursePlans),
      new CourseCatalogRepository(fastify.mongo.db!),
      events(),
      fastify.collections.idempotencyRecords,
      {
        timezone: opts.appTimezone ?? "Asia/Hong_Kong",
        cursorKey:
          opts.cursorSigningKey ?? "development-only-cursor-signing-key",
        cursorTtlSeconds: opts.cursorTtlSeconds ?? 900,
        autoPlanTokenKey:
          opts.autoPlanTokenSigningKey ??
          "development-only-auto-plan-token-key-32-bytes",
        autoPlanTokenTtlSeconds: opts.autoPlanTokenTtlSeconds ?? 600,
        idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
        defaultTermCode: opts.academicCurrentTermCode,
      },
    );
  const imports = () =>
    new IcsService(
      fastify.collections.events,
      fastify.collections.eventImports,
      {
        timezone: opts.appTimezone ?? "Asia/Hong_Kong",
        maxWindowDays: opts.calendarMaxWindowDays ?? 366,
        maxPayloadBytes: opts.icsMaxPayloadBytes ?? 1_000_000,
        maxOccurrences: opts.icsMaxOccurrences ?? 1000,
        defaultWindowDays: opts.icsDefaultImportWindowDays ?? 366,
        processingLeaseSeconds: opts.icsProcessingLeaseSeconds ?? 120,
        idempotencyRetentionSeconds: opts.idempotencyRetentionSeconds ?? 86400,
      },
      fastify.collections.idempotencyRecords,
    );

  fastify.withAuth(async (scope) => {
    scope.register(async (routes) => {
      const protectedRoutes = routes as typeof scope;
      protectedRoutes.setErrorHandler(sendApiError);
      protectedRoutes.get(
        "/events.ics",
        {
          schema: {
            tags: ["Events"],
            security: [{ Auth: [] }],
            querystring: Type.Object(
              {
                from: Type.Optional(Type.String()),
                to: Type.Optional(Type.String()),
                termCode: Type.Optional(Type.String()),
                planId: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          },
        },
        async (request, reply) => {
          const query = request.query as ExportQuery;
          const timezone = opts.appTimezone ?? "Asia/Hong_Kong";
          const window =
            optionalCalendarWindow(
              query.from,
              query.to,
              timezone,
              opts.calendarMaxWindowDays ?? 366,
            ) ??
            calendarWindow(
              undefined,
              undefined,
              timezone,
              opts.calendarMaxWindowDays ?? 366,
            );
          const eventRepository = events();
          const planService = plans();
          const importService = imports();
          const manual = new ManualCalendarSource(eventRepository);
          const course = new CoursePlanCalendarSource(
            (owner, range, planId, termCode) =>
              planService.calendarItems(owner, range, planId, termCode),
            (owner, key) => planService.resolvesCalendarKey(owner, key),
            query.planId,
            query.termCode,
          );
          const service = new CalendarService(
            manual,
            [manual, course, new ImportedCalendarSource(importService)],
            {
              timezone,
              maxItems: opts.calendarMaxItems ?? 1000,
              maxConflicts: opts.calendarMaxConflicts ?? 10000,
              upcomingHours: opts.timeBannerUpcomingHours ?? 24,
            },
          );
          reply.type("text/calendar; charset=utf-8");
          return reply.send(
            serializeIcs(
              await service.list(request.user.username, window),
            ) as never,
          );
        },
      );
    });
  });
};

export default route;
