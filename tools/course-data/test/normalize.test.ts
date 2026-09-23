import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type Section, validate } from "../src/contract.ts";
import { BoundedClient } from "../src/fetch/client.ts";
import { makeBundles } from "../src/normalize/bundle.ts";
import { normalize } from "../src/normalize/index.ts";
import { parseUstTerm } from "../src/normalize/term.ts";
import {
  fetchTerm,
  listSubjects,
  parseCoursePage,
  type RawImport,
} from "../src/providers/ust-schedule.ts";

const html = await readFile(
  new URL("../fixtures/sample.html", import.meta.url),
  "utf8",
);
const raw = (subjectFilter: string | null = null): RawImport => ({
  source: "ust-class-schedule",
  termCode: "2530",
  fetchedAt: "2026-09-23T10:00:00.000Z",
  subjectFilter,
  subjects: ["COMP"],
  pageTotals: { COMP: 1 },
  pages: [{ subject: "COMP", page: 1, html }],
});

describe("UST source normalization", () => {
  test("parses the UST term code without inventing provider availability", () => {
    expect(parseUstTerm("2410").displayName).toBe("2024-25 Fall");
    expect(parseUstTerm("2530").displayName).toBe("2025-26 Spring");
    expect(parseUstTerm("2530").providerCurrent).toBeUndefined();
    expect(() => parseUstTerm("2590")).toThrow("TERM_CODE_INVALID");
  });

  test("keeps optional legacy term signals without inferring availability", () => {
    const input = {
      ...raw(),
      termSignals: { current: false, selectable: false },
    };
    expect(normalize(input).termMetadataCoverage).toBe("complete");
    expect(normalize(input).term.providerSelectable).toBe(false);
    expect(
      normalize({ ...raw(), termSignals: { current: true, selectable: true } })
        .term.providerCurrent,
    ).toBe(true);
  });

  test("preserves page fields and missing dates without placeholder meetings", () => {
    expect(listSubjects(html, "2530")).toEqual(["COMP"]);
    expect(parseCoursePage(html)[0]?.sections).toHaveLength(3);
    const data = normalize(raw());
    expect(data.isCompleteSnapshot).toBe(true);
    expect(data.sourceRecordCount).toBe(1);
    expect(data.sections[0]?.meetings[0]).toMatchObject({
      startDate: null,
      endDate: null,
      weekdays: ["MO", "WE"],
      startTime: "10:30",
      endTime: "11:50",
    });
    expect(data.bundles).toEqual([]);
    expect(data.warnings).toContain(
      `AMBIGUOUS_BINDING:${data.offerings[0]?.offeringId}`,
    );
    expect(data.quotaSnapshots[0]).toMatchObject({
      capacity: 120,
      enrolled: 100,
      remaining: 20,
    });
    const partial = normalize(raw("COMP"));
    expect(partial.isCompleteSnapshot).toBe(false);
    expect(partial.resourceCoverage.sections).toBe("partial");
  });

  test("rejects malformed quota, missing pages, unknown versions and duplicates", () => {
    const malformed = raw();
    malformed.pages[0]!.html = html.replace("<td>120</td>", "<td>?</td>");
    expect(() => normalize(malformed)).toThrow("QUOTA_INVALID");
    expect(() => normalize({ ...raw(), subjects: ["COMP", "MATH"] })).toThrow(
      "PAGE_COVERAGE_INVALID",
    );
    expect(() => normalize({ ...raw(), pageTotals: { COMP: 2 } })).toThrow(
      "PAGE_COVERAGE_INVALID",
    );
    const data = normalize(raw());
    expect(() =>
      validate({ ...data, schemaVersion: "course-data-v2" }),
    ).toThrow("SCHEMA_INVALID");
    expect(() =>
      validate({ ...data, sections: [...data.sections, data.sections[0]] }),
    ).toThrow("DUPLICATE_SECTION");
    expect(() =>
      validate({
        ...data,
        offerings: [{ ...data.offerings[0]!, offeringId: "COMP2611" }],
      }),
    ).toThrow("OFFERING_REFERENCE_INVALID");
    expect(() =>
      validate({ ...data, generatedAt: "2026-02-30T10:00:00Z" }),
    ).toThrow("TIMESTAMP_INVALID");
    const badMeeting = {
      ...data.sections[0]!,
      meetings: [
        { ...data.sections[0]!.meetings[0]!, startDate: "2026-02-30" },
      ],
    };
    expect(() =>
      validate({ ...data, sections: [badMeeting, ...data.sections.slice(1)] }),
    ).toThrow("MEETING_INVALID");
  });

  test("normalizes every advertised page of a subject", () => {
    const nextPage = html
      .replaceAll("2611", "2612")
      .replaceAll("12345", "22345")
      .replaceAll("12346", "22346")
      .replaceAll("12347", "22347");
    const input = raw();
    input.pageTotals.COMP = 2;
    input.pages.push({ subject: "COMP", page: 2, html: nextPage });
    const data = normalize(input);
    expect(data.isCompleteSnapshot).toBe(true);
    expect(data.sourceRecordCount).toBe(2);
    expect(data.sections).toHaveLength(6);
  });

  test("builds bound multi-component bundles with stable identity and aligned labels", () => {
    const sections = normalize(raw()).sections.map((row) => ({
      ...row,
      associatedClass: "1",
    }));
    const first = makeBundles(sections);
    expect(first.bundles).toHaveLength(1);
    expect(first.bundles[0]?.sectionLabels).toEqual(["L2", "LA1", "T2"]);
    expect(first.bundles[0]?.componentClassNbrs).toEqual([
      "12345",
      "12346",
      "12347",
    ]);
    const changed: Section[] = sections.map((row) =>
      row.classNbr === "12346" ? { ...row, sectionCode: "LA0" } : row,
    );
    expect(makeBundles(changed).bundles[0]?.bundleId).toBe(
      first.bundles[0]?.bundleId,
    );
    expect(makeBundles(changed).bundles[0]?.sectionLabels).toEqual([
      "L2",
      "LA0",
      "T2",
    ]);
    const overlapping = sections.map((row) =>
      row.classNbr === "12346"
        ? { ...row, meetings: sections[0]!.meetings }
        : row,
    );
    expect(makeBundles(overlapping).bundles).toHaveLength(0);
  });

  test("accepts only evidenced exact combinations for unknown bindings", () => {
    const verified = normalize(raw(), {
      termCode: "2530",
      offerings: [
        {
          courseCode: "COMP2611",
          evidence: "Registrar rules, 2026-09-23",
          combinations: [["12345", "12346", "12347"]],
        },
      ],
    });
    expect(verified.bundles).toHaveLength(1);
    expect(verified.bundles[0]?.source).toBe("operator-verified");
    expect(verified.bundles[0]?.bindingEvidence).toContain("Registrar");
    expect(() =>
      validate({
        ...verified,
        bundles: [{ ...verified.bundles[0]!, bindingEvidence: undefined }],
      }),
    ).toThrow("BINDING_EVIDENCE_REQUIRED");
    expect(() =>
      validate({
        ...verified,
        bundles: [
          { ...verified.bundles[0]!, sectionLabels: ["L9", "LA1", "T2"] },
        ],
      }),
    ).toThrow("BUNDLE_STRUCTURE_INVALID");
    validate({
      ...verified,
      bundles: [
        {
          ...verified.bundles[0]!,
          derivedSchedule: {
            meetings: verified.bundles[0]!.derivedSchedule.meetings.map(
              ({ timezone, ...meeting }) => ({ timezone, ...meeting }),
            ),
          },
        },
      ],
    });
    expect(() =>
      validate({
        ...verified,
        bundles: [
          { ...verified.bundles[0]!, derivedSchedule: { meetings: [] } },
        ],
      }),
    ).toThrow("BUNDLE_STRUCTURE_INVALID");
    const revoked = normalize(raw(), {
      termCode: "2530",
      offerings: [
        {
          courseCode: "COMP2611",
          evidence: "Registrar revocation checked 2026-09-23",
          combinations: [],
        },
      ],
    });
    expect(revoked.bundles).toEqual([]);
    expect(revoked.bindingOverrides).toEqual([
      verified.offerings[0]!.offeringId,
    ]);
    expect(() =>
      normalize(raw(), {
        termCode: "2530",
        offerings: [
          {
            courseCode: "COMP2611",
            evidence: "",
            combinations: [["12345", "12346", "12347"]],
          },
        ],
      }),
    ).toThrow("BINDING_EVIDENCE_REQUIRED");
    expect(() =>
      normalize(raw(), {
        termCode: "2530",
        offerings: [
          {
            courseCode: "COMP2611",
            evidence: "Registrar",
            combinations: [["12345", "12346"]],
          },
        ],
      }),
    ).toThrow("BINDING_COMBINATION_INVALID");
    expect(() =>
      normalize(raw(), {
        termCode: "2530",
        offerings: [
          {
            courseCode: "COMP2611",
            evidence: "Registrar",
            combinations: [["12345", "99999", "12347"]],
          },
        ],
      }),
    ).toThrow("BINDING_COMBINATION_INVALID");
  });

  test("keeps UG and PG offering identities distinct", () => {
    const base = normalize(raw());
    const course = base.courses[0]!;
    const ug = {
      ...base.offerings[0]!,
      academicCareer: "UG",
      offeringId: "ust-class-schedule:2530:COMP2611:UG",
    };
    const pg = {
      ...ug,
      academicCareer: "PG",
      offeringId: "ust-class-schedule:2530:COMP2611:PG",
    };
    validate({
      ...base,
      courses: [course],
      offerings: [ug, pg],
      sections: [],
      bundles: [],
      quotaSnapshots: [],
    });
    expect(ug.offeringId).not.toBe(pg.offeringId);
  });
});

describe("bounded fetch", () => {
  test("retries transient errors with backoff", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new BoundedClient({
      minIntervalMs: 0,
      retries: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        calls++;
        return new Response(calls === 1 ? "unavailable" : "ok", {
          status: calls === 1 ? 503 : 200,
        });
      },
    });
    expect(await client.get("https://example.test")).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toContain(250);
  });

  test("does not retry non-retryable errors and rejects oversized responses", async () => {
    let calls = 0;
    const client = new BoundedClient({
      retries: 2,
      minIntervalMs: 0,
      maxBytes: 2,
      fetchImpl: async () => {
        calls++;
        return new Response("not found", { status: 404 });
      },
    });
    await expect(client.get("https://example.test")).rejects.toThrow(
      "HTTP_404",
    );
    expect(calls).toBe(1);
    const oversized = new BoundedClient({
      retries: 0,
      minIntervalMs: 0,
      maxBytes: 2,
      fetchImpl: async () => new Response("long"),
    });
    await expect(oversized.get("https://example.test")).rejects.toThrow(
      "RESPONSE_TOO_LARGE",
    );
  });

  test("paces consecutive requests", async () => {
    const waits: number[] = [];
    const client = new BoundedClient({
      retries: 0,
      minIntervalMs: 1000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => new Response("ok"),
    });
    await client.get("https://example.test/one");
    await client.get("https://example.test/two");
    expect(waits.some((ms) => ms > 0)).toBe(true);
  });

  test("follows same-subject pages and refuses cross-origin links", async () => {
    const responses = [
      html,
      `${html}<a rel="next" href="?page=2">Next</a>`,
      html,
    ];
    const client = new BoundedClient({
      retries: 0,
      minIntervalMs: 0,
      fetchImpl: async () => new Response(responses.shift()),
    });
    const result = await fetchTerm(client, "2530", "COMP");
    expect(result.pageTotals.COMP).toBe(2);
    expect(result.termSignals).toBeUndefined();
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    const unsafe = new BoundedClient({
      retries: 0,
      minIntervalMs: 0,
      fetchImpl: async () =>
        new Response(
          `${html}<a rel="next" href="https://example.org/">Next</a>`,
        ),
    });
    await expect(fetchTerm(unsafe, "2530", "COMP")).rejects.toThrow(
      "PAGINATION_URL_INVALID",
    );
  });
});
