import { strFromU8, strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { Attachment, CaseRecord } from "./types";
import { MAX_ARCHIVE_SIZE, MAX_ATTACHMENTS } from "./types";
import {
  getCaseSnapshot,
  insertCaseWithAttachments,
  validateSnapshot,
} from "./store";
import {
  assertUnique,
  attachmentMetadataSchema,
  caseSchema,
  hashBytes,
} from "./validation";
import { archivePathLimit, unzipChecked } from "./zip-safety";

export const HASH_NOTICE =
  "SHA-256 仅用于比对文件字节是否一致，不证明内容真实性、发生时间或法律效力。";

const archivedAttachmentSchema = attachmentMetadataSchema
  .extend({ path: z.string().max(250) })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("liudi.case"),
    version: z.literal(1),
    exportedAt: z.string().datetime({ offset: true }),
    record: caseSchema,
    attachments: z.array(archivedAttachmentSchema).max(MAX_ATTACHMENTS),
  })
  .strict();
type ArchiveAttachment = z.infer<typeof archivedAttachmentSchema>;

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function attachmentPath(attachment: Attachment): string {
  const extension = /\.([a-zA-Z0-9]{1,12})$/
    .exec(attachment.name)?.[1]
    ?.toLowerCase();
  return `files/${attachment.id}${extension ? `.${extension}` : ""}`;
}

/** Self-contained report: no remote resources, active scripts, or HTML from user fields. */
export function renderReport(
  record: CaseRecord,
  attachments: ArchiveAttachment[],
  exportedAt: string,
): string {
  const escape = escapeHtml;
  const files = new Map(
    attachments.map((attachment) => [attachment.id, attachment]),
  );
  const events = record.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (!a.event.date && b.event.date) return 1;
      if (a.event.date && !b.event.date) return -1;
      return a.event.date.localeCompare(b.event.date) || a.index - b.index;
    });
  const field = (label: string, value: string) =>
    `<dt>${escape(label)}</dt><dd>${escape(value || "未填写")}</dd>`;
  const timeline = events
    .map(
      ({ event }) =>
        `<section class="event"><p class="date">${escape(event.date || "日期不详")}</p><h3>${escape(event.title)}</h3><p class="multiline">${escape(event.description || "无补充说明")}</p>${
          event.attachmentIds.length
            ? `<ul>${event.attachmentIds
                .map((id) => {
                  const file = files.get(id)!;
                  return `<li><a href="${escape(file.path)}" download="${escape(file.name)}">${escape(file.name)}</a> <span>(${file.size.toLocaleString("zh-CN")} 字节)</span><small>SHA-256: ${escape(file.sha256)}</small></li>`;
                })
                .join("")}</ul>`
            : '<p class="muted">此条记录没有附件</p>'
        }</section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(record.title)} · 留底材料清单</title><style>
*{box-sizing:border-box}body{max-width:900px;margin:40px auto;padding:0 24px;color:#182923;background:#fff;font:15px/1.75 system-ui,-apple-system,"Microsoft YaHei",sans-serif}header{border-bottom:3px solid #256b51;padding-bottom:24px}h1{font-size:30px;line-height:1.4;overflow-wrap:anywhere}h2{margin-top:32px}h3{margin:4px 0}.brand,.date{color:#256b51;font-weight:700}.muted,small{color:#596861}dl{display:grid;grid-template-columns:110px 1fr;gap:8px 18px}dt{color:#596861}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.event{border-top:1px solid #d9e2dc;padding:18px 0;break-inside:avoid}.date{margin:0}a{color:#14543b}small{display:block;overflow-wrap:anywhere;font:11px/1.6 monospace}.multiline{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:12px 0;overflow-wrap:anywhere}.note{padding:16px;background:#f0f5f1;font-size:13px}footer{border-top:1px solid #d9e2dc;margin-top:30px;padding-top:16px;font-size:12px;color:#596861}@media print{body{max-width:none;margin:0;padding:0}a{color:inherit;text-decoration:none}h2,h3{break-after:avoid}.note{background:none;border:1px solid #d9e2dc}@page{size:A4;margin:18mm}}
</style></head><body><header><p class="brand">留底 LIUDI / 消费售后材料清单</p><h1>${escape(record.title)}</h1><p>${escape(record.category)} · ${record.status === "resolved" ? "已办结" : "跟进中"}</p></header>
<h2>事项信息</h2><dl>${field("商家或机构", record.merchant)}${field("订单编号", record.orderNo)}${field("涉及金额", record.amount)}${field("希望的结果", record.goal)}${field("提醒日期", record.deadline)}${field("建档时间", record.createdAt)}${field("最近录入", record.updatedAt)}</dl>
${record.checklist.length ? `<h2>整理标记</h2><ul>${record.checklist.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}
<h2>时间线与附件</h2>${timeline || "<p>尚未添加时间线记录。</p>"}
<p class="note">${HASH_NOTICE} 此清单用于材料整理，时间线日期由整理人填写；日期不详的记录单独标注。提醒日期由用户自行设置，不是系统计算的法定期限。需要纸质清单时，可使用浏览器的打印功能。请解压整个备份后打开本文件，以访问附件。</p>
<footer>导出时间：${escape(exportedAt)} · 由留底在本地生成。分享前请自行检查订单、联系方式等私人信息。</footer></body></html>`;
}

export async function exportCase(caseId: string): Promise<Blob> {
  const { record, attachments } = await getCaseSnapshot(caseId);
  validateSnapshot(record, attachments);
  const files: Record<string, Uint8Array<ArrayBuffer>> = Object.create(
    null,
  ) as Record<string, Uint8Array<ArrayBuffer>>;
  const archived: ArchiveAttachment[] = [];
  for (const attachment of attachments) {
    const contents = new Uint8Array(await attachment.blob.arrayBuffer());
    if ((await hashBytes(contents)) !== attachment.sha256)
      throw new Error(`附件“${attachment.name}”校验失败，未导出`);
    const { blob: _blob, ...meta } = attachment;
    const path = attachmentPath(attachment);
    files[path] = contents;
    archived.push({ ...meta, path });
  }
  const exportedAt = new Date().toISOString();
  const manifest = manifestSchema.parse({
    format: "liudi.case",
    version: 1,
    exportedAt,
    record,
    attachments: archived,
  });
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["report.html"] = strToU8(renderReport(record, archived, exportedAt));
  files["README.txt"] = strToU8(
    `留底 Liudi · 单事项备份 v1\n\n1. 保留整个 ZIP，可在留底的“导入备份”中恢复成一个全新的事项，不会覆盖现有数据。\n2. 解压整个文件夹后，打开 report.html 阅读清单；使用浏览器打印可保存为 PDF。附件保存在 files/，文件名使用独立标识以避免同名覆盖；原始文件名和对应关系见清单及 manifest.json。\n3. manifest.json 是可恢复的结构化数据；请勿改名、改内容或删除关联文件。\n4. ${HASH_NOTICE}\n5. 备份包含原始附件与填写内容，分享前请自行检查私人信息。\n6. 留底只在当前浏览器保存数据；清理浏览器数据、切换设备不会自动迁移。请将 ZIP 另存到可靠位置。\n7. 本备份不是电子签章、时间戳公证或专业法律意见。\n`,
  );
  let total = 0;
  for (const [name, contents] of Object.entries(files)) {
    if (contents.length > archivePathLimit(name))
      throw new Error("备份内容超过单文件上限，请拆分事项");
    total += contents.length;
  }
  if (total > MAX_ARCHIVE_SIZE) throw new Error("备份解压总量不能超过 200 MiB");
  // Original files are stored without recompression to bound CPU work on photos/PDFs.
  return new Blob([new Uint8Array(zipSync(files, { level: 0 }))], {
    type: "application/zip",
  });
}

export async function importCase(file: File): Promise<string> {
  if (file.size > MAX_ARCHIVE_SIZE + 1024 * 1024)
    throw new Error("备份文件不能超过 201 MiB");
  const unpacked = unzipChecked(new Uint8Array(await file.arrayBuffer()));
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(unpacked["manifest.json"]));
  } catch {
    throw new Error("备份清单不是有效的 JSON");
  }
  const result = manifestSchema.safeParse(json);
  if (!result.success)
    throw new Error("备份清单格式不正确、字段超限或日期无效");
  const manifest = result.data;
  assertUnique(
    manifest.attachments.map((attachment) => attachment.path),
    "附件路径",
  );
  const expected = new Set([
    "manifest.json",
    "report.html",
    "README.txt",
    ...manifest.attachments.map((attachment) => attachment.path),
  ]);
  if (
    expected.size !== Object.keys(unpacked).length ||
    Object.keys(unpacked).some((path) => !expected.has(path))
  ) {
    throw new Error("备份存在未登记或缺失的文件");
  }
  const attachments: Attachment[] = [];
  for (const archived of manifest.attachments) {
    if (!archived.path.startsWith("files/")) throw new Error("附件路径异常");
    const contents = unpacked[archived.path];
    if (!contents || contents.length !== archived.size)
      throw new Error(`附件“${archived.name}”缺失或大小不匹配`);
    if ((await hashBytes(contents)) !== archived.sha256)
      throw new Error(`附件“${archived.name}”的 SHA-256 校验失败`);
    const { path: _path, ...metadata } = archived;
    attachments.push({
      ...metadata,
      blob: new Blob([contents], { type: archived.type }),
    });
  }
  validateSnapshot(manifest.record, attachments);
  // Re-key the whole graph only after every entry has passed validation.
  const caseId = crypto.randomUUID();
  const ids = new Map(
    attachments.map((attachment) => [attachment.id, crypto.randomUUID()]),
  );
  const cloned: CaseRecord = {
    ...manifest.record,
    id: caseId,
    events: manifest.record.events.map((event) => ({
      ...event,
      id: crypto.randomUUID(),
      attachmentIds: event.attachmentIds.map((id) => ids.get(id)!),
    })),
  };
  await insertCaseWithAttachments(
    cloned,
    attachments.map((attachment) => ({
      ...attachment,
      id: ids.get(attachment.id)!,
      caseId,
    })),
  );
  return caseId;
}
