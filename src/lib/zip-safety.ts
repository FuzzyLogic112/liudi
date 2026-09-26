import { unzipSync } from "fflate";
import { MAX_ARCHIVE_SIZE, MAX_ATTACHMENTS, MAX_FILE_SIZE } from "./types";

const MANIFEST_LIMIT = 2 * 1024 * 1024;
const REPORT_LIMIT = 7 * 1024 * 1024;
const README_LIMIT = 256 * 1024;

export function archivePathLimit(name: string): number {
  if (name === "manifest.json") return MANIFEST_LIMIT;
  if (name === "report.html") return REPORT_LIMIT;
  if (name === "README.txt") return README_LIMIT;
  if (/^files\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]{1,12})?$/.test(name))
    return MAX_FILE_SIZE;
  throw new Error("备份中存在异常路径或不支持的文件");
}

/**
 * Inspect central and local headers before invoking the inflater. This accepts
 * the bounded, single-volume ZIP format written by this app, without ZIP64,
 * encrypted entries, data descriptors, hidden entries or duplicate paths.
 */
export function unzipChecked(
  bytes: Uint8Array<ArrayBuffer>,
): Record<string, Uint8Array<ArrayBuffer>> {
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_SIZE + 1024 * 1024)
    throw new Error("ZIP 文件过大或不完整");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  // Exports have no ZIP comment. Reject trailing payloads and ambiguous end markers.
  const end = bytes.length - 22;
  if (
    u32(end) !== 0x06054b50 ||
    u16(end + 20) !== 0 ||
    u16(end + 4) !== 0 ||
    u16(end + 6) !== 0
  ) {
    throw new Error("不支持此 ZIP 格式，请使用留底导出的原始备份");
  }
  const count = u16(end + 10);
  const directoryOffset = u32(end + 16);
  if (count < 3 || count > MAX_ATTACHMENTS + 3 || count !== u16(end + 8))
    throw new Error("备份文件数量异常");
  if (directoryOffset + u32(end + 12) !== end)
    throw new Error("ZIP 目录结构异常");
  const names = new Set<string>();
  const expected = new Map<
    string,
    { size: number; originalSize: number; method: number; crc: number }
  >();
  let total = 0;
  let cursor = directoryOffset;
  let nextLocal = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50)
      throw new Error("ZIP 目录项不完整");
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const size = u32(cursor + 20);
    const originalSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      nameLength === 0 ||
      nameLength > 250 ||
      u16(cursor + 34) !== 0
    )
      throw new Error("ZIP 文件名或分卷异常");
    if ((flags & ~0x800) !== 0 || (method !== 0 && method !== 8))
      throw new Error("不支持加密或特殊压缩的 ZIP");
    // Generated archives require no extra fields; refusing them also excludes ZIP64.
    if (extraLength || commentLength) throw new Error("不支持带扩展字段的 ZIP");
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (names.has(name)) throw new Error("备份包含重复文件路径");
    names.add(name);
    const limit = archivePathLimit(name);
    if (
      originalSize > limit ||
      size > MAX_ARCHIVE_SIZE ||
      (method === 0 && size !== originalSize)
    )
      throw new Error("备份解压大小超过限制或头部不一致");
    total += originalSize;
    if (total > MAX_ARCHIVE_SIZE) throw new Error("备份解压总大小超过 200 MiB");
    if (
      localOffset !== nextLocal ||
      localOffset + 30 > directoryOffset ||
      u32(localOffset) !== 0x04034b50
    )
      throw new Error("ZIP 本地文件位置异常");
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataStart + size > directoryOffset ||
      localNameLength !== nameLength ||
      localExtraLength !== 0
    )
      throw new Error("ZIP 本地文件大小异常");
    const localName = decoder.decode(
      bytes.subarray(localOffset + 30, dataStart),
    );
    if (
      localName !== name ||
      u16(localOffset + 6) !== flags ||
      u16(localOffset + 8) !== method ||
      u32(localOffset + 14) !== crc ||
      u32(localOffset + 18) !== size ||
      u32(localOffset + 22) !== originalSize
    ) {
      throw new Error("ZIP 本地头部与目录不一致");
    }
    expected.set(name, { size, originalSize, method, crc });
    nextLocal = dataStart + size;
    cursor = next;
  }
  if (cursor !== end || nextLocal !== directoryOffset)
    throw new Error("ZIP 存在隐藏或多余数据");
  for (const required of ["manifest.json", "report.html", "README.txt"]) {
    if (!names.has(required)) throw new Error(`备份缺少 ${required}`);
  }
  const unpacked = unzipSync(bytes, {
    filter(entry) {
      const declared = expected.get(entry.name);
      if (
        !declared ||
        entry.size !== declared.size ||
        entry.originalSize !== declared.originalSize ||
        entry.compression !== declared.method
      ) {
        throw new Error("解压条目与已验证目录不一致");
      }
      return true;
    },
  });
  for (const [name, contents] of Object.entries(unpacked)) {
    const declared = expected.get(name)!;
    if (
      contents.length !== declared.originalSize ||
      crc32(contents) !== declared.crc
    )
      throw new Error("ZIP 文件校验失败，备份可能已损坏");
  }
  return unpacked;
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[i] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
