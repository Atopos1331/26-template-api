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
    parts.length !== (kind === "offering" ? 4 : 5) ||
    parts[0] !== ACADEMIC_SOURCE ||
    !/^\d{2}(10|20|30|40)$/.test(parts[1] ?? "") ||
    !/^[A-Z]{2,8}\d+[A-Z]?$/.test(parts[2] ?? "") ||
    !/^[A-Za-z0-9_%.-]+$/.test(parts[3] ?? "") ||
    (kind === "section" && !/^\d+$/.test(parts[4] ?? ""))
  ) {
    throw new AcademicError("invalid_request", 400, "Invalid academic ID");
  }
  return { source: parts[0], termCode: parts[1] ?? "" };
}
