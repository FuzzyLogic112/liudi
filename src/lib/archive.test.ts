import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { exportCase, HASH_NOTICE, importCase } from "./archive";
import {
  addEvent,
  deleteCase,
  getCaseSnapshot,
  listCases,
  saveCase,
} from "./store";
import type { CaseRecord } from "./types";
import { MAX_FILE_SIZE } from "./types";
import { unzipChecked } from "./zip-safety";

const now = "2026-09-26T08:00:00.000Z";
async function seed(): Promise<CaseRecord> {
  const record: CaseRecord = {
    id: crypto.randomUUID(),
    title: "测试事项",
    category: "维修保修",
    merchant: "示例商家",
    orderNo: "",
    amount: "0",
    goal: "补充材料",
    status: "active",
    deadline: "2026-10-01",
    createdAt: now,
    updatedAt: now,
    events: [],
    checklist: ["已核对订单"],
  };
  await saveCase(record);
  await addEvent(
    record.id,
    { date: "", title: "日期不详记录", description: "日期确实不详" },
    [new File(["same name, first bytes"], "凭证.txt", { type: "text/plain" })],
  );
  await addEvent(
    record.id,
    { date: "2026-09-24", title: "有日期记录", description: "客服电话记录" },
    [
      new File(["same name, different bytes"], "凭证.txt", {
        type: "text/plain",
      }),
    ],
  );
  return record;
}
function fileFromEntries(
  entries: Record<string, Uint8Array<ArrayBuffer>>,
): File {
  return new File(
    [new Uint8Array(zipSync(entries, { level: 0 }))],
    "backup.zip",
    { type: "application/zip" },
  );
}

beforeEach(async () => {
  await Promise.all((await listCases()).map((record) => deleteCase(record.id)));
});

describe("single-case archive roundtrip", () => {
  it("preserves all bytes, dates and original names while regenerating every identifier", async () => {
    const original = await seed();
    const before = await getCaseSnapshot(original.id);
    const blob = await exportCase(original.id);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const unpacked = unzipChecked(bytes);
    const report = strFromU8(unpacked["report.html"]);
    expect(report.indexOf("有日期记录")).toBeLessThan(
      report.indexOf("日期不详记录"),
    );
    expect(report).toContain(HASH_NOTICE);
    expect(strFromU8(unpacked["README.txt"])).toContain(HASH_NOTICE);
    const restoredId = await importCase(new File([blob], "case.zip"));
    expect(restoredId).not.toBe(original.id);
    expect(await listCases()).toHaveLength(2);
    const restored = await getCaseSnapshot(restoredId);
    expect(restored.record.title).toBe(before.record.title);
    expect(restored.record.createdAt).toBe(before.record.createdAt);
    expect(restored.record.events.map((event) => event.date)).toEqual([
      "",
      "2026-09-24",
    ]);
    expect(
      restored.record.events.every(
        (event) => !before.record.events.some((old) => old.id === event.id),
      ),
    ).toBe(true);
    expect(
      restored.attachments.every(
        (file) =>
          file.caseId === restoredId &&
          !before.attachments.some((old) => old.id === file.id),
      ),
    ).toBe(true);
    expect(restored.attachments.map((file) => file.name)).toEqual([
      "凭证.txt",
      "凭证.txt",
    ]);
    expect(
      (
        await Promise.all(restored.attachments.map((file) => file.blob.text()))
      ).sort(),
    ).toEqual(
      (
        await Promise.all(before.attachments.map((file) => file.blob.text()))
      ).sort(),
    );
    // A restored case remains exportable and restorable with its newly assigned IDs.
    const secondCopy = await importCase(
      new File([await exportCase(restoredId)], "second.zip"),
    );
    expect((await getCaseSnapshot(secondCopy)).attachments).toHaveLength(2);
  });

  it("supports an empty timeline and zero attachments", async () => {
    const seeded = await seed();
    const empty: CaseRecord = {
      ...seeded,
      id: crypto.randomUUID(),
      events: [],
    };
    await saveCase(empty);
    const importedId = await importCase(
      new File([await exportCase(empty.id)], "empty.zip"),
    );
    expect((await getCaseSnapshot(importedId)).record.events).toEqual([]);
    expect((await getCaseSnapshot(importedId)).attachments).toEqual([]);
  });

  it("escapes every user-controlled HTML field and keeps active scripts out of the report", async () => {
    const seeded = await seed();
    await saveCase({
      ...seeded,
      title: '<script>alert("title")</script>',
      goal: '</style><img src=x onerror="evil()">',
    });
    await addEvent(
      seeded.id,
      {
        date: "",
        title: "<svg/onload=evil()>",
        description: '" onclick="evil()" & goodbye',
      },
      [new File(["x"], '<img onerror="evil()">.txt')],
    );
    const unpacked = unzipChecked(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    const report = strFromU8(unpacked["report.html"]);
    expect(report).not.toContain("<script>");
    expect(report).not.toContain("<img");
    expect(report).not.toContain("<svg");
    expect(report).toContain(
      "&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;",
    );
    expect(report).toContain("&lt;img onerror=&quot;evil()&quot;&gt;.txt");
    expect(report).toContain("default-src 'none'");
  });
});

describe("untrusted archive validation", () => {
  it("rejects externally recompressed archives without creating a case", async () => {
    const seeded = await seed();
    const entries = unzipSync(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    const recompressed = new File(
      [new Uint8Array(zipSync(entries, { level: 6 }))],
      "recompressed.zip",
    );
    await expect(importCase(recompressed)).rejects.toThrow("原始备份");
    expect(await listCases()).toHaveLength(1);
    expect((await getCaseSnapshot(seeded.id)).attachments).toHaveLength(2);
  });

  it("rejects a replaced attachment even if the ZIP CRC is valid, without writing anything", async () => {
    const seeded = await seed();
    const entries = unzipSync(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    const path = Object.keys(entries).find((key) => key.startsWith("files/"))!;
    entries[path][0] ^= 1;
    await expect(importCase(fileFromEntries(entries))).rejects.toThrow(
      "SHA-256",
    );
    expect(await listCases()).toHaveLength(1);
    expect((await getCaseSnapshot(seeded.id)).attachments).toHaveLength(2);
  });

  it.each([
    "bad-date",
    "missing-title",
    "duplicate-event",
    "orphan-attachment",
    "wrong-owner",
    "duplicate-reference",
  ])("rejects %s without partial writes", async (fault) => {
    const seeded = await seed();
    const entries = unzipSync(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    if (fault === "bad-date") manifest.record.events[0].date = "2026-02-30";
    if (fault === "missing-title") delete manifest.record.title;
    if (fault === "duplicate-event")
      manifest.record.events[1].id = manifest.record.events[0].id;
    if (fault === "orphan-attachment")
      manifest.record.events[0].attachmentIds = [];
    if (fault === "wrong-owner") manifest.attachments[0].caseId = "wrong-owner";
    if (fault === "duplicate-reference")
      manifest.record.events[1].attachmentIds =
        manifest.record.events[0].attachmentIds;
    entries["manifest.json"] = strToU8(JSON.stringify(manifest));
    await expect(importCase(fileFromEntries(entries))).rejects.toThrow();
    expect(await listCases()).toHaveLength(1);
  });

  it.each([
    "NaN",
    "Infinity",
    "-1",
    "1.001",
    "1000000000",
    "999999999.01",
    "1e3",
    "0x10",
    " ",
  ])("rejects invalid imported amount %j without writing", async (amount) => {
    const seeded = await seed();
    const entries = unzipSync(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    manifest.record.amount = amount;
    entries["manifest.json"] = strToU8(JSON.stringify(manifest));
    await expect(importCase(fileFromEntries(entries))).rejects.toThrow(
      "备份清单格式",
    );
    expect(await listCases()).toHaveLength(1);
    expect((await getCaseSnapshot(seeded.id)).attachments).toHaveLength(2);
  });

  it("rejects unregistered extra files, traversal paths and repeated ZIP entry names", async () => {
    const seeded = await seed();
    const entries = unzipSync(
      new Uint8Array(await (await exportCase(seeded.id)).arrayBuffer()),
    );
    await expect(
      importCase(
        fileFromEntries({
          ...entries,
          "files/extra.txt": strToU8("unregistered"),
        }),
      ),
    ).rejects.toThrow("未登记");
    await expect(
      importCase(
        fileFromEntries({
          ...entries,
          "files/../escape.txt": strToU8("unsafe"),
        }),
      ),
    ).rejects.toThrow("异常路径");
    const duplicate = new Uint8Array(
      zipSync(
        { ...entries, "files/a": strToU8("a"), "files/b": strToU8("b") },
        { level: 0 },
      ),
    );
    const needle = strToU8("files/b");
    // Replace both the local and central filename, preserving lengths and data CRCs.
    for (let i = 0; i < duplicate.length - needle.length; i += 1) {
      if (needle.every((byte, index) => duplicate[i + index] === byte))
        duplicate[i + needle.length - 1] = "a".charCodeAt(0);
    }
    await expect(
      importCase(new File([duplicate], "duplicate.zip")),
    ).rejects.toThrow("重复文件路径");
    expect(await listCases()).toHaveLength(1);
  });

  it("rejects oversized declared entries before reading their payloads", () => {
    const bytes = new Uint8Array(
      zipSync(
        {
          "manifest.json": strToU8("{}"),
          "report.html": strToU8(""),
          "README.txt": strToU8(""),
          "files/bomb": strToU8("x"),
        },
        { level: 0 },
      ),
    );
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    let cursor = view.getUint32(end + 16, true);
    for (let index = 0; index < 4; index += 1) {
      const nameLength = view.getUint16(cursor + 28, true);
      const name = strFromU8(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      );
      if (name === "files/bomb") {
        const local = view.getUint32(cursor + 42, true);
        view.setUint32(cursor + 24, MAX_FILE_SIZE + 1, true);
        view.setUint32(local + 22, MAX_FILE_SIZE + 1, true);
      }
      cursor +=
        46 +
        nameLength +
        view.getUint16(cursor + 30, true) +
        view.getUint16(cursor + 32, true);
    }
    expect(() => unzipChecked(bytes)).toThrow("解压大小");
  });

  it("rejects a ZIP entry count over the limit before reading its directory", () => {
    const bytes = new Uint8Array(
      zipSync({
        "manifest.json": strToU8("{}"),
        "report.html": strToU8(""),
        "README.txt": strToU8(""),
      }),
    );
    const view = new DataView(bytes.buffer);
    view.setUint16(bytes.length - 22 + 8, 204, true);
    view.setUint16(bytes.length - 22 + 10, 204, true);
    expect(() => unzipChecked(bytes)).toThrow("文件数量");
  });

  it("rejects a corrupted ZIP payload using its CRC", () => {
    const bytes = new Uint8Array(
      zipSync(
        {
          "manifest.json": strToU8("{}"),
          "report.html": strToU8("report"),
          "README.txt": strToU8("readme"),
        },
        { level: 0 },
      ),
    );
    bytes[30 + "manifest.json".length] ^= 1;
    expect(() => unzipChecked(bytes)).toThrow("校验失败");
  });
});
