import type { Collection, Db, Document } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";
import { PlanError } from "../domain/plans.js";

export type CanonicalBundle = {
  termCode: string;
  importBatchId: string;
  course: Document;
  offering: Document;
  bundle: Document;
  sections: Document[];
};

export type ActiveTerm = Document & {
  termCode: string;
  activeImportBatchId: string;
  importFence?: number;
};

export class CourseCatalogRepository {
  private readonly db: Db;
  private readonly terms: Collection<Document>;
  private readonly courses: Collection<Document>;
  private readonly offerings: Collection<Document>;
  private readonly sections: Collection<Document>;
  private readonly bundles: Collection<Document>;
  private readonly quotas: Collection<Document>;

  constructor(db: Db) {
    this.db = db;
    this.terms = db.collection("academicTerms");
    this.courses = db.collection("courses");
    this.offerings = db.collection("courseOfferings");
    this.sections = db.collection("classSections");
    this.bundles = db.collection("sectionBundles");
    this.quotas = db.collection("latestQuotas");
  }

  async activeTerm(termCode: string): Promise<ActiveTerm> {
    const term = await this.term(termCode);
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
    return term as unknown as ActiveTerm;
  }

  async term(termCode: string): Promise<ActiveTerm | null> {
    const term = await this.terms.findOne({
      source: ACADEMIC_SOURCE,
      termCode,
    });
    return term as unknown as ActiveTerm | null;
  }

  async defaultActiveTerm(preferredTermCode?: string) {
    if (preferredTermCode) {
      const preferred = await this.terms.findOne({
        source: ACADEMIC_SOURCE,
        termCode: preferredTermCode,
        activeImportBatchId: { $type: "string" },
      });
      if (preferred) return preferred as unknown as ActiveTerm;
    }
    const term = await this.terms.findOne(
      {
        source: ACADEMIC_SOURCE,
        activeImportBatchId: { $type: "string" },
      },
      { sort: { sortKey: -1, termCode: 1 } },
    );
    return (term as unknown as ActiveTerm | null) ?? null;
  }

  private key(term: ActiveTerm) {
    return {
      source: ACADEMIC_SOURCE,
      termCode: term.termCode,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    };
  }

  async resolveBundle(
    term: ActiveTerm,
    offeringId: string,
    bundleId: string,
  ): Promise<CanonicalBundle> {
    const key = this.key(term);
    const [offering, bundle] = await Promise.all([
      this.offerings.findOne({ ...key, offeringId }),
      this.bundles.findOne({ ...key, offeringId, bundleId }),
    ]);
    if (!offering || !bundle)
      throw new PlanError(
        "stale_reference",
        409,
        "Course section bundle is no longer available",
      );
    const [course, sections] = await Promise.all([
      this.courses.findOne({ ...key, courseId: offering.courseId }),
      this.sections
        .find({
          ...key,
          offeringId,
          classNbr: { $in: bundle.componentClassNbrs ?? [] },
        })
        .toArray(),
    ]);
    if (!course || sections.length !== (bundle.componentClassNbrs ?? []).length)
      throw new PlanError(
        "stale_reference",
        409,
        "Course section bundle is incomplete",
      );
    return {
      termCode: term.termCode,
      importBatchId: term.activeImportBatchId,
      course,
      offering,
      bundle,
      sections,
    };
  }

  async resolveBundleAtBatch(
    termCode: string,
    importBatchId: string,
    offeringId: string,
    bundleId: string,
  ): Promise<CanonicalBundle | null> {
    const key = {
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId,
    };
    const [offering, bundle] = await Promise.all([
      this.offerings.findOne({ ...key, offeringId }),
      this.bundles.findOne({ ...key, offeringId, bundleId }),
    ]);
    if (!offering || !bundle) return null;
    const [course, sections] = await Promise.all([
      this.courses.findOne({ ...key, courseId: offering.courseId }),
      this.sections
        .find({
          ...key,
          offeringId,
          classNbr: { $in: bundle.componentClassNbrs ?? [] },
        })
        .toArray(),
    ]);
    if (!course || sections.length !== (bundle.componentClassNbrs ?? []).length)
      return null;
    return { termCode, importBatchId, course, offering, bundle, sections };
  }

  async findOfferings(term: ActiveTerm, courseId: string, career?: string) {
    const key = this.key(term);
    const offerings = await this.offerings
      .find({
        ...key,
        courseId,
        ...(career === undefined ? {} : { academicCareer: career }),
      })
      .sort({ academicCareer: 1, offeringId: 1 })
      .toArray();
    return offerings;
  }

  async findOfferingsByCode(
    term: ActiveTerm,
    courseCode: string,
    career?: string,
  ) {
    const courses = await this.courses
      .find({
        ...this.key(term),
        courseCode,
      })
      .sort({ courseId: 1 })
      .toArray();
    const result: Array<{ course: Document; offering: Document }> = [];
    for (const course of courses) {
      const offerings = await this.findOfferings(
        term,
        String(course.courseId),
        career,
      );
      result.push(...offerings.map((offering) => ({ course, offering })));
    }
    return result;
  }

  async courseCodeExists(courseCode: string) {
    return (
      (await this.courses.findOne({ source: ACADEMIC_SOURCE, courseCode })) !==
      null
    );
  }

  async bundlesForOffering(term: ActiveTerm, offeringId: string) {
    const key = this.key(term);
    return this.bundles
      .find({ ...key, offeringId })
      .sort({ bundleId: 1 })
      .toArray();
  }

  async courseForOffering(term: ActiveTerm, offering: Document) {
    return this.courses.findOne({
      ...this.key(term),
      courseId: offering.courseId,
    });
  }

  async sectionsForBundle(term: ActiveTerm, bundle: Document) {
    return this.sections
      .find({
        ...this.key(term),
        offeringId: bundle.offeringId,
        classNbr: { $in: bundle.componentClassNbrs ?? [] },
      })
      .toArray();
  }

  async latestQuotas(sectionIds: string[]) {
    if (!sectionIds.length) return [];
    return this.quotas
      .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
      .toArray();
  }

  async quotaHistory(sectionIds: string[]) {
    if (!sectionIds.length) return [];
    return this.db
      .collection("quotaSnapshots")
      .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
      .sort({ observedAt: 1, snapshotId: 1 })
      .limit(50_000)
      .toArray();
  }

  async quotaHistoryForSections(sectionIds: string[]) {
    if (!sectionIds.length) return [];
    return this.db
      .collection("quotaSnapshots")
      .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
      .sort({ observedAt: 1, snapshotId: 1 })
      .limit(50_000)
      .toArray();
  }

  async fillOfferings(
    term: ActiveTerm,
    input: {
      courseCodes: string[];
      subjects: string[];
      levels: number[];
      academicCareer?: string;
    },
  ) {
    const key = this.key(term);
    const seed: Document[] = [];
    if (input.courseCodes.length || input.subjects.length) {
      const courses = await this.courses
        .find({
          ...key,
          $or: [
            ...(input.courseCodes.length
              ? [{ courseCode: { $in: input.courseCodes } }]
              : []),
            ...(input.subjects.length
              ? [{ subject: { $in: input.subjects } }]
              : []),
          ],
        })
        .sort({ courseCode: 1, courseId: 1 })
        .limit(1001)
        .toArray();
      if (courses.length > 1000)
        throw new PlanError(
          "candidate_pool_too_large",
          400,
          "Filler seed pool is too large to inspect safely",
        );
      seed.push(...courses);
    }
    const filtered = seed.filter((course) => {
      if (!input.levels.length) return true;
      const match = String(course.catalogNumber ?? "").match(/^[1-9]/);
      return match ? input.levels.includes(Number(match[0])) : false;
    });
    const result: Array<{ course: Document; offering: Document }> = [];
    for (const course of filtered) {
      const offerings = await this.findOfferings(
        term,
        String(course.courseId),
        input.academicCareer,
      );
      result.push(...offerings.map((offering) => ({ course, offering })));
    }
    return result;
  }

  async activeBundleById(term: ActiveTerm, bundleId: string) {
    const bundle = await this.bundles.findOne({
      ...this.key(term),
      bundleId,
    });
    if (!bundle) return null;
    const offering = await this.offerings.findOne({
      ...this.key(term),
      offeringId: bundle.offeringId,
    });
    if (!offering) return null;
    return this.resolveBundle(term, bundle.offeringId, bundleId);
  }
}
