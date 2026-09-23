import type { Bundle, Meeting, Section } from "../contract.ts";

function overlaps(a: Meeting, b: Meeting): boolean {
  if (a.endDate && b.startDate && a.endDate < b.startDate) return false;
  if (b.endDate && a.startDate && b.endDate < a.startDate) return false;
  return (
    a.weekdays.some((day) => b.weekdays.includes(day)) &&
    a.startTime < b.endTime &&
    b.startTime < a.endTime
  );
}

export function makeBundles(sections: Section[]): {
  bundles: Bundle[];
  warnings: string[];
} {
  if (!sections.length) return { bundles: [], warnings: [] };
  const offeringId = sections[0]?.offeringId ?? "";
  const types = [...new Set(sections.map((row) => row.componentType))];
  const warnings: string[] = [];
  if (types.length > 1 && sections.some((row) => !row.associatedClass)) {
    return { bundles: [], warnings: [`AMBIGUOUS_BINDING:${offeringId}`] };
  }
  const groups =
    types.length === 1
      ? [sections]
      : [...new Set(sections.map((row) => row.associatedClass))].map(
          (binding) =>
            sections.filter((row) => row.associatedClass === binding),
        );
  const bundles: Bundle[] = [];
  for (const group of groups) {
    if (new Set(group.map((row) => row.componentType)).size !== types.length) {
      warnings.push(`INCOMPLETE_BINDING:${offeringId}`);
      continue;
    }
    const candidates = types.reduce<Section[][]>(
      (combinations, type) =>
        combinations.flatMap((parts) =>
          group
            .filter((row) => row.componentType === type)
            .map((row) => [...parts, row]),
        ),
      [[]],
    );
    for (const parts of candidates) {
      const order = ["LEC", "LAB", "TUT"];
      parts.sort(
        (a, b) =>
          order.indexOf(a.componentType) - order.indexOf(b.componentType) ||
          a.sectionCode.localeCompare(b.sectionCode) ||
          a.classNbr.localeCompare(b.classNbr),
      );
      const meetings = parts.flatMap((row) => row.meetings);
      if (
        parts.some((row, index) =>
          parts
            .slice(index + 1)
            .some((other) =>
              row.meetings.some((a) =>
                other.meetings.some((b) => overlaps(a, b)),
              ),
            ),
        )
      ) {
        warnings.push(`BUNDLE_TIME_CONFLICT:${offeringId}`);
        continue;
      }
      bundles.push({
        bundleId: `${offeringId}:${parts
          .map((row) => encodeURIComponent(row.classNbr))
          .sort()
          .join("+")}`,
        offeringId,
        leadClassNbr: parts[0]?.classNbr ?? "",
        componentClassNbrs: parts.map((row) => row.classNbr),
        componentTypes: parts.map((row) => row.componentType),
        sectionLabels: parts.map((row) => row.sectionCode),
        bindingGroup:
          types.length === 1 ? null : (parts[0]?.associatedClass ?? null),
        derivedSchedule: { meetings },
        source: "derived",
      });
    }
  }
  return { bundles, warnings };
}
