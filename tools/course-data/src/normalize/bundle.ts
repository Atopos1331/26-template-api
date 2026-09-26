import type { Bundle, Meeting, Section } from "../contract.ts";

export type VerifiedBindings = {
  termCode: string;
  offerings: Array<{
    courseCode: string;
    evidence: string;
    combinations: string[][];
  }>;
};

type LabelBinding = {
  sections: Section[];
  source: "derived-label";
};

type ParsedLabel = { group: string; variant: string };

function parseLabel(section: Section): ParsedLabel | null {
  const match = /^[A-Z]+([0-9]+)([A-Z]?)$/i.exec(section.sectionCode.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return null;
  return { group: String(number), variant: (match[2] ?? "").toUpperCase() };
}

/**
 * The public schedule omits associatedClass, but many offerings use matching
 * labels such as L1/LA1/T1. Infer only exact, auditable label groups; any
 * ambiguous shape remains unavailable until an operator verifies it.
 */
function inferLabelBinding(sections: Section[]): LabelBinding | null {
  if (sections.some((section) => section.associatedClass !== null)) return null;
  const byType = new Map<
    string,
    Map<string, Array<ParsedLabel & { section: Section }>>
  >();
  for (const section of sections) {
    const label = parseLabel(section);
    if (!label) return null;
    const entries = byType.get(section.componentType) ?? new Map();
    const group = entries.get(label.group) ?? [];
    group.push({ ...label, section });
    entries.set(label.group, group);
    byType.set(section.componentType, entries);
  }
  const groupsByType = [...byType.entries()];
  if (groupsByType.length < 2) return null;
  const groupKeys = [...groupsByType[0]![1].keys()].sort();
  if (!groupKeys.length) return null;
  for (const [componentType, entries] of groupsByType) {
    const keys = [...entries.keys()].sort();
    if (keys.join("\u0000") !== groupKeys.join("\u0000")) return null;
    for (const labels of entries.values()) {
      if (labels.length < 2) continue;
      if (
        componentType === "LEC" ||
        labels.some((label) => !label.variant) ||
        new Set(labels.map((label) => label.variant)).size !== labels.length
      )
        return null;
    }
  }
  const bound = sections.map((section) => ({
    ...section,
    associatedClass: parseLabel(section)!.group,
  }));
  return { sections: bound, source: "derived-label" };
}

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
  const inferred =
    new Set(sections.map((row) => row.componentType)).size > 1 &&
    sections.some((row) => !row.associatedClass)
      ? inferLabelBinding(sections)
      : null;
  const boundSections = inferred?.sections ?? sections;
  const types = [...new Set(boundSections.map((row) => row.componentType))];
  const warnings: string[] = [];
  if (types.length > 1 && boundSections.some((row) => !row.associatedClass)) {
    return { bundles: [], warnings: [`AMBIGUOUS_BINDING:${offeringId}`] };
  }
  const groups =
    types.length === 1
      ? [boundSections]
      : [...new Set(boundSections.map((row) => row.associatedClass))].map(
          (binding) =>
            boundSections.filter((row) => row.associatedClass === binding),
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
        source: inferred?.source ?? "derived",
      });
    }
  }
  if (inferred) warnings.push(`INFERRED_LABEL_BINDING:${offeringId}`);
  return { bundles, warnings };
}

export function makeVerifiedBundles(
  sections: Section[],
  combinations: string[][],
  evidence: string,
): Bundle[] {
  if (!evidence.trim()) throw new Error("BINDING_EVIDENCE_REQUIRED");
  if (!combinations.length) return [];
  if (!sections.length) throw new Error("BINDING_COMBINATION_INVALID");
  const byNumber = new Map(sections.map((row) => [row.classNbr, row]));
  const types = new Set(sections.map((row) => row.componentType));
  const seen = new Set<string>();
  return combinations.map((numbers, index) => {
    const selected = numbers.map((number) => byNumber.get(number));
    const identity = [...numbers].sort().join("+");
    if (
      numbers.length !== types.size ||
      new Set(numbers).size !== numbers.length ||
      selected.some((row) => !row) ||
      new Set(selected.map((row) => row?.componentType)).size !== types.size ||
      seen.has(identity)
    )
      throw new Error("BINDING_COMBINATION_INVALID");
    seen.add(identity);
    const result = makeBundles(
      selected.map((row) => ({ ...row!, associatedClass: String(index + 1) })),
    );
    if (result.bundles.length !== 1)
      throw new Error("BINDING_COMBINATION_CONFLICT");
    return {
      ...result.bundles[0]!,
      source: "operator-verified",
      bindingEvidence: evidence.trim(),
    };
  });
}
