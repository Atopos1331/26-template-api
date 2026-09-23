export type RevisionHeaderErrorCode =
  | "invalid_request"
  | "precondition_required";

export class RevisionHeaderError extends Error {
  constructor(
    readonly code: RevisionHeaderErrorCode,
    readonly statusCode: 400 | 428,
  ) {
    super(
      code === "precondition_required"
        ? "If-Match is required"
        : "Invalid If-Match header",
    );
    this.name = "RevisionHeaderError";
  }
}

export function formatRevisionEtag(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("Revision must be a positive safe integer");
  }
  return `"${revision}"`;
}

export function parseIfMatch(header: string | string[] | undefined): number {
  if (header === undefined) {
    throw new RevisionHeaderError("precondition_required", 428);
  }

  if (typeof header !== "string") {
    throw new RevisionHeaderError("invalid_request", 400);
  }

  const match = /^"([1-9]\d*)"$/.exec(header.replace(/^[ \t]+|[ \t]+$/g, ""));
  const revision = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(revision)) {
    throw new RevisionHeaderError("invalid_request", 400);
  }

  return revision;
}
