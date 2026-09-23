import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../src/app.js";

let mongod: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
});

afterAll(async () => {
  await mongod?.stop();
});

async function buildApp(databaseName = `phase-02-${randomUUID()}`) {
  if (!mongod) throw new Error("MongoDB test server is unavailable");
  const app = Fastify();
  try {
    await app.register(fp(App), {
      mongoUri: mongod.getUri(databaseName),
      mongoTestUri: undefined,
      authSkip: true,
    });
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

const timestamp = "2026-09-23T10:00:00.000Z";

function manualEvent(ownerUsername: string, externalId?: string) {
  return {
    _id: new ObjectId(),
    ownerUsername,
    title: "Study group",
    startsAt: timestamp,
    endsAt: "2026-09-23T11:00:00.000Z",
    allDay: false,
    timezone: "Asia/Hong_Kong",
    source: "manual",
    readonly: false,
    revision: 1,
    blocksTime: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(externalId === undefined ? {} : { externalId }),
  };
}

describe("timetable collection bootstrap", () => {
  test("creates typed collections and indexes on repeated app starts", async () => {
    const databaseName = `phase-02-${randomUUID()}`;
    const first = await buildApp(databaseName);
    try {
      expect(first.collections.events.collectionName).toBe("events");
      expect(first.collections.idempotencyRecords.collectionName).toBe(
        "idempotencyRecords",
      );
    } finally {
      await first.close();
    }

    const second = await buildApp(databaseName);
    try {
      const eventIndexes = await second.collections.events
        .listIndexes()
        .toArray();
      const recordIndexes = await second.collections.idempotencyRecords
        .listIndexes()
        .toArray();

      expect(eventIndexes.map((index) => index.name).sort()).toEqual(
        [
          "_id_",
          "events_owner_start",
          "events_owner_updated",
          "events_manual_external_id",
          "events_import_identity",
          "events_owner_import",
        ].sort(),
      );
      expect(
        eventIndexes.find((index) => index.name === "events_owner_start")?.key,
      ).toEqual({ ownerUsername: 1, startsAt: 1, _id: 1 });
      expect(
        eventIndexes.find((index) => index.name === "events_owner_updated")
          ?.key,
      ).toEqual({ ownerUsername: 1, updatedAt: 1, _id: 1 });
      expect(
        eventIndexes.find((index) => index.name === "events_manual_external_id")
          ?.partialFilterExpression,
      ).toEqual({
        source: "manual",
        externalId: { $type: "string" },
        importId: null,
      });
      expect(
        eventIndexes.find((index) => index.name === "events_import_identity")
          ?.partialFilterExpression,
      ).toEqual({
        externalId: { $type: "string" },
        importId: { $type: "objectId" },
      });
      expect(recordIndexes.map((index) => index.name).sort()).toEqual(
        [
          "_id_",
          "idempotency_owner_route_key",
          "idempotency_expires_at",
        ].sort(),
      );
      expect(
        recordIndexes.find(
          (index) => index.name === "idempotency_owner_route_key",
        )?.key,
      ).toEqual({ ownerScope: 1, routeKey: 1, idempotencyKeyHash: 1 });
      expect(
        recordIndexes.find((index) => index.name === "idempotency_expires_at")
          ?.key,
      ).toEqual({ expiresAt: 1 });
      expect(
        recordIndexes.find((index) => index.name === "idempotency_expires_at")
          ?.expireAfterSeconds,
      ).toBe(0);
    } finally {
      await second.close();
    }
  });

  test("manual external IDs are unique per owner without blocking ordinary events", async () => {
    const app = await buildApp();
    try {
      const events = app.collections.events;
      await events.insertOne(manualEvent("alice"));
      await events.insertOne(manualEvent("alice"));
      await events.insertOne({ ...manualEvent("alice"), externalId: null });
      await events.insertOne({ ...manualEvent("alice"), externalId: null });
      await events.insertOne(manualEvent("alice", "client-1"));
      await events.insertOne(manualEvent("bob", "client-1"));
      await expect(
        events.insertOne({
          ...manualEvent("alice", "client-1"),
          importId: null,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    } finally {
      await app.close();
    }
  });

  test("imported versions use their manifest and recurrence ID for uniqueness", async () => {
    const app = await buildApp();
    try {
      const events = app.collections.events;
      const importId = new ObjectId();
      const master = {
        ...manualEvent("alice", "ics-uid-1"),
        source: "ics",
        readonly: true,
        importId,
        recurrenceId: null,
      };
      await events.insertOne(master);
      await expect(
        events.insertOne({ ...master, _id: new ObjectId() }),
      ).rejects.toMatchObject({ code: 11000 });
      await events.insertOne({
        ...master,
        _id: new ObjectId(),
        recurrenceId: timestamp,
      });
      await events.insertOne({
        ...master,
        _id: new ObjectId(),
        importId: new ObjectId(),
      });
    } finally {
      await app.close();
    }
  });

  test("idempotency keys are scoped and expiry is stored as a BSON Date", async () => {
    const app = await buildApp();
    try {
      const records = app.collections.idempotencyRecords;
      const expiresAt = new Date("2027-09-23T10:00:00.000Z");
      const record = {
        _id: new ObjectId(),
        ownerScope: "alice",
        routeKey: "POST /events",
        idempotencyKeyHash: "hash-1",
        requestHash: "request-1",
        operationId: "operation-1",
        state: "processing" as const,
        createdAt: timestamp,
        expiresAt,
      };
      await records.insertOne(record);
      await expect(
        records.insertOne({ ...record, _id: new ObjectId() }),
      ).rejects.toMatchObject({ code: 11000 });
      await records.insertOne({
        ...record,
        _id: new ObjectId(),
        ownerScope: "bob",
      });
      await records.insertOne({
        ...record,
        _id: new ObjectId(),
        routeKey: "POST /plans",
      });
      const stored = await records.findOne({ _id: record._id });
      expect(stored?.expiresAt).toBeInstanceOf(Date);
      expect(stored?.expiresAt.getTime()).toBe(expiresAt.getTime());
    } finally {
      await app.close();
    }
  });
});
