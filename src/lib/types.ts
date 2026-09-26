export const CATEGORIES = ["网购售后", "维修保修", "预付消费", "其他"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CaseEvent {
  id: string;
  /** The actual event date, or empty when unknown. Never inferred from entry time. */
  date: string;
  title: string;
  description: string;
  attachmentIds: string[];
}

export interface CaseRecord {
  id: string;
  title: string;
  category: Category;
  merchant: string;
  orderNo: string;
  amount: string;
  goal: string;
  status: "active" | "resolved";
  deadline: string;
  createdAt: string;
  updatedAt: string;
  events: CaseEvent[];
  checklist: string[];
}

export type CaseMetadata = Omit<
  CaseRecord,
  "id" | "createdAt" | "updatedAt" | "events"
>;

export interface Attachment {
  id: string;
  caseId: string;
  name: string;
  type: string;
  sha256: string;
  addedAt: string;
  size: number;
  blob: Blob;
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_BATCH_SIZE = 50 * 1024 * 1024;
export const MAX_ARCHIVE_SIZE = 200 * 1024 * 1024;
export const MAX_ATTACHMENTS = 200;
export const MAX_EVENTS = 1000;
