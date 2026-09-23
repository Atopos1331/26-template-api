import { createHash } from "node:crypto";
import { PlanError } from "./plans.js";

export type CommonCoreCategory = {
  categoryId: string;
  label: string;
  courseCodes: string[];
};

export type CommonCoreScheme = {
  schemeId: string;
  admissionYearFrom: number;
  admissionYearTo: number;
  categories: CommonCoreCategory[];
};

export type CommonCoreCatalogInput = {
  sourceUrl: string;
  sourceTitle: string;
  sourcePublishedAt?: string | null;
  sourceContentHash: string;
  verifiedAt: string;
  verifier: string;
  evidence: string;
  schemes: CommonCoreScheme[];
};

export type CommonCoreCatalog = CommonCoreCatalogInput & {
  catalogVersion: string;
  importedAt: string;
};

function fail(field: string, message: string): never {
  throw new PlanError("invalid_request", 400, "Invalid Common Core catalog", {
    [field]: message,
  });
}

function code(value: unknown, field: string) {
  if (typeof value !== "string") return fail(field, "must be a string");
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2,8}\d+[A-Z]?$/.test(normalized))
    return fail(field, "must be a canonical course code");
  return normalized;
}

export function normalizeCommonCoreCatalog(
  input: unknown,
  now = new Date(),
): CommonCoreCatalog {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return fail("body", "must be an object");
  const value = input as Record<string, unknown>;
  let sourceUrl: string;
  try {
    const parsed = new URL(String(value.sourceUrl));
    if (parsed.protocol !== "https:" || !parsed.hostname)
      return fail("sourceUrl", "must be an HTTPS URL");
    sourceUrl = parsed.toString();
  } catch {
    return fail("sourceUrl", "must be an HTTPS URL");
  }
  for (const [field, max] of [
    ["sourceTitle", 200],
    ["verifier", 120],
    ["evidence", 2000],
  ] as const) {
    if (
      typeof value[field] !== "string" ||
      !value[field].trim() ||
      value[field].length > max
    )
      return fail(
        field,
        `must be a non-empty string of at most ${max} characters`,
      );
  }
  if (
    typeof value.sourceContentHash !== "string" ||
    !/^[a-f0-9]{32,128}$/i.test(value.sourceContentHash)
  )
    return fail("sourceContentHash", "must be a non-empty hexadecimal hash");
  if (
    value.sourcePublishedAt !== undefined &&
    value.sourcePublishedAt !== null &&
    (typeof value.sourcePublishedAt !== "string" ||
      !Number.isFinite(Date.parse(value.sourcePublishedAt)))
  )
    return fail("sourcePublishedAt", "must be a valid timestamp or null");
  if (
    typeof value.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(value.verifiedAt)) ||
    Date.parse(value.verifiedAt) > now.getTime()
  )
    return fail(
      "verifiedAt",
      "must be a valid timestamp that is not in the future",
    );
  if (
    !Array.isArray(value.schemes) ||
    value.schemes.length === 0 ||
    value.schemes.length > 50
  )
    return fail("schemes", "must contain 1..50 schemes");
  const schemes: CommonCoreScheme[] = [];
  const schemeIds = new Set<string>();
  for (const [schemeIndex, rawScheme] of value.schemes.entries()) {
    if (
      rawScheme === null ||
      typeof rawScheme !== "object" ||
      Array.isArray(rawScheme)
    )
      return fail(`schemes[${schemeIndex}]`, "must be an object");
    const scheme = rawScheme as Record<string, unknown>;
    const from = scheme.admissionYearFrom as number;
    const to = scheme.admissionYearTo as number;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1900 ||
      to < from
    )
      return fail(
        `schemes[${schemeIndex}]`,
        "must have a valid inclusive admission-year range",
      );
    if (typeof scheme.schemeId !== "string" || !scheme.schemeId.trim())
      return fail(`schemes[${schemeIndex}].schemeId`, "is required");
    const schemeId = scheme.schemeId.trim();
    if (schemeIds.has(schemeId))
      return fail("schemes", "scheme IDs must be unique");
    schemeIds.add(schemeId);
    if (
      !Array.isArray(scheme.categories) ||
      scheme.categories.length === 0 ||
      scheme.categories.length > 100
    )
      return fail(
        `schemes[${schemeIndex}].categories`,
        "must contain 1..100 categories",
      );
    const categoryIds = new Set<string>();
    const categories: CommonCoreCategory[] = [];
    for (const [categoryIndex, rawCategory] of scheme.categories.entries()) {
      if (
        rawCategory === null ||
        typeof rawCategory !== "object" ||
        Array.isArray(rawCategory)
      )
        return fail(
          `schemes[${schemeIndex}].categories[${categoryIndex}]`,
          "must be an object",
        );
      const category = rawCategory as Record<string, unknown>;
      const categoryId =
        typeof category.categoryId === "string"
          ? category.categoryId.trim()
          : "";
      if (!categoryId)
        return fail(
          `schemes[${schemeIndex}].categories[${categoryIndex}].categoryId`,
          "is required",
        );
      if (categoryIds.has(categoryId))
        return fail(
          `schemes[${schemeIndex}].categories`,
          "category IDs must be unique",
        );
      categoryIds.add(categoryId);
      if (typeof category.label !== "string" || !category.label.trim())
        return fail(
          `schemes[${schemeIndex}].categories[${categoryIndex}].label`,
          "is required",
        );
      if (
        !Array.isArray(category.courseCodes) ||
        category.courseCodes.length > 10_000
      )
        return fail(
          `schemes[${schemeIndex}].categories[${categoryIndex}].courseCodes`,
          "must contain at most 10000 codes",
        );
      const codes = category.courseCodes.map((entry, index) =>
        code(
          entry,
          `schemes[${schemeIndex}].categories[${categoryIndex}].courseCodes[${index}]`,
        ),
      );
      if (new Set(codes).size !== codes.length)
        return fail(
          `schemes[${schemeIndex}].categories[${categoryIndex}].courseCodes`,
          "course codes must be unique",
        );
      categories.push({
        categoryId,
        label: category.label.trim(),
        courseCodes: codes,
      });
    }
    schemes.push({
      schemeId,
      admissionYearFrom: from,
      admissionYearTo: to,
      categories,
    });
  }
  for (let index = 0; index < schemes.length; index++) {
    for (let other = index + 1; other < schemes.length; other++) {
      if (
        schemes[index]!.admissionYearFrom <= schemes[other]!.admissionYearTo &&
        schemes[other]!.admissionYearFrom <= schemes[index]!.admissionYearTo
      )
        return fail("schemes", "admission-year ranges must not overlap");
    }
  }
  const normalized = {
    sourceUrl,
    sourceTitle: (value.sourceTitle as string).trim(),
    sourcePublishedAt:
      typeof value.sourcePublishedAt === "string"
        ? new Date(value.sourcePublishedAt).toISOString()
        : null,
    sourceContentHash: (value.sourceContentHash as string).toLowerCase(),
    verifiedAt: new Date(value.verifiedAt as string).toISOString(),
    verifier: (value.verifier as string).trim(),
    evidence: (value.evidence as string).trim(),
    schemes,
  };
  const catalogVersion = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return { ...normalized, catalogVersion, importedAt: now.toISOString() };
}

export function schemeForAdmissionYear(
  catalog: CommonCoreCatalog,
  admissionYear: number,
) {
  const scheme = catalog.schemes.find(
    (item) =>
      admissionYear >= item.admissionYearFrom &&
      admissionYear <= item.admissionYearTo,
  );
  if (!scheme)
    throw new PlanError(
      "common_core_unavailable",
      404,
      "Common Core classification is unavailable for this admission year",
    );
  return scheme;
}
