import { z } from "zod";
import {
  CATEGORIES,
  MAX_ATTACHMENTS,
  MAX_EVENTS,
  MAX_FILE_SIZE,
} from "./types";

export function isValidDate(value: string): boolean {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const date = z
  .string()
  .refine(isValidDate, "日期格式应为真实的 YYYY-MM-DD，日期不详请留空");
const timestamp = z.string().max(40).datetime({ offset: true });
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, "无效的记录标识");

export const eventSchema = z
  .object({
    id,
    date,
    title: z.string().trim().min(1, "请填写记录标题").max(200),
    description: z.string().max(20000),
    attachmentIds: z.array(id).max(MAX_ATTACHMENTS),
  })
  .strict();

export const caseSchema = z
  .object({
    id,
    title: z.string().trim().min(1, "请填写事项标题").max(200),
    category: z.enum(CATEGORIES),
    merchant: z.string().max(200),
    orderNo: z.string().max(200),
    amount: z
      .string()
      .max(50)
      .refine(
        (value) =>
          value === "" ||
          (/^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) <= 999999999),
        "金额请留空，或填写不超过 999999999 的非负数字，最多保留两位小数",
      ),
    goal: z.string().max(5000),
    status: z.enum(["active", "resolved"]),
    deadline: date,
    createdAt: timestamp,
    updatedAt: timestamp,
    events: z.array(eventSchema).max(MAX_EVENTS),
    checklist: z.array(z.string().max(200)).max(50),
  })
  .strict()
  .refine(
    (record) =>
      new TextEncoder().encode(JSON.stringify(record)).length <= 1024 * 1024,
    "事项文字总量不能超过 1 MiB，请将较长内容保存为附件",
  );

export const attachmentMetadataSchema = z
  .object({
    id,
    caseId: id,
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !/[\u0000-\u001f]/.test(name), "文件名含控制字符"),
    type: z.string().max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    addedAt: timestamp,
    size: z.number().int().min(0).max(MAX_FILE_SIZE),
  })
  .strict();

export function validateCase(record: unknown) {
  return caseSchema.parse(record);
}

export async function hashBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}重复`);
}
