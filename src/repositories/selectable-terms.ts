import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";

export async function selectableTerms(db: Db): Promise<Document[]> {
  return db
    .collection("academicTerms")
    .find({ source: ACADEMIC_SOURCE, activeImportBatchId: { $type: "string" } })
    .sort({ sortKey: -1, termCode: 1 })
    .limit(4)
    .toArray();
}
