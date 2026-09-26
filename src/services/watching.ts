import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE, academicIdentity } from "../domain/academic.js";
import { PlanError } from "../domain/plans.js";
import { effectiveRemaining } from "../domain/quota.js";
import type {
  CourseWatchDocument,
  WatchNotificationDocument,
} from "../plugins/academic-collections.js";
import { selectableTerms } from "../repositories/selectable-terms.js";

export type WatchPreference = "none" | "in_app";

export type WatchingSettings = {
  cursorKey: string;
  cursorTtlSeconds: number;
  quotaTtlSeconds: number;
  now?: () => Date;
};

function requestError(field: string, message: string): never {
  throw new PlanError("invalid_request", 400, "Request validation failed", {
    [field]: message,
  });
}

function encodeCursor(
  key: string,
  owner: string,
  scope: string,
  createdAt: string,
  id: string,
  issuedAt: number,
) {
  const encoded = Buffer.from(
    JSON.stringify({ owner, scope, createdAt, id, issuedAt }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

function decodeCursor(
  key: string,
  token: string,
  owner: string,
  scope: string,
  ttlSeconds: number,
  now: number,
) {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra)
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  const expected = Buffer.from(
    createHmac("sha256", key).update(encoded).digest("base64url"),
  );
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
      owner?: string;
      scope?: string;
      createdAt?: string;
      id?: string;
      issuedAt?: number;
    };
    if (
      value.owner !== owner ||
      value.scope !== scope ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.issuedAt) ||
      value.issuedAt! > now ||
      value.issuedAt! + ttlSeconds * 1000 <= now
    )
      throw new Error("cursor mismatch");
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  }
}

function preference(value: unknown): WatchPreference {
  if (value === undefined) return "none";
  if (value !== "none" && value !== "in_app")
    return requestError("notificationPreference", "must be none or in_app");
  return value;
}

function isUnavailableWatchTarget(error: unknown): boolean {
  return (
    error instanceof PlanError &&
    (error.code === "not_found" || error.code === "term_not_selectable")
  );
}

/** Per-component aggregation of the quota rows behind a watched target. */
type ComponentQuota = {
  componentType: string;
  sections: number;
  observed: number;
  missing: number;
  stale: number;
  full: number;
  unknown: number;
  remainingMin: number | null;
  remainingMax: number | null;
  waitlisted: number;
};

/**
 * Summarizes quota across every section behind a watched target.
 *
 * A course watch used to report the single most recently observed section.
 * Because every section in an import batch shares one `observedAt`, the sort
 * fell through to `snapshotId` descending — so the number shown was whichever
 * section had the highest class number. That is a tie-break artifact rather
 * than an answer, and it hid real cases: a course with several full tutorials
 * could still display a comfortable positive number.
 *
 * This reports a range per component type instead, plus how many sections are
 * actually full. A section counts as full only with a known positive capacity
 * and zero remaining; a row without usable capacity is `unknown`, matching
 * `quotaSectionScore` in the planner so the two never disagree.
 */
function quotaSummary(
  rows: Document[],
  componentBySectionId: Map<string, string>,
  totalSections = rows.length,
  ttlSeconds = 900,
  now = new Date(),
) {
  if (!totalSections) return null;
  const groups = new Map<string, ComponentQuota>();
  let oldestAt: string | null = null;
  for (const row of rows) {
    const componentType =
      componentBySectionId.get(String(row.sectionId)) ?? "OTHER";
    const remainingValue = effectiveRemaining(row);
    const remaining =
      remainingValue === null ? null : Math.max(0, remainingValue);
    const capacity =
      typeof row.capacity === "number" && row.capacity > 0
        ? row.capacity
        : null;
    const usable = remaining !== null && capacity !== null;
    const waitlisted =
      typeof row.waitlisted === "number" && Number.isFinite(row.waitlisted)
        ? Math.max(0, row.waitlisted)
        : 0;

    const group = groups.get(componentType) ?? {
      componentType,
      sections: 0,
      observed: 0,
      missing: 0,
      stale: 0,
      full: 0,
      unknown: 0,
      remainingMin: null,
      remainingMax: null,
      waitlisted: 0,
    };
    group.sections += 1;
    const observedAt =
      typeof row.observedAt === "string" ? row.observedAt : null;
    if (observedAt) group.observed += 1;
    if (!observedAt) group.missing += 1;
    else if (
      !Number.isFinite(Date.parse(observedAt)) ||
      Date.parse(observedAt) + ttlSeconds * 1000 <= now.getTime()
    )
      group.stale += 1;
    group.waitlisted += waitlisted;
    if (!usable) {
      group.unknown += 1;
    } else {
      group.remainingMin =
        group.remainingMin === null
          ? remaining
          : Math.min(group.remainingMin, remaining);
      group.remainingMax =
        group.remainingMax === null
          ? remaining
          : Math.max(group.remainingMax, remaining);
      if (remaining === 0) group.full += 1;
    }
    groups.set(componentType, group);

    if (observedAt && (oldestAt === null || observedAt < oldestAt))
      oldestAt = observedAt;
  }

  for (const [sectionId, componentType] of componentBySectionId) {
    if (rows.some((row) => String(row.sectionId) === sectionId)) continue;
    const group = groups.get(componentType) ?? {
      componentType,
      sections: 0,
      observed: 0,
      missing: 0,
      stale: 0,
      full: 0,
      unknown: 0,
      remainingMin: null,
      remainingMax: null,
      waitlisted: 0,
    };
    group.sections += 1;
    group.missing += 1;
    groups.set(componentType, group);
  }

  const components = [...groups.values()].sort((left, right) =>
    left.componentType.localeCompare(right.componentType),
  );
  const mins = components
    .map((component) => component.remainingMin)
    .filter((value): value is number => value !== null);
  const maxes = components
    .map((component) => component.remainingMax)
    .filter((value): value is number => value !== null);
  return {
    observedAt: oldestAt,
    sections: totalSections,
    observedSections: components.reduce(
      (total, component) => total + component.observed,
      0,
    ),
    missingSections: components.reduce(
      (total, component) => total + component.missing,
      0,
    ),
    staleSections: components.reduce(
      (total, component) => total + component.stale,
      0,
    ),
    full: components.reduce((total, component) => total + component.full, 0),
    unknown: components.reduce(
      (total, component) => total + component.unknown,
      0,
    ),
    remainingMin: mins.length ? Math.min(...mins) : null,
    remainingMax: maxes.length ? Math.max(...maxes) : null,
    waitlisted: components.reduce(
      (total, component) => total + component.waitlisted,
      0,
    ),
    components,
  };
}

function quotaFreshness(row: Document | null, ttlSeconds: number, now: Date) {
  const observedAt =
    typeof row?.observedAt === "string" &&
    Number.isFinite(Date.parse(row.observedAt))
      ? row.observedAt
      : null;
  const nextRefreshAt =
    typeof row?.nextRefreshAt === "string" ? row.nextRefreshAt : null;
  const isStale =
    !observedAt || Date.parse(observedAt) + ttlSeconds * 1000 <= now.getTime();
  return {
    asOf: observedAt,
    isStale,
    source: ACADEMIC_SOURCE,
    lastAttemptAt:
      typeof row?.lastAttemptedAt === "string" ? row.lastAttemptedAt : null,
    nextRefreshAt,
    state: isStale ? "stale" : "fresh",
  } as const;
}

function notificationResponse(row: WatchNotificationDocument) {
  return {
    notificationId: row.notificationId,
    watchId: row.watchId,
    termCode: row.termCode,
    targetType: row.targetType,
    targetId: row.targetId,
    changeType: row.changeType,
    beforeState: row.beforeState,
    afterState: row.afterState,
    observedAt: row.observedAt,
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
  };
}

export class WatchingService {
  constructor(
    private readonly db: Db,
    private readonly settings: WatchingSettings,
  ) {}

  private now() {
    return this.settings.now?.() ?? new Date();
  }

  private async activeTerm(termCode: string) {
    const term = await this.db.collection("academicTerms").findOne({
      source: ACADEMIC_SOURCE,
      termCode,
    });
    if (!term) throw new PlanError("not_found", 404, "Academic term not found");
    if (
      typeof term.activeImportBatchId !== "string" ||
      !term.activeImportBatchId
    )
      throw new PlanError(
        "term_not_selectable",
        409,
        "Academic term has no active course data",
      );
    if (
      !(await selectableTerms(this.db)).some((row) => row.termCode === termCode)
    )
      throw new PlanError(
        "term_not_selectable",
        409,
        "Only the four most recent terms are selectable",
      );
    return term;
  }

  /** Live sections of a course, with the component type each one belongs to. */
  private async sectionRowsForCourse(term: Document, courseId: string) {
    const offerings = await this.db
      .collection("courseOfferings")
      .find({
        source: ACADEMIC_SOURCE,
        termCode: term.termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        courseId,
      })
      .project({ offeringId: 1 })
      .toArray();
    const offeringIds = offerings.map((row) => row.offeringId);
    if (!offeringIds.length)
      throw new PlanError(
        "not_found",
        404,
        "Course is not offered in this term",
      );
    const sections = await this.db
      .collection("classSections")
      .find({
        source: ACADEMIC_SOURCE,
        termCode: term.termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        offeringId: { $in: offeringIds },
      })
      .project({ sectionId: 1, componentType: 1 })
      .toArray();
    return sections.map((row) => ({
      sectionId: String(row.sectionId),
      componentType:
        typeof row.componentType === "string" && row.componentType
          ? row.componentType
          : "OTHER",
    }));
  }

  private async sectionIdsForCourse(term: Document, courseId: string) {
    const rows = await this.sectionRowsForCourse(term, courseId);
    return rows.map((row) => row.sectionId);
  }

  private async sectionBaseline(sectionIds: string[]) {
    if (!sectionIds.length) return {};
    const rows = await this.db
      .collection("latestQuotas")
      .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
      .project({ sectionId: 1, snapshotId: 1 })
      .toArray();
    const result: Record<string, string | null> = {};
    for (const sectionId of sectionIds) result[sectionId] = null;
    for (const row of rows)
      result[String(row.sectionId)] = row.snapshotId
        ? String(row.snapshotId)
        : null;
    return result;
  }

  private response(watch: CourseWatchDocument) {
    return {
      watchId: watch.watchId,
      targetType: watch.targetType,
      targetId: watch.targetId,
      termCode: watch.termCode,
      notificationPreference: watch.notificationPreference,
      baselineRecordedAt: watch.baselineRecordedAt,
      createdAt: watch.createdAt,
      updatedAt: watch.updatedAt,
    };
  }

  async createCourseWatch(
    owner: string,
    courseId: string,
    termCode: string,
    requestedPreference: unknown,
  ) {
    if (!termCode?.trim()) return requestError("termCode", "is required");
    const normalizedTermCode = termCode.trim();
    const term = await this.activeTerm(normalizedTermCode);
    const targetId = courseId.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2,8}\d+[A-Z]?$/.test(targetId))
      return requestError("courseId", "must be a canonical course code");
    const sectionIds = await this.sectionIdsForCourse(term, targetId);
    return this.upsert(
      owner,
      "course",
      targetId,
      normalizedTermCode,
      sectionIds,
      requestedPreference,
    );
  }

  async createSectionWatch(
    owner: string,
    sectionId: string,
    requestedPreference: unknown,
  ) {
    const identity = academicIdentity(sectionId, "section");
    const term = await this.activeTerm(identity.termCode);
    const section = await this.db.collection("classSections").findOne({
      ...identity,
      sectionId,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    });
    if (!section) throw new PlanError("not_found", 404, "Section not found");
    return this.upsert(
      owner,
      "section",
      sectionId,
      identity.termCode,
      [sectionId],
      requestedPreference,
    );
  }

  private async upsert(
    owner: string,
    targetType: "course" | "section",
    targetId: string,
    termCode: string,
    sectionIds: string[],
    requestedPreference: unknown,
  ) {
    const notificationPreference = preference(requestedPreference);
    const watches = this.db.collection<CourseWatchDocument>("courseWatches");
    const identity = { ownerUsername: owner, termCode, targetType, targetId };
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await watches.findOne(identity);
      const now = this.now().toISOString();
      if (existing) {
        if (existing.notificationPreference === notificationPreference)
          return this.response(existing);
        const update =
          existing.notificationPreference === "none" &&
          notificationPreference === "in_app"
            ? {
                notificationPreference,
                baselineRecordedAt: now,
                baselineBySection: await this.sectionBaseline(sectionIds),
                updatedAt: now,
              }
            : { notificationPreference, updatedAt: now };
        const updated = await watches.findOneAndUpdate(
          {
            ...identity,
            watchId: existing.watchId,
            notificationPreference: existing.notificationPreference,
          },
          { $set: update },
          { returnDocument: "after" },
        );
        if (updated) return this.response(updated);
        continue;
      }
      const watch: CourseWatchDocument = {
        ...identity,
        watchId: randomUUID(),
        notificationPreference,
        baselineRecordedAt: now,
        baselineBySection: await this.sectionBaseline(sectionIds),
        createdAt: now,
        updatedAt: now,
      };
      try {
        await watches.insertOne(watch);
        return this.response(watch);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === 11000
          )
        )
          throw error;
      }
    }
    throw new PlanError(
      "concurrent_modification",
      409,
      "Watch changed concurrently; retry",
    );
  }

  async remove(
    owner: string,
    targetType: "course" | "section",
    targetId: string,
    termCode?: string,
  ) {
    if (targetType === "course" && !termCode?.trim())
      return requestError("termCode", "is required");
    if (targetType === "section") academicIdentity(targetId, "section");
    const normalizedTargetId =
      targetType === "course"
        ? targetId.replace(/\s+/g, "").toUpperCase()
        : targetId;
    if (
      targetType === "course" &&
      !/^[A-Z]{2,8}\d+[A-Z]?$/.test(normalizedTargetId)
    )
      return requestError("courseId", "must be a canonical course code");
    await this.db.collection("courseWatches").deleteOne({
      ownerUsername: owner,
      targetType,
      targetId: normalizedTargetId,
      ...(termCode ? { termCode: termCode.trim() } : {}),
    });
  }

  async list(
    owner: string,
    query: {
      termCode?: string;
      targetType?: "course" | "section";
      limit: number;
      cursor?: string;
    },
  ) {
    const watches = this.db.collection<CourseWatchDocument>("courseWatches");
    const now = this.now();
    const filter: Document = {
      ownerUsername: owner,
      ...(query.termCode ? { termCode: query.termCode } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };
    const scope = JSON.stringify({
      kind: "watches",
      termCode: query.termCode ?? null,
      targetType: query.targetType ?? null,
    });
    const cursor = query.cursor
      ? decodeCursor(
          this.settings.cursorKey,
          query.cursor,
          owner,
          scope,
          this.settings.cursorTtlSeconds,
          now.getTime(),
        )
      : null;
    if (cursor)
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, watchId: { $lt: cursor.id } },
      ];
    const rows = await watches
      .find(filter)
      .sort({ createdAt: -1, watchId: -1 })
      .limit(query.limit + 1)
      .toArray();
    const visible = rows.slice(0, query.limit);
    const items = await Promise.all(
      visible.map(async (watch) => {
        let sectionRows: Array<{ sectionId: string; componentType: string }>;
        let term: Document | null = null;
        try {
          term = await this.activeTerm(watch.termCode);
        } catch (error) {
          if (!isUnavailableWatchTarget(error)) throw error;
        }
        if (watch.targetType === "section") {
          const section = term
            ? await this.db.collection("classSections").findOne(
                {
                  source: ACADEMIC_SOURCE,
                  termCode: watch.termCode,
                  importBatchId: term.activeImportBatchId,
                  retiredAt: null,
                  sectionId: watch.targetId,
                },
                { projection: { componentType: 1 } },
              )
            : null;
          sectionRows = section
            ? [
                {
                  sectionId: watch.targetId,
                  componentType:
                    typeof section?.componentType === "string" &&
                    section.componentType
                      ? section.componentType
                      : "OTHER",
                },
              ]
            : [];
        } else {
          try {
            sectionRows = term
              ? await this.sectionRowsForCourse(term, watch.targetId)
              : [];
          } catch (error) {
            if (!isUnavailableWatchTarget(error)) throw error;
            sectionRows = [];
          }
        }

        const sectionIds = sectionRows.map((row) => row.sectionId);
        // Every row is needed: the summary reports a range per component type,
        // and taking a single row is what produced the misleading figure.
        const quotaRows = sectionIds.length
          ? await this.db
              .collection("latestQuotas")
              .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
              .toArray()
          : [];
        const oldest = quotaRows.reduce<Document | null>(
          (latest, row) =>
            latest === null ||
            String(row.observedAt ?? "") < String(latest.observedAt ?? "")
              ? row
              : latest,
          null,
        );
        const freshness = quotaFreshness(
          oldest,
          this.settings.quotaTtlSeconds,
          now,
        );
        const missing =
          quotaRows.length < sectionRows.length ||
          quotaRows.some((row) => !row.snapshotId);
        const dataQuality = [
          ...(missing ? ["quota_missing"] : []),
          ...(freshness.isStale && quotaRows.length ? ["quota_stale"] : []),
        ];
        if (
          quotaRows.some((row) => {
            const value = effectiveRemaining(row);
            return value !== null && value < 0;
          })
        )
          dataQuality.push("quota_inconsistent");
        return {
          ...this.response(watch),
          quotaSummary: quotaSummary(
            quotaRows,
            new Map(
              sectionRows.map((row) => [row.sectionId, row.componentType]),
            ),
            sectionRows.length,
            this.settings.quotaTtlSeconds,
            now,
          ),
          freshness: missing
            ? { ...freshness, isStale: true, state: "stale" }
            : freshness,
          dataQuality,
        };
      }),
    );
    const last = visible.at(-1);
    return {
      items,
      page: {
        hasMore: rows.length > query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(
                this.settings.cursorKey,
                owner,
                scope,
                last.createdAt,
                last.watchId,
                now.getTime(),
              )
            : null,
      },
      meta: {},
    };
  }

  async notifications(
    owner: string,
    query: { unreadOnly: boolean; limit: number; cursor?: string },
  ) {
    const notifications =
      this.db.collection<WatchNotificationDocument>("watchNotifications");
    const now = this.now();
    const filter: Document = {
      ownerUsername: owner,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const scope = JSON.stringify({
      kind: "notifications",
      unreadOnly: query.unreadOnly,
    });
    const cursor = query.cursor
      ? decodeCursor(
          this.settings.cursorKey,
          query.cursor,
          owner,
          scope,
          this.settings.cursorTtlSeconds,
          now.getTime(),
        )
      : null;
    if (cursor)
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, notificationId: { $lt: cursor.id } },
      ];
    const rows = await notifications
      .find(filter)
      .sort({ createdAt: -1, notificationId: -1 })
      .limit(query.limit + 1)
      .toArray();
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(notificationResponse),
      page: {
        hasMore: rows.length > query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(
                this.settings.cursorKey,
                owner,
                scope,
                last.createdAt,
                last.notificationId,
                now.getTime(),
              )
            : null,
      },
      meta: {},
    };
  }

  async acknowledge(owner: string, notificationId: string) {
    const notifications =
      this.db.collection<WatchNotificationDocument>("watchNotifications");
    const result = await notifications.findOneAndUpdate(
      { ownerUsername: owner, notificationId, readAt: null },
      { $set: { readAt: this.now().toISOString() } },
      { returnDocument: "after" },
    );
    if (result) return notificationResponse(result);
    const existing = await notifications.findOne({
      ownerUsername: owner,
      notificationId,
    });
    if (!existing)
      throw new PlanError("not_found", 404, "Notification not found");
    return notificationResponse(existing);
  }
}
