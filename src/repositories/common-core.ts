import type { Db } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";
import {
  type CommonCoreCatalog,
  normalizeCommonCoreCatalog,
  schemeForAdmissionYear,
} from "../domain/common-core.js";
import { PlanError } from "../domain/plans.js";

export class CommonCoreRepository {
  constructor(private readonly db: Db) {}

  async active() {
    const state = await this.db.collection("commonCoreCatalogState").findOne({
      stateId: "common-core",
    });
    if (!state?.activeCatalogVersion)
      throw new PlanError(
        "common_core_unavailable",
        503,
        "Common Core classification is unavailable",
      );
    const catalog = await this.db
      .collection<CommonCoreCatalog>("commonCoreCatalogs")
      .findOne({
        catalogVersion: state.activeCatalogVersion,
      });
    if (!catalog)
      throw new PlanError(
        "common_core_unavailable",
        503,
        "Common Core classification is unavailable",
      );
    return { catalog, revision: Number(state.revision ?? 0) };
  }

  async activate(input: unknown, now = new Date()) {
    const catalog = normalizeCommonCoreCatalog(input, now);
    const catalogs =
      this.db.collection<CommonCoreCatalog>("commonCoreCatalogs");
    const existing = await catalogs.findOne({
      catalogVersion: catalog.catalogVersion,
    });
    if (
      existing &&
      JSON.stringify({
        sourceUrl: existing.sourceUrl,
        sourceTitle: existing.sourceTitle,
        sourcePublishedAt: existing.sourcePublishedAt ?? null,
        sourceContentHash: existing.sourceContentHash,
        verifiedAt: existing.verifiedAt,
        verifier: existing.verifier,
        evidence: existing.evidence,
        schemes: existing.schemes,
      }) !==
        JSON.stringify({
          sourceUrl: catalog.sourceUrl,
          sourceTitle: catalog.sourceTitle,
          sourcePublishedAt: catalog.sourcePublishedAt ?? null,
          sourceContentHash: catalog.sourceContentHash,
          verifiedAt: catalog.verifiedAt,
          verifier: catalog.verifier,
          evidence: catalog.evidence,
          schemes: catalog.schemes,
        })
    )
      throw new PlanError(
        "invalid_request",
        400,
        "Catalog version is already used by different content",
      );
    if (!existing) await catalogs.insertOne(catalog);
    const state = this.db.collection("commonCoreCatalogState");
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await state.findOne({ stateId: "common-core" });
      if (current?.activeCatalogVersion === catalog.catalogVersion)
        return current;
      const revision = Number(current?.revision ?? 0);
      try {
        const result = await state.updateOne(
          current
            ? { _id: current._id, revision }
            : { stateId: "common-core", revision: { $exists: false } },
          {
            $set: {
              stateId: "common-core",
              activeCatalogVersion: catalog.catalogVersion,
              updatedAt: now.toISOString(),
            },
            $inc: { revision: 1 },
          },
          { upsert: !current },
        );
        if (result.matchedCount === 1 || result.upsertedCount === 1)
          return (await state.findOne({ stateId: "common-core" }))!;
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
      "operation_in_progress",
      409,
      "Common Core classification activation is being retried",
    );
  }

  async presets(
    termCode: string,
    admissionYear: number,
    now = new Date(),
    maxAgeDays = 365,
  ) {
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
        503,
        "Academic term has no active course data",
      );
    const { catalog, revision } = await this.active();
    const scheme = schemeForAdmissionYear(catalog, admissionYear);
    const stale =
      Date.parse(catalog.verifiedAt) + maxAgeDays * 86_400_000 <= now.getTime();
    const codes = [
      ...new Set(scheme.categories.flatMap((category) => category.courseCodes)),
    ];
    const offeredCourses = await this.db
      .collection("courses")
      .find({
        source: ACADEMIC_SOURCE,
        termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        courseCode: { $in: codes },
      })
      .project({ courseId: 1, courseCode: 1 })
      .toArray();
    const offeringRows = offeredCourses.length
      ? await this.db
          .collection("courseOfferings")
          .find({
            source: ACADEMIC_SOURCE,
            termCode,
            importBatchId: term.activeImportBatchId,
            retiredAt: null,
            courseId: {
              $in: offeredCourses.map((row) => row.courseId),
            },
          })
          .project({ courseId: 1 })
          .toArray()
      : [];
    const offeredIds = new Set(offeringRows.map((row) => String(row.courseId)));
    const offeredCodes = new Set(
      offeredCourses
        .filter((row) => offeredIds.has(String(row.courseId)))
        .map((row) => String(row.courseCode)),
    );
    return {
      admissionYear,
      termCode,
      schemeId: scheme.schemeId,
      catalogVersion: catalog.catalogVersion,
      stateRevision: revision,
      sourceUrl: catalog.sourceUrl,
      sourceTitle: catalog.sourceTitle,
      verifiedAt: catalog.verifiedAt,
      isStale: stale,
      categories: scheme.categories.map((category) => ({
        categoryId: category.categoryId,
        label: category.label,
        offeredCourseCount: new Set(
          category.courseCodes.filter((code) => offeredCodes.has(code)),
        ).size,
      })),
    };
  }

  async courseCodesForCategories(
    admissionYear: number,
    categoryIds: string[],
    now = new Date(),
    maxAgeDays = 365,
  ) {
    const { catalog, revision } = await this.active();
    if (
      Date.parse(catalog.verifiedAt) + maxAgeDays * 86_400_000 <=
      now.getTime()
    )
      throw new PlanError(
        "common_core_unavailable",
        503,
        "Common Core classification is stale",
      );
    const scheme = schemeForAdmissionYear(catalog, admissionYear);
    const wanted = new Set(categoryIds);
    const categories = scheme.categories.filter((category) =>
      wanted.has(category.categoryId),
    );
    if (categories.length !== wanted.size)
      throw new PlanError(
        "invalid_request",
        400,
        "Unknown Common Core category",
        { commonCoreCategoryIds: "contains an unknown category" },
      );
    return {
      courseCodes: [
        ...new Set(categories.flatMap((category) => category.courseCodes)),
      ],
      catalogVersion: catalog.catalogVersion,
      stateRevision: revision,
    };
  }
}
