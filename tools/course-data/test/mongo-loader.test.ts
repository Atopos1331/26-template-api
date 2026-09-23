import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { CourseData } from "../src/contract.ts";
import { normalize } from "../src/normalize/index.ts";
import {
  ensureAcademicIndexes,
  loadBatch,
  rollbackBatch,
} from "../src/output/mongo-loader.ts";

const html = await readFile(
  new URL("../fixtures/sample.html", import.meta.url),
  "utf8",
);
const second = load(html)(".course")
  .first()
  .toString()
  .replaceAll("2611", "2612")
  .replaceAll("12345", "22345")
  .replaceAll("12346", "22346")
  .replaceAll("12347", "22347")
  .replace("Computer Organization", "Software Design");
if (!second) throw new Error("FIXTURE_INVALID");

function batch(
  two = false,
  partial = false,
  at = "2026-09-23T10:00:00.000Z",
): CourseData {
  const page = two ? html.replace(/<\/div>\s*$/, `${second}\n</div>`) : html;
  return normalize({
    source: "ust-class-schedule",
    termCode: "2530",
    fetchedAt: at,
    subjectFilter: partial ? "COMP" : null,
    subjects: ["COMP"],
    pageTotals: { COMP: 1 },
    pages: [{ subject: "COMP", page: 1, html: page }],
  });
}

let server: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

const db = () => client.db(`course-tool-${randomUUID()}`);

describe("staged academic imports", () => {
  test("requires a complete first batch, keeps the pointer empty after rejection", async () => {
    const database = db();
    await expect(loadBatch(database, batch(false, true))).rejects.toThrow(
      "FIRST_BATCH_REQUIRES_COMPLETE_STRUCTURE",
    );
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).not.toHaveProperty("activeImportBatchId");
  });

  test("stages, activates and replays the same batch idempotently", async () => {
    const database = db();
    const data = batch();
    const id = "first-batch";
    expect(await loadBatch(database, data, { importBatchId: id })).toBe(id);
    expect(await loadBatch(database, data, { importBatchId: id })).toBe(id);
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({ activeImportBatchId: id });
    expect(
      await database
        .collection("courses")
        .countDocuments({ importBatchId: id }),
    ).toBe(1);
    expect(await database.collection("quotaSnapshots").countDocuments()).toBe(
      3,
    );
    expect(await database.collection("latestQuotas").countDocuments()).toBe(3);
    await expect(
      loadBatch(
        database,
        { ...data, generatedAt: "2026-09-24T00:00:00.000Z" },
        { importBatchId: id },
      ),
    ).rejects.toThrow("BATCH_ID_REUSED");
  });

  test("canonicalizes equivalent timestamps before persisting observations", async () => {
    const database = db();
    const data = batch();
    data.generatedAt = data.generatedAt.replace(".000Z", "Z");
    for (const row of data.quotaSnapshots) {
      row.observedAt = row.observedAt.replace(".000Z", "Z");
      row.snapshotId = `${row.sectionId}@${row.observedAt}`;
    }
    await loadBatch(database, data, { importBatchId: "canonical-time" });
    const stored = await database
      .collection("quotaSnapshots")
      .findOne({ sectionId: data.sections[0]?.sectionId });
    expect(stored?.observedAt).toBe("2026-09-23T10:00:00.000Z");
  });

  test("copies forward a partial batch and retires missing complete records", async () => {
    const database = db();
    const first = await loadBatch(database, batch(true), {
      importBatchId: "complete-a",
    });
    expect(first).toBe("complete-a");
    await loadBatch(database, batch(false, true), {
      importBatchId: "partial-b",
    });
    expect(
      await database
        .collection("courses")
        .countDocuments({ importBatchId: "partial-b", retiredAt: null }),
    ).toBe(2);
    expect(
      await database
        .collection("importRuns")
        .findOne({ importBatchId: "partial-b" }),
    ).toMatchObject({ lastCompleteSourceCounts: { courses: 2 } });
    await loadBatch(database, batch(), { importBatchId: "complete-c" });
    const retired = await database
      .collection("courses")
      .findOne({ importBatchId: "complete-c", courseId: "COMP2612" });
    expect(retired?.retiredAt).toBeString();
    expect(
      await database
        .collection("courses")
        .countDocuments({ importBatchId: "complete-c", retiredAt: null }),
    ).toBe(1);
  });

  test("copies unavailable resources forward without retiring them", async () => {
    const database = db();
    await loadBatch(database, batch(true), { importBatchId: "resource-a" });
    const partial = batch(false, true);
    partial.sections = [];
    partial.bundles = [];
    partial.quotaSnapshots = [];
    partial.resourceCoverage.sections = "unavailable";
    partial.resourceCoverage.bundles = "unavailable";
    await loadBatch(database, partial, { importBatchId: "resource-b" });
    expect(
      await database
        .collection("classSections")
        .countDocuments({ importBatchId: "resource-b", retiredAt: null }),
    ).toBe(6);
    expect(
      await database
        .collection("courses")
        .countDocuments({ importBatchId: "resource-b", retiredAt: null }),
    ).toBe(2);
  });

  test("rejects suspicious drops without replacing the last good batch", async () => {
    const database = db();
    await loadBatch(database, batch(true), { importBatchId: "good" });
    await expect(
      loadBatch(database, batch(), {
        importBatchId: "drop",
        maxDropFraction: 0.1,
      }),
    ).rejects.toThrow("SUSPICIOUS_COURSES_DROP");
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({ activeImportBatchId: "good" });
  });

  test("recovers after pointer switch and keeps a newer quota observation", async () => {
    const database = db();
    const initial = batch();
    await loadBatch(database, initial, { importBatchId: "before" });
    const older = batch(false, false, "2026-09-22T10:00:00.000Z");
    await expect(
      loadBatch(database, older, {
        importBatchId: "crash",
        afterActivation: async () => {
          throw new Error("SIMULATED_CRASH");
        },
      }),
    ).rejects.toThrow("SIMULATED_CRASH");
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({ activeImportBatchId: "crash" });
    await database
      .collection("importRuns")
      .updateOne({ importBatchId: "crash" }, { $set: { status: "ready" } });
    await loadBatch(database, older, { importBatchId: "crash" });
    expect(
      await database
        .collection("importRuns")
        .findOne({ importBatchId: "crash" }),
    ).toMatchObject({ status: "succeeded" });
    const latest = await database
      .collection("latestQuotas")
      .findOne({ sectionId: initial.sections[0]?.sectionId });
    expect(latest?.observedAt).toBe(initial.generatedAt);
  });

  test("rolls back the pointer and the effective term metadata together", async () => {
    const database = db();
    const first = batch();
    first.termMetadataCoverage = "complete";
    first.term.providerCurrent = true;
    first.term.providerSelectable = true;
    await loadBatch(database, first, { importBatchId: "metadata-a" });
    const partialMetadata = batch(false, true, "2026-09-23T11:00:00.000Z");
    partialMetadata.termMetadataCoverage = "partial";
    partialMetadata.term.providerCurrent = false;
    await loadBatch(database, partialMetadata, {
      importBatchId: "metadata-partial",
    });
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({ providerCurrent: false, providerSelectable: true });
    const secondBatch = batch(false, false, "2026-09-24T10:00:00.000Z");
    secondBatch.termMetadataCoverage = "complete";
    secondBatch.term.providerCurrent = false;
    secondBatch.term.providerSelectable = false;
    await loadBatch(database, secondBatch, { importBatchId: "metadata-b" });
    const unknownSignals = batch(false, false, "2026-09-25T10:00:00.000Z");
    unknownSignals.termMetadataCoverage = "complete";
    await loadBatch(database, unknownSignals, { importBatchId: "metadata-c" });
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({ providerCurrent: false, providerSelectable: false });
    await rollbackBatch(
      database,
      first.source,
      first.term.termCode,
      "metadata-a",
    );
    expect(
      await database.collection("academicTerms").findOne({ termCode: "2530" }),
    ).toMatchObject({
      activeImportBatchId: "metadata-a",
      providerCurrent: true,
      providerSelectable: true,
    });
  });

  test("refuses rollback to a batch whose retained documents are gone", async () => {
    const database = db();
    const data = batch();
    await loadBatch(database, data, { importBatchId: "retained" });
    await database
      .collection("courses")
      .deleteMany({ importBatchId: "retained" });
    await expect(
      rollbackBatch(database, data.source, data.term.termCode, "retained"),
    ).rejects.toThrow("ROLLBACK_TARGET_MISSING");
  });

  test("indexes are repeatable and a held import lease blocks another importer", async () => {
    const database = db();
    await ensureAcademicIndexes(database);
    await ensureAcademicIndexes(database);
    await database.collection("academicTerms").insertOne({
      source: "ust-class-schedule",
      termCode: "2530",
      importFence: 4,
      importLeaseOwner: "other",
      importLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(loadBatch(database, batch())).rejects.toThrow(
      "IMPORT_LEASE_BUSY",
    );
  });
});
