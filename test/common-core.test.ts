import { expect, test } from "bun:test";
import {
  normalizeCommonCoreCatalog,
  schemeForAdmissionYear,
} from "../src/domain/common-core.js";

const input = {
  sourceUrl: "https://example.edu/common-core.json",
  sourceTitle: "Common Core",
  sourceContentHash: "a".repeat(64),
  verifiedAt: "2026-09-23T00:00:00.000Z",
  verifier: "operator",
  evidence: "registrar source",
  schemes: [
    {
      schemeId: "2026",
      admissionYearFrom: 2026,
      admissionYearTo: 2029,
      categories: [
        {
          categoryId: "A",
          label: "Arts",
          courseCodes: ["HUMA1001", "COMP 1001"],
        },
      ],
    },
  ],
};

test("Common Core normalization is versioned and canonicalizes codes", () => {
  const catalog = normalizeCommonCoreCatalog(
    input,
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(catalog.catalogVersion).toHaveLength(64);
  expect(catalog.schemes[0]?.categories[0]?.courseCodes).toEqual([
    "HUMA1001",
    "COMP1001",
  ]);
  expect(schemeForAdmissionYear(catalog, 2027).schemeId).toBe("2026");
});

test("Common Core normalization canonicalizes equivalent timestamps", () => {
  const first = normalizeCommonCoreCatalog(
    input,
    new Date("2026-09-24T00:00:00.000Z"),
  );
  const second = normalizeCommonCoreCatalog(
    { ...input, verifiedAt: "2026-09-23T00:00:00Z" },
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(second.catalogVersion).toBe(first.catalogVersion);
  expect(second.verifiedAt).toBe(first.verifiedAt);
});

test("Common Core rejects overlapping admission cohorts", () => {
  expect(() =>
    normalizeCommonCoreCatalog(
      {
        ...input,
        schemes: [
          ...input.schemes,
          {
            ...input.schemes[0],
            schemeId: "overlap",
            admissionYearFrom: 2029,
            admissionYearTo: 2030,
          },
        ],
      },
      new Date("2026-09-24T00:00:00.000Z"),
    ),
  ).toThrow();
});

test("Common Core rejects duplicate schemes and malformed publication dates", () => {
  expect(() =>
    normalizeCommonCoreCatalog(
      {
        ...input,
        sourcePublishedAt: "not-a-date",
      },
      new Date("2026-09-24T00:00:00.000Z"),
    ),
  ).toThrow();
  expect(() =>
    normalizeCommonCoreCatalog(
      {
        ...input,
        schemes: [input.schemes[0], { ...input.schemes[0] }],
      },
      new Date("2026-09-24T00:00:00.000Z"),
    ),
  ).toThrow();
});
