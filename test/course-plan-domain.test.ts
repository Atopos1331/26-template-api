import { describe, expect, test } from "bun:test";
import {
  normalizeItemCreate,
  normalizeItemPatch,
  normalizePlanCreate,
  normalizePlanPatch,
  PlanError,
  planId,
} from "../src/domain/plans.js";

describe("course plan request validation", () => {
  test("normalizes a plan create request without accepting an owner", () => {
    expect(
      normalizePlanCreate({
        name: "  Fall plan ",
        termCode: "2530",
        description: "  Keep mornings free  ",
      }),
    ).toEqual({
      name: "Fall plan",
      termCode: "2530",
      description: "Keep mornings free",
    });
  });

  test("rejects unknown plan fields and invalid state transitions", () => {
    expect(() =>
      normalizePlanCreate({
        name: "x",
        termCode: "2530",
        ownerUsername: "bob",
      }),
    ).toThrow(PlanError);
    expect(() => normalizePlanPatch({ status: "draft" })).toThrow(PlanError);
  });

  test("normalizes an item reference but never accepts snapshots", () => {
    expect(
      normalizeItemCreate({
        offeringId: "2530:COMP2611",
        bundleId: "2530:COMP2611:12345",
        status: "alternative",
        note: "  Try this section  ",
        colorOverride: "#123456",
      }),
    ).toEqual({
      offeringId: "2530:COMP2611",
      bundleId: "2530:COMP2611:12345",
      status: "alternative",
      note: "Try this section",
      colorOverride: "#123456",
    });
    expect(() =>
      normalizeItemCreate({
        offeringId: "x",
        bundleId: "y",
        courseCodeSnapshot: "COMP2611",
      }),
    ).toThrow(PlanError);
  });

  test("only permits promotion of a non-rejected item", () => {
    expect(normalizeItemPatch({ status: "selected" })).toEqual({
      status: "selected",
    });
    expect(() => normalizeItemPatch({ status: "bad" })).toThrow(PlanError);
    expect(planId("507f1f77bcf86cd799439011").toHexString()).toBe(
      "507f1f77bcf86cd799439011",
    );
    expect(() => planId("not-an-object-id")).toThrow(/plan ID/);
  });
});
