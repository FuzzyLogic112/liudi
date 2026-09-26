import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRecord } from "./types";
import { MAX_BATCH_SIZE, MAX_FILE_SIZE } from "./types";
import {
  addEvent,
  deleteCase,
  deleteEvent,
  getAttachments,
  getCaseSnapshot,
  getStorageStats,
  insertCaseWithAttachments,
  listCases,
  saveCase,
  toggleChecklist,
  updateCaseMeta,
} from "./store";
import { isValidDate, validateCase } from "./validation";

const now = "2026-09-26T08:00:00.000Z";
function makeCase(): CaseRecord {
  return {
    id: crypto.randomUUID(),
    title: "测试电饭锅售后",
    category: "网购售后",
    merchant: "示例商店",
    orderNo: "SAMPLE-001",
    amount: "199",
    goal: "核对保修材料",
    status: "active",
    deadline: "",
    createdAt: now,
    updatedAt: now,
    events: [],
    checklist: [],
  };
}

beforeEach(async () => {
  await Promise.all((await listCases()).map((record) => deleteCase(record.id)));
});

describe("local case transactions", () => {
  it("retains two identically named attachments and deletes only the selected event attachments", async () => {
    const record = makeCase();
    await saveCase(record);
    await addEvent(
      record.id,
      { date: "", title: "第一次沟通", description: "" },
      [new File(["one"], "receipt.txt")],
    );
    await addEvent(
      record.id,
      { date: "2026-09-25", title: "补充票据", description: "" },
      [new File(["two"], "receipt.txt")],
    );
    const snapshot = await getCaseSnapshot(record.id);
    expect(snapshot.attachments).toHaveLength(2);
    expect(new Set(snapshot.attachments.map((file) => file.id)).size).toBe(2);
    expect(snapshot.record.events[0].date).toBe("");
    await deleteEvent(record.id, snapshot.record.events[0].id);
    expect(await getAttachments(record.id)).toHaveLength(1);
    const remaining = (await getAttachments(record.id))[0];
    expect(await remaining.blob.text()).toBe("two");
    await deleteCase(record.id);
    expect(await getStorageStats()).toEqual({
      cases: 0,
      attachments: 0,
      bytes: 0,
    });
  });

  it("keeps all events appended concurrently from independent database connections", async () => {
    const record = makeCase();
    await saveCase(record);
    vi.resetModules();
    const secondWindow = await import("./store");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const append = index % 2 === 0 ? addEvent : secondWindow.addEvent;
        return append(
          record.id,
          { date: "", title: `并发记录 ${index}`, description: "" },
          [new File([String(index)], "same.txt")],
        );
      }),
    );
    const { record: current, attachments } = await getCaseSnapshot(record.id);
    expect(current.events).toHaveLength(12);
    expect(attachments).toHaveLength(12);
    expect(new Set(current.events.map((event) => event.title)).size).toBe(12);
    expect(
      current.events.flatMap((event) => event.attachmentIds).sort(),
    ).toEqual(attachments.map((attachment) => attachment.id).sort());
  });

  it("preserves new events when saving an old UI snapshot and applies concurrent partial metadata edits", async () => {
    const oldSnapshot = makeCase();
    await saveCase(oldSnapshot);
    await addEvent(
      oldSnapshot.id,
      { date: "", title: "新加入的记录", description: "" },
      [],
    );
    await saveCase({ ...oldSnapshot, title: "更新事项标题" });
    await Promise.all([
      updateCaseMeta(oldSnapshot.id, { merchant: "新的商家名称" }),
      updateCaseMeta(oldSnapshot.id, { goal: "新的期望结果" }),
    ]);
    const { record } = await getCaseSnapshot(oldSnapshot.id);
    expect(record.events).toHaveLength(1);
    expect(record.title).toBe("更新事项标题");
    expect(record.merchant).toBe("新的商家名称");
    expect(record.goal).toBe("新的期望结果");
    expect(record.createdAt).toBe(now);
  });

  it("preserves independent checklist changes across database connections without duplicate entries", async () => {
    const record = makeCase();
    await saveCase(record);
    vi.resetModules();
    const secondWindow = await import("./store");
    await Promise.all([
      toggleChecklist(record.id, "交易凭证", true),
      secondWindow.toggleChecklist(record.id, "沟通记录", true),
      secondWindow.toggleChecklist(record.id, "交易凭证", true),
    ]);
    expect((await getCaseSnapshot(record.id)).record.checklist.sort()).toEqual(
      ["交易凭证", "沟通记录"].sort(),
    );
    await Promise.all([
      toggleChecklist(record.id, "交易凭证", false),
      secondWindow.toggleChecklist(record.id, "处理结果", true),
    ]);
    expect((await getCaseSnapshot(record.id)).record.checklist.sort()).toEqual(
      ["沟通记录", "处理结果"].sort(),
    );
    await deleteCase(record.id);
    await expect(toggleChecklist(record.id, "交易凭证", true)).rejects.toThrow(
      "事项不存在",
    );
    expect(await listCases()).toEqual([]);
  });

  it("rejects oversize files before reading bytes and leaves the timeline untouched", async () => {
    const record = makeCase();
    await saveCase(record);
    const largeFile = new File([], "large.bin");
    Object.defineProperty(largeFile, "size", { value: MAX_FILE_SIZE + 1 });
    const read = vi.spyOn(largeFile, "arrayBuffer");
    await expect(
      addEvent(record.id, { date: "", title: "过大的文件", description: "" }, [
        largeFile,
      ]),
    ).rejects.toThrow("20 MiB");
    expect(read).not.toHaveBeenCalled();
    const files = Array.from({ length: 3 }, () => {
      const file = new File([], "batch.bin");
      Object.defineProperty(file, "size", {
        value: Math.ceil(MAX_BATCH_SIZE / 3),
      });
      return file;
    });
    await expect(
      addEvent(
        record.id,
        { date: "", title: "过大的批次", description: "" },
        files,
      ),
    ).rejects.toThrow("50 MiB");
    expect((await getCaseSnapshot(record.id)).record.events).toEqual([]);
    expect(await getAttachments(record.id)).toEqual([]);
  });

  it("does not recreate a case deleted in a different window during file preparation", async () => {
    const record = makeCase();
    await saveCase(record);
    const file = new File(["test"], "test.txt");
    vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
      await deleteCase(record.id);
      return new TextEncoder().encode("test").buffer;
    });
    await expect(
      addEvent(record.id, { date: "", title: "迟来的记录", description: "" }, [
        file,
      ]),
    ).rejects.toThrow("事项不存在");
    expect(await getStorageStats()).toEqual({
      cases: 0,
      attachments: 0,
      bytes: 0,
    });
  });

  it("rolls back the whole restore if a late attachment write fails", async () => {
    const first = makeCase();
    await saveCase(first);
    await addEvent(first.id, { date: "", title: "原有文件", description: "" }, [
      new File(["original"], "original.txt"),
    ]);
    const originalAttachment = (await getAttachments(first.id))[0];
    const second = makeCase();
    const newAttachment = {
      ...originalAttachment,
      id: crypto.randomUUID(),
      caseId: second.id,
    };
    // The second attachment collides with an existing DB key only at commit time.
    const collidingAttachment = { ...originalAttachment, caseId: second.id };
    second.events = [
      {
        id: crypto.randomUUID(),
        date: "",
        title: "需要原子写入",
        description: "",
        attachmentIds: [newAttachment.id, collidingAttachment.id],
      },
    ];
    await expect(
      insertCaseWithAttachments(second, [newAttachment, collidingAttachment]),
    ).rejects.toThrow();
    expect(await listCases()).toHaveLength(1);
    expect(await getAttachments(second.id)).toHaveLength(0);
    expect(await getAttachments(first.id)).toHaveLength(1);
  });
});

describe("actual dates", () => {
  it.each(["", "2024-02-29", "2026-09-26", "2000-02-29"])(
    "accepts %s",
    (value) => {
      expect(isValidDate(value)).toBe(true);
    },
  );
  it.each([
    "2026-02-29",
    "2025-02-30",
    "1900-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-9-1",
    "not-a-date",
  ])("rejects %s", (value) => {
    expect(isValidDate(value)).toBe(false);
  });
  it("rejects an impossible event date before changing storage", async () => {
    const record = makeCase();
    await saveCase(record);
    await expect(
      addEvent(
        record.id,
        { date: "2026-02-30", title: "无效日期", description: "" },
        [],
      ),
    ).rejects.toThrow();
    expect((await getCaseSnapshot(record.id)).record.events).toEqual([]);
  });
});

describe("amount boundaries", () => {
  it.each(["", "0", "0.00", "123.4", "123.45", "999999999", "999999999.00"])(
    "accepts amount %j",
    (amount) => {
      expect(validateCase({ ...makeCase(), amount }).amount).toBe(amount);
    },
  );
});
