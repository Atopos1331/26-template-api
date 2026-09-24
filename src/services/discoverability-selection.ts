import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";
import type { CoursePlanDocument } from "../plugins/init-mongo.js";
import type { ActiveTerm } from "../repositories/course-catalog.js";

export async function currentSelections(
  db: Db,
  ownerUsernames: string[],
  section: Document,
  term: ActiveTerm,
) {
  const owners = [...new Set(ownerUsernames)];
  if (!owners.length) return new Set<string>();
  const plans = await db
    .collection<CoursePlanDocument>("coursePlans")
    .find({
      ownerUsername: { $in: owners },
      termCode: term.termCode,
      status: "active",
    })
    .toArray();
  const selections = plans.flatMap((plan) =>
    plan.items
      .filter((item) => item.status === "selected")
      .map((item) => ({
        owner: plan.ownerUsername,
        bundleId: item.bundleId,
        offeringId: item.offeringId,
      })),
  );
  if (!selections.length) return new Set<string>();
  const key = {
    source: ACADEMIC_SOURCE,
    termCode: term.termCode,
    importBatchId: term.activeImportBatchId,
    retiredAt: null,
  };
  const bundles = await db
    .collection("sectionBundles")
    .find({
      ...key,
      bundleId: { $in: [...new Set(selections.map((row) => row.bundleId))] },
      componentClassNbrs: String(section.classNbr),
    })
    .project({ bundleId: 1, offeringId: 1 })
    .toArray();
  if (!bundles.length) return new Set<string>();
  const offeringIds = [
    ...new Set(bundles.map((row) => String(row.offeringId))),
  ];
  const offerings = await db
    .collection("courseOfferings")
    .find({ ...key, offeringId: { $in: offeringIds } })
    .project({ offeringId: 1 })
    .toArray();
  const activeOfferings = new Set(
    offerings.map((row) => String(row.offeringId)),
  );
  const activeBundles = new Set(
    bundles
      .filter((row) => activeOfferings.has(String(row.offeringId)))
      .map((row) => `${row.offeringId}\u0000${row.bundleId}`),
  );
  return new Set(
    selections
      .filter((row) =>
        activeBundles.has(`${row.offeringId}\u0000${row.bundleId}`),
      )
      .map((row) => row.owner),
  );
}
