import { load } from "cheerio";
import type { BoundedClient } from "../fetch/client.ts";
import { parseUstTerm } from "../normalize/term.ts";

export type RawSection = {
  section: string;
  classNbr: string;
  classType?: string | null;
  componentType?: string | null;
  associatedClass?: string | null;
  instructors: string[];
  schedules: Array<{
    weekdays: string;
    startTime: string;
    endTime: string;
    startDt?: string | null;
    endDt?: string | null;
    venue: string | null;
    facilityId?: string | null;
  }>;
  enrlCap: string | null;
  enrlTot: string | null;
  remaining: string | null;
  waitTot: string | null;
  reserveCap?: string | null;
  consent?: boolean | null;
  classOpen?: boolean | null;
  remarks: string | null;
};
export type RawCourse = {
  subject: string;
  catalogNbr: string;
  title: string;
  credit: string | null;
  crseId?: string | null;
  academicCareer?: string | null;
  description?: string | null;
  longDesc?: string | null;
  preReq?: string | null;
  coReq?: string | null;
  exclusion?: string | null;
  prevCrseCode?: string | null;
  attributes?: Record<string, string>;
  sections: RawSection[];
};
export type RawImport = {
  source: "ust-class-schedule";
  termCode: string;
  fetchedAt: string;
  subjectFilter: string | null;
  subjects: string[];
  pageTotals: Record<string, number>;
  pages: Array<{ subject: string; page: number; html: string }>;
  termSignals?: { current: boolean; selectable: boolean };
};

const base = "https://w5.ab.ust.hk/wcq/cgi-bin";
const text = (value: string) => value.replace(/\s+/g, " ").trim();

export function listSubjects(html: string, termCode: string): string[] {
  const $ = load(html);
  return [
    ...new Set(
      $("#subjectItems a[href]")
        .toArray()
        .map((element) => {
          const href = $(element).attr("href") ?? "";
          const match = new RegExp(
            `/wcq/cgi-bin/${termCode}/subject/([A-Z]+)$`,
          ).exec(href);
          return match?.[1];
        })
        .filter((value): value is string => !!value),
    ),
  ].sort();
}

function parseTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})(AM|PM)$/i.exec(value.trim());
  if (!match) return null;
  const hour =
    (Number(match[1]) % 12) + (match[3]?.toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function parseCoursePage(html: string): RawCourse[] {
  const $ = load(html);
  const results: RawCourse[] = [];
  $("#classes .course").each((_, node) => {
    const course = $(node);
    const heading = text(course.find(".subject").first().text());
    const match =
      /^([A-Z]+)\s+([0-9]+[A-Z]*)\s+-\s+(.+?)\s+\((\d+(?:\.\d+)?)\s+units?\)/i.exec(
        heading,
      );
    if (!match)
      throw new Error(`COURSE_HEADING_INVALID: ${heading.slice(0, 80)}`);
    const attrs: Record<string, string> = {};
    course
      .find(
        ".courseattr .popupdetail > table > tbody > tr, .courseattr .popupdetail > table > tr",
      )
      .each((_, row) => {
        const key = text($(row).children("th").first().text()).toUpperCase();
        const value = text($(row).children("td").first().text());
        if (key && value) attrs[key] = value;
      });
    const sections: RawSection[] = [];
    const rows = course
      .find("table.sections")
      .first()
      .children("tbody")
      .children("tr")
      .toArray();
    for (let i = 0; i < rows.length; i++) {
      const row = $(rows[i]);
      if (!row.hasClass("newsect")) continue;
      const cells = row.children("td");
      const sectionMatch = /^([A-Z]+\d*[A-Z]*)\s*\((\d+)\)/.exec(
        text(cells.eq(0).text()),
      );
      if (!sectionMatch)
        throw new Error(`SECTION_HEADING_INVALID: ${text(cells.eq(0).text())}`);
      const schedules: RawSection["schedules"] = [];
      const instructors = new Set<string>();
      for (let j = i; j < rows.length; j++) {
        const detail = $(rows[j]);
        if (j > i && detail.hasClass("newsect")) break;
        if (
          detail.hasClass("mobileInstructorRow") ||
          detail.hasClass("mobileViewDetail")
        )
          continue;
        const parts = detail.children("td");
        parts
          .eq(3)
          .find("a")
          .each((_, name) => {
            instructors.add(text($(name).text()));
          });
        const time = text(parts.eq(1).text());
        const timeMatch =
          /^((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)/i.exec(
            time,
          );
        if (!timeMatch) continue;
        const startTime = parseTime(timeMatch[2] ?? "");
        const endTime = parseTime(timeMatch[3] ?? "");
        if (!startTime || !endTime) throw new Error("SCHEDULE_TIME_INVALID");
        const venue = text(parts.eq(2).text());
        schedules.push({
          weekdays: timeMatch[1] ?? "",
          startTime,
          endTime,
          venue: venue && venue !== "TBA" ? venue : null,
        });
      }
      const numeric = (index: number) =>
        text(
          cells.eq(index).clone().find(".quotadetail").remove().end().text(),
        ) || null;
      sections.push({
        section: sectionMatch[1] ?? "",
        classNbr: sectionMatch[2] ?? "",
        instructors: [...instructors].filter(Boolean),
        schedules,
        enrlCap: numeric(5),
        enrlTot: numeric(6),
        remaining: numeric(7),
        waitTot: numeric(8),
        remarks: numeric(9),
      });
    }
    results.push({
      subject: match[1] ?? "",
      catalogNbr: match[2] ?? "",
      title: match[3] ?? "",
      credit: match[4] ?? null,
      description: attrs.DESCRIPTION ?? null,
      longDesc: attrs.DESCRIPTION ?? null,
      preReq: attrs["PRE-REQUISITE"] ?? null,
      coReq: attrs["CO-REQUISITE"] ?? null,
      exclusion: attrs.EXCLUSION ?? null,
      prevCrseCode: attrs["PREVIOUS CODE"] ?? null,
      attributes: attrs,
      sections,
    });
  });
  return results;
}

export async function fetchTerm(
  client: BoundedClient,
  termCode: string,
  subject?: string,
): Promise<RawImport> {
  parseUstTerm(termCode);
  const index = await client.get(`${base}/${termCode}/`);
  const subjects = listSubjects(index, termCode);
  if (!subjects.length) throw new Error("SUBJECT_LIST_EMPTY");
  if (subject && !subjects.includes(subject))
    throw new Error("SUBJECT_NOT_FOUND");
  const selected = subject ? [subject] : subjects;
  const pages: RawImport["pages"] = [];
  const pageTotals: Record<string, number> = {};
  for (const code of selected) {
    let url: string | null = `${base}/${termCode}/subject/${code}`;
    const visited = new Set<string>();
    let page = 0;
    while (url) {
      if (visited.has(url) || page >= 50) throw new Error("PAGINATION_LOOP");
      visited.add(url);
      const html = await client.get(url);
      if (!parseCoursePage(html).length) throw new Error("PAGE_EMPTY");
      pages.push({ subject: code, page: ++page, html });
      const $ = load(html);
      const next = $("a[href]")
        .toArray()
        .find((element) => {
          const link = $(element);
          return (
            link.attr("rel") === "next" ||
            ((link.hasClass("next") ||
              link.closest(".pagination").length > 0) &&
              /^(next|›|»)$/i.test(text(link.text())))
          );
        });
      if (!next) {
        url = null;
        continue;
      }
      const candidate = new URL($(next).attr("href") ?? "", url);
      const expected = new URL(`${base}/${termCode}/subject/${code}`);
      if (
        candidate.origin !== expected.origin ||
        candidate.pathname.replace(/\/$/, "") !== expected.pathname
      )
        throw new Error("PAGINATION_URL_INVALID");
      url = candidate.toString();
    }
    pageTotals[code] = page;
  }
  return {
    source: "ust-class-schedule",
    termCode,
    fetchedAt: new Date().toISOString(),
    subjectFilter: subject ?? null,
    subjects,
    pageTotals,
    pages,
  };
}
