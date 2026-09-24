import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACADEMIC_SOURCE } from "../src/domain/academic.js";
import { CourseCatalogRepository } from "../src/repositories/course-catalog.js";

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

test("bounded quota histories retain the newest observations", async () => {
  const db = client.db(`course-catalog-${randomUUID()}`);
  const sectionId = "section-with-long-history";
  const firstAt = Date.UTC(2020, 0, 1);
  await db.collection("quotaSnapshots").insertMany(
    Array.from({ length: 50_001 }, (_, index) => ({
      source: ACADEMIC_SOURCE,
      sectionId,
      observedAt: new Date(firstAt + index).toISOString(),
      snapshotId: `snapshot-${String(index).padStart(5, "0")}`,
    })),
  );

  const catalog = new CourseCatalogRepository(db);
  for (const rows of [
    await catalog.quotaHistory([sectionId]),
    await catalog.quotaHistoryForSections([sectionId]),
  ]) {
    expect(rows).toHaveLength(50_000);
    expect(rows[0]?.snapshotId).toBe("snapshot-50000");
    expect(rows.at(-1)?.snapshotId).toBe("snapshot-00001");
  }
});
