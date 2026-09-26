import type { CaseMetadata, CaseRecord } from "./types";

const fields = [
  "title",
  "category",
  "merchant",
  "orderNo",
  "amount",
  "goal",
  "deadline",
] as const;

/** Compare with the opening snapshot so unchanged fields retain newer tab edits. */
export function caseFormChanges(
  original: CaseRecord,
  submitted: CaseRecord,
): Partial<CaseMetadata> {
  return Object.fromEntries(
    fields
      .map((field) => [field, submitted[field].trim()] as const)
      .filter(([field, value]) => value !== original[field].trim()),
  );
}
