import type { Db, Document } from "mongodb";
import { normalizeCommonCoreCatalog } from "../../../../src/domain/common-core.ts";

function sameContent(left: Document, right: Document) {
  const fields = [
    "sourceUrl",
    "sourceTitle",
    "sourcePublishedAt",
    "sourceContentHash",
    "verifiedAt",
    "verifier",
    "evidence",
    "schemes",
  ];
  return fields.every(
    (field) =>
      JSON.stringify(left[field] ?? null) ===
      JSON.stringify(right[field] ?? null),
  );
}

export async function loadCommonCoreCatalog(
  db: Db,
  input: unknown,
  now = new Date(),
) {
  const catalog = normalizeCommonCoreCatalog(input, now);
  const catalogs = db.collection("commonCoreCatalogs");
  await catalogs.createIndex(
    { catalogVersion: 1 },
    { unique: true, name: "common_core_catalog_identity" },
  );
  const existing = await catalogs.findOne({
    catalogVersion: catalog.catalogVersion,
  });
  if (existing && !sameContent(existing, catalog))
    throw new Error("COMMON_CORE_VERSION_CONTENT_MISMATCH");
  if (!existing) await catalogs.insertOne(catalog);

  const state = db.collection("commonCoreCatalogState");
  await state.createIndex(
    { stateId: 1 },
    { unique: true, name: "common_core_catalog_state" },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await state.findOne({ stateId: "common-core" });
    const revision = Number(current?.revision ?? 0);
    if (current?.activeCatalogVersion === catalog.catalogVersion)
      return {
        catalogVersion: catalog.catalogVersion,
        revision,
      };
    try {
      const result = await state.updateOne(
        { stateId: "common-core", revision },
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
        return {
          catalogVersion: catalog.catalogVersion,
          revision: revision + 1,
        };
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
  throw new Error("COMMON_CORE_POINTER_BUSY");
}
