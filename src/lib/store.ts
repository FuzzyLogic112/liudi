import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Attachment, CaseEvent, CaseMetadata, CaseRecord } from "./types";
import {
  MAX_ARCHIVE_SIZE,
  MAX_ATTACHMENTS,
  MAX_BATCH_SIZE,
  MAX_EVENTS,
  MAX_FILE_SIZE,
} from "./types";
import {
  assertUnique,
  attachmentMetadataSchema,
  caseSchema,
  eventSchema,
  hashBytes,
} from "./validation";

interface LiudiDatabase extends DBSchema {
  cases: { key: string; value: CaseRecord };
  attachments: {
    key: string;
    value: Attachment;
    indexes: { "by-case": string };
  };
}

export const DATABASE_NAME = "liudi-local-v1";
// Reserve room for the manifest and the printable report in a restorable archive.
export const MAX_CASE_FILE_BYTES = MAX_ARCHIVE_SIZE - 10 * 1024 * 1024;
let database: Promise<IDBPDatabase<LiudiDatabase>> | undefined;

function db() {
  database ??= openDB<LiudiDatabase>(DATABASE_NAME, 1, {
    upgrade(connection) {
      connection.createObjectStore("cases", { keyPath: "id" });
      connection
        .createObjectStore("attachments", { keyPath: "id" })
        .createIndex("by-case", "caseId");
    },
    terminated() {
      database = undefined;
    },
    blocking() {
      void database?.then((connection) => connection.close());
      database = undefined;
    },
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

function metadata(record: CaseRecord): CaseMetadata {
  const {
    title,
    category,
    merchant,
    orderNo,
    amount,
    goal,
    status,
    deadline,
    checklist,
  } = record;
  return {
    title,
    category,
    merchant,
    orderNo,
    amount,
    goal,
    status,
    deadline,
    checklist,
  };
}

export async function listCases(): Promise<CaseRecord[]> {
  const records = await (await db()).getAll("cases");
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Existing records always retain the latest stored events, even with an old UI snapshot. */
export async function saveCase(input: CaseRecord): Promise<void> {
  const parsed = caseSchema.parse(input);
  const connection = await db();
  const transaction = connection.transaction("cases", "readwrite");
  const existing = await transaction.store.get(parsed.id);
  if (!existing && parsed.events.length)
    throw new Error("请通过新增记录或导入备份写入时间线");
  const record: CaseRecord = existing
    ? { ...existing, ...metadata(parsed), updatedAt: new Date().toISOString() }
    : parsed;
  await Promise.all([transaction.done, transaction.store.put(record)]);
}

/** A partial update performs its read and write in one IndexedDB transaction. */
export async function updateCaseMeta(
  caseId: string,
  patch: Partial<CaseMetadata>,
): Promise<void> {
  const connection = await db();
  const transaction = connection.transaction("cases", "readwrite");
  const existing = await transaction.store.get(caseId);
  if (!existing) throw new Error("事项不存在，可能已在其他窗口删除");
  const parsed = caseSchema.parse({
    ...existing,
    ...metadata({ ...existing, ...patch }),
  });
  await Promise.all([
    transaction.done,
    transaction.store.put({
      ...existing,
      ...metadata(parsed),
      updatedAt: new Date().toISOString(),
    }),
  ]);
}

/** Change one checklist item against the current record, including across tabs. */
export async function toggleChecklist(
  caseId: string,
  item: string,
  checked: boolean,
): Promise<void> {
  const transaction = (await db()).transaction("cases", "readwrite");
  const record = await transaction.store.get(caseId);
  if (!record) throw new Error("事项不存在，可能已在其他窗口删除");
  const checklist = new Set(record.checklist);
  if (checked) checklist.add(item);
  else checklist.delete(item);
  const updated = caseSchema.parse({
    ...record,
    checklist: [...checklist],
    updatedAt: new Date().toISOString(),
  });
  await Promise.all([transaction.done, transaction.store.put(updated)]);
}

export async function getAttachments(caseId: string): Promise<Attachment[]> {
  return (await db()).getAllFromIndex("attachments", "by-case", caseId);
}

export async function getCaseSnapshot(
  caseId: string,
): Promise<{ record: CaseRecord; attachments: Attachment[] }> {
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readonly",
  );
  const [record, attachments] = await Promise.all([
    transaction.objectStore("cases").get(caseId),
    transaction.objectStore("attachments").index("by-case").getAll(caseId),
  ]);
  await transaction.done;
  if (!record) throw new Error("事项不存在，可能已在其他窗口删除");
  return { record, attachments };
}

export async function addEvent(
  caseId: string,
  input: Omit<CaseEvent, "id" | "attachmentIds">,
  files: File[],
): Promise<void> {
  if (files.length > MAX_ATTACHMENTS)
    throw new Error(`附件不能超过 ${MAX_ATTACHMENTS} 个`);
  if (files.some((file) => file.size > MAX_FILE_SIZE))
    throw new Error("单个文件不能超过 20 MiB");
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_SIZE)
    throw new Error("每次添加的附件不能超过 50 MiB");
  const event = eventSchema.parse({
    ...input,
    id: crypto.randomUUID(),
    attachmentIds: [],
  });
  const addedAt = new Date().toISOString();
  // Read and hash before opening a transaction: asynchronous crypto must not outlive it.
  const attachments: Attachment[] = [];
  for (const file of files) {
    const attachment = {
      id: crypto.randomUUID(),
      caseId,
      name: file.name,
      type: file.type,
      sha256: await hashBytes(new Uint8Array(await file.arrayBuffer())),
      addedAt,
      size: file.size,
    };
    attachments.push({
      ...attachmentMetadataSchema.parse(attachment),
      blob: file,
    });
  }
  event.attachmentIds = attachments.map((attachment) => attachment.id);
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readwrite",
  );
  const caseStore = transaction.objectStore("cases");
  const attachmentStore = transaction.objectStore("attachments");
  const [record, previous] = await Promise.all([
    caseStore.get(caseId),
    attachmentStore.index("by-case").getAll(caseId),
  ]);
  if (!record) throw new Error("事项不存在，可能已在其他窗口删除");
  if (record.events.length >= MAX_EVENTS)
    throw new Error(`每个事项最多 ${MAX_EVENTS} 条记录`);
  if (previous.length + attachments.length > MAX_ATTACHMENTS)
    throw new Error(`每个事项最多 ${MAX_ATTACHMENTS} 个附件`);
  if (
    [...previous, ...attachments].reduce((sum, file) => sum + file.size, 0) >
    MAX_CASE_FILE_BYTES
  ) {
    throw new Error("本事项附件已达到 190 MiB 上限，请新建事项整理");
  }
  const recordWithEvent = caseSchema.parse({
    ...record,
    events: [...record.events, event],
    updatedAt: addedAt,
  });
  await Promise.all([
    transaction.done,
    caseStore.put(recordWithEvent),
    ...attachments.map((attachment) => attachmentStore.add(attachment)),
  ]);
}

export async function deleteEvent(
  caseId: string,
  eventId: string,
): Promise<void> {
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readwrite",
  );
  const caseStore = transaction.objectStore("cases");
  const record = await caseStore.get(caseId);
  if (!record) throw new Error("事项不存在，可能已在其他窗口删除");
  const event = record.events.find((item) => item.id === eventId);
  if (!event) return;
  await Promise.all([
    transaction.done,
    caseStore.put({
      ...record,
      events: record.events.filter((item) => item.id !== eventId),
      updatedAt: new Date().toISOString(),
    }),
    ...event.attachmentIds.map((id) =>
      transaction.objectStore("attachments").delete(id),
    ),
  ]);
}

export async function deleteCase(caseId: string): Promise<void> {
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readwrite",
  );
  const attachmentStore = transaction.objectStore("attachments");
  const attachmentIds = await attachmentStore
    .index("by-case")
    .getAllKeys(caseId);
  await Promise.all([
    transaction.done,
    transaction.objectStore("cases").delete(caseId),
    ...attachmentIds.map((id) => attachmentStore.delete(id)),
  ]);
}

export function validateSnapshot(
  record: CaseRecord,
  attachments: Attachment[],
): void {
  caseSchema.parse(record);
  if (attachments.length > MAX_ATTACHMENTS) throw new Error("附件数量超过上限");
  if (
    attachments.reduce((sum, attachment) => sum + attachment.size, 0) >
    MAX_CASE_FILE_BYTES
  )
    throw new Error("事项附件总量超过上限");
  assertUnique(
    record.events.map((event) => event.id),
    "记录标识",
  );
  assertUnique(
    attachments.map((attachment) => attachment.id),
    "附件标识",
  );
  const referenced = record.events.flatMap((event) => event.attachmentIds);
  assertUnique(referenced, "附件引用");
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
  if (
    referenced.length !== attachments.length ||
    referenced.some((id) => !attachmentIds.has(id))
  ) {
    throw new Error("附件与时间线关联不完整");
  }
  for (const attachment of attachments) {
    const { blob, ...meta } = attachment;
    attachmentMetadataSchema.parse(meta);
    if (attachment.caseId !== record.id || blob.size !== attachment.size)
      throw new Error("附件所属事项或大小不匹配");
  }
}

/** For archive restoration only. `add` prevents any accidental overwrite. */
export async function insertCaseWithAttachments(
  record: CaseRecord,
  attachments: Attachment[],
): Promise<void> {
  validateSnapshot(record, attachments);
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readwrite",
  );
  // Include transaction.done in the same rejection handler, including aborted requests.
  await Promise.all([
    transaction.done,
    transaction.objectStore("cases").add(record),
    ...attachments.map((attachment) =>
      transaction.objectStore("attachments").add(attachment),
    ),
  ]);
}

export async function getStorageStats(): Promise<{
  cases: number;
  attachments: number;
  bytes: number;
}> {
  const transaction = (await db()).transaction(
    ["cases", "attachments"],
    "readonly",
  );
  const [count, attachments] = await Promise.all([
    transaction.objectStore("cases").count(),
    transaction.objectStore("attachments").getAll(),
  ]);
  await transaction.done;
  return {
    cases: count,
    attachments: attachments.length,
    bytes: attachments.reduce((sum, file) => sum + file.size, 0),
  };
}
