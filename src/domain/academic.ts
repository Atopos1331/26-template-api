export const ACADEMIC_SOURCE = "ust-class-schedule";

export class AcademicError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function academicIdentity(
  id: string,
  kind: "offering" | "section",
): { source: string; termCode: string } {
  const parts = id.split(":");
  if (
    parts.length !== (kind === "offering" ? 2 : 3) ||
    !/^\d{2}(10|20|30|40)$/.test(parts[0] ?? "") ||
    !/^[A-Z]{2,8}\d+[A-Z]?$/.test(parts[1] ?? "") ||
    (kind === "section" && !/^\d+$/.test(parts[2] ?? ""))
  ) {
    throw new AcademicError("invalid_request", 400, "Invalid academic ID");
  }
  return { source: ACADEMIC_SOURCE, termCode: parts[0] ?? "" };
}
