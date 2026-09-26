import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  FileCheck2,
  FileText,
  FolderOpen,
  HardDrive,
  Leaf,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Attachment, CaseEvent, CaseRecord } from "./lib/types";
import { CATEGORIES } from "./lib/types";
import {
  addEvent,
  deleteCase,
  deleteEvent,
  getAttachments,
  listCases,
  saveCase,
  toggleChecklist,
  updateCaseMeta,
} from "./lib/store";
import { exportCase, importCase } from "./lib/archive";

const CHECKLIST = ["交易凭证", "问题照片或说明", "沟通记录", "处理结果"];
const categoryMarks: Record<string, string> = {
  网购售后: "购",
  维修保修: "修",
  预付消费: "预",
  其他: "记",
};
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function relativeDay(date: string) {
  if (!date) return "未设置跟进日";
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) /
      86400000,
  );
  return days < 0
    ? `已过跟进日 ${-days} 天`
    : days === 0
      ? "今天需要跟进"
      : days === 1
        ? "明天跟进"
        : `${days} 天后跟进`;
}
function bytes(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
function money(value: string) {
  return value
    ? `¥ ${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`
    : "金额未填写";
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function summary(c: CaseRecord) {
  return [
    `事项：${c.title}`,
    `商家：${c.merchant || "未填写"}`,
    `订单/凭证号：${c.orderNo || "未填写"}`,
    `涉及金额：${money(c.amount)}`,
    `希望如何解决：${c.goal || "未填写"}`,
    "",
    "事情经过：",
    ...[...c.events]
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
      .map((e) => `${e.date || "日期不详"} · ${e.title}\n${e.description}`),
  ].join("\n");
}
function calendar(c: CaseRecord) {
  const escape = (v: string) =>
    v
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  const day = c.deadline.replaceAll("-", "");
  const end = new Date(`${c.deadline}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Liudi//Followup//ZH",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${c.id}@liudi.local`,
    `DTSTAMP:${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "")}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replaceAll("-", "")}`,
    `SUMMARY:${escape(`跟进：${c.title}`)}`,
    `DESCRIPTION:${escape(c.goal || "查看留底中的事项记录。")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // Fold on UTF-8 byte boundaries for calendar clients, without splitting a character.
  const folded = lines
    .map((line) => {
      let out = "";
      let count = 0;
      for (const ch of line) {
        const size = new TextEncoder().encode(ch).length;
        if (count + size > 74) {
          out += "\r\n ";
          count = 1;
        }
        out += ch;
        count += size;
      }
      return out;
    })
    .join("\r\n");
  download(
    new Blob([folded + "\r\n"], { type: "text/calendar;charset=utf-8" }),
    "留底-跟进提醒.ics",
  );
}

function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="modal-title"
      className="modal"
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭弹窗"
          disabled={busy}
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function CaseForm({
  value,
  onSave,
  busy,
  error,
}: {
  value?: CaseRecord;
  onSave: (c: CaseRecord) => void;
  busy: boolean;
  error: string;
}) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const get = (key: string) => String(data.get(key) ?? "").trim();
    const stamp = new Date().toISOString();
    onSave({
      id: value?.id ?? crypto.randomUUID(),
      title: get("title"),
      category: get("category") as CaseRecord["category"],
      merchant: get("merchant"),
      orderNo: get("orderNo"),
      amount: get("amount"),
      goal: get("goal"),
      deadline: get("deadline"),
      status: value?.status ?? "active",
      createdAt: value?.createdAt ?? stamp,
      updatedAt: stamp,
      events: value?.events ?? [],
      checklist: value?.checklist ?? [],
    });
  };
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="form-fields">
        <label>
          给这件事起个名字 <span className="required">*</span>
          <input
            autoFocus
            name="title"
            required
            maxLength={120}
            defaultValue={value?.title}
            placeholder="例如：蓝牙耳机退货退款"
          />
        </label>
        <div className="form-row">
          <label>
            事项类型
            <select
              name="category"
              defaultValue={value?.category ?? "网购售后"}
            >
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            商家 / 服务方
            <input
              name="merchant"
              maxLength={120}
              defaultValue={value?.merchant}
              placeholder="店铺或公司名称"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            订单 / 凭证号
            <input
              name="orderNo"
              maxLength={120}
              defaultValue={value?.orderNo}
              placeholder="可稍后补充"
            />
          </label>
          <label>
            涉及金额（元）
            <input
              name="amount"
              type="number"
              min="0"
              max="999999999"
              step="0.01"
              defaultValue={value?.amount}
              placeholder="0.00"
            />
          </label>
        </div>
        <label>
          希望如何解决
          <textarea
            name="goal"
            rows={3}
            maxLength={4000}
            defaultValue={value?.goal}
            placeholder="写清你的诉求，例如：退回商品并退款 299 元。"
          />
        </label>
        <label>
          下次跟进日期
          <input
            name="deadline"
            type="date"
            min="1900-01-01"
            max="2100-12-31"
            defaultValue={value?.deadline}
          />
          <span className="field-hint">
            由你自行安排；这里不会计算法定期限，也不会在后台推送。
          </span>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full" type="submit">
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Check size={17} />
          )}
          {value ? "保存修改" : "创建事项"}
        </button>
      </fieldset>
    </form>
  );
}

function EventForm({
  onSave,
  busy,
  error,
}: {
  onSave: (e: Omit<CaseEvent, "id" | "attachmentIds">, files: File[]) => void;
  busy: boolean;
  error: string;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSave(
      {
        title: String(d.get("title")).trim(),
        date: String(d.get("date") ?? ""),
        description: String(d.get("description") ?? "").trim(),
      },
      files,
    );
  };
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="form-fields">
        <label>
          发生了什么 <span className="required">*</span>
          <input
            name="title"
            autoFocus
            required
            maxLength={120}
            placeholder="例如：联系商家，申请退货退款"
          />
        </label>
        <label>
          事情发生的日期
          <input
            name="date"
            type="date"
            min="1900-01-01"
            max="2100-12-31"
            defaultValue={today()}
          />
          <span className="field-hint">
            日期记不清可以清空；请填写实际发生日期。
          </span>
        </label>
        <label>
          具体经过
          <textarea
            name="description"
            rows={4}
            maxLength={10000}
            placeholder="记录沟通方式、对方的回复、承诺和你的处理。尽量客观、具体。"
          />
        </label>
        <label className="upload-area">
          <Upload size={23} />
          <strong>选择相关材料</strong>
          <span>聊天截图、订单、照片、文档等</span>
          <span>单个文件最多 20 MB，每次合计最多 50 MB</span>
          <input
            aria-label="选择附件"
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        {files.length > 0 && (
          <ul className="selected-files">
            {files.map((f, i) => (
              <li key={i}>
                <Paperclip size={14} />
                <span>{f.name}</span>
                <small>{bytes(f.size)}</small>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full" type="submit">
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Plus size={17} />
          )}
          保存这条进展
        </button>
      </fieldset>
    </form>
  );
}

export default function App() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [view, setView] = useState<"active" | "resolved">("active");
  const [tab, setTab] = useState<"timeline" | "files">("timeline");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<
    "create" | "edit" | "event" | "help" | "data" | "delete" | null
  >(null);
  const [modalCase, setModalCase] = useState<CaseRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    caseId: string;
    eventId?: string;
    title: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [persistent, setPersistent] = useState(false);
  const busyRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const filtered = cases.filter(
    (c) =>
      c.status === view &&
      `${c.title} ${c.merchant} ${c.orderNo}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const current = filtered.find((c) => c.id === selectedId) ?? filtered[0];
  const active = cases.filter((c) => c.status === "active");
  const due = active.filter((c) => c.deadline && c.deadline <= today()).length;

  async function reload(select?: string) {
    setCases(await listCases());
    if (select) setSelectedId(select);
  }
  useEffect(() => {
    reload()
      .catch((e) =>
        setError(
          `无法读取本地资料：${e instanceof Error ? e.message : String(e)}`,
        ),
      )
      .finally(() => setLoaded(true));
    navigator.storage
      ?.persisted?.()
      .then(setPersistent)
      .catch(() => {});
    if (import.meta.env.PROD && "serviceWorker" in navigator)
      navigator.serviceWorker
        .getRegistration()
        .then((r) => {
          if (r?.active) setOfflineReady(true);
        })
        .catch(() => {});
    const ready = () => setOfflineReady(true);
    const net = () => setOnline(navigator.onLine);
    window.addEventListener("liudi-offline-ready", ready);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    const refresh = () => {
      if (document.visibilityState === "visible" && !busyRef.current)
        reload().catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("liudi-offline-ready", ready);
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  useEffect(() => {
    let stale = false;
    setAttachments([]);
    if (current)
      getAttachments(current.id)
        .then((a) => {
          if (!stale) setAttachments(a);
        })
        .catch((e) => {
          if (!stale) setError(String(e));
        });
    return () => {
      stale = true;
    };
  }, [current]);
  useEffect(() => {
    if (notice) {
      const id = setTimeout(() => setNotice(""), 6500);
      return () => clearTimeout(id);
    }
  }, [notice]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "操作失败，请检查浏览器存储空间后重试。",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const openModal = (m: typeof modal) => {
    setError("");
    if (m === "edit" || m === "event")
      setModalCase(current ? structuredClone(current) : null);
    setModal(m);
  };
  async function committed(
    message: string,
    select?: string,
    status?: CaseRecord["status"],
  ) {
    setModal(null);
    setNotice(message);
    if (status) setView(status);
    try {
      await reload(select);
    } catch {
      setError("操作已经保存，但列表刷新失败。请刷新页面查看；不要重复提交。");
    }
  }
  async function backup() {
    if (!current) return;
    const blob = await exportCase(current.id);
    download(
      blob,
      `留底-${current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.zip`,
    );
    setNotice("材料包已生成。请妥善保管下载的 ZIP，其中包含未加密的原始资料。");
  }
  async function loadDemo() {
    const existing = cases.find((c) => c.title === "【示例】蓝牙耳机退货退款");
    if (existing) {
      setView("active");
      setSelectedId(existing.id);
      setSearch("");
      return;
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const day = new Date();
    day.setDate(day.getDate() + 2);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    await saveCase({
      id,
      title: "【示例】蓝牙耳机退货退款",
      category: "网购售后",
      merchant: "示例数码店（虚构）",
      orderNo: "DEMO-2026-001",
      amount: "299.00",
      goal: "耳机右侧无法正常连接，希望退回商品并退款 299 元。",
      status: "active",
      deadline: date,
      createdAt: now,
      updatedAt: now,
      events: [],
      checklist: ["交易凭证", "沟通记录"],
    });
    await addEvent(
      id,
      {
        date: today(),
        title: "收到商品，发现右侧耳机无法连接",
        description:
          "【虚构示例】尝试充电、重置和更换设备后，问题仍然存在。已保留包装和随附配件。",
      },
      [
        new File(
          [
            "这是一份虚构的示例订单，非真实交易。\n商品：蓝牙耳机\n金额：299 元\n商家：示例数码店",
          ],
          "示例订单.txt",
          { type: "text/plain" },
        ),
      ],
    );
    await addEvent(
      id,
      {
        date: today(),
        title: "联系商家，申请退货退款",
        description:
          "【虚构示例】商家回复会在两个工作日内处理。等待提供退货地址，下一次跟进时核实处理结果。",
      },
      [
        new File(
          ["虚构沟通记录：已说明商品问题，商家表示两个工作日内回复。"],
          "示例沟通记录.txt",
          { type: "text/plain" },
        ),
      ],
    );
    await reload(id);
    setView("active");
    setSearch("");
    setNotice("已添加带有“示例”标记的虚构事项，可随时删除。");
  }

  return (
    <div className="app-shell" aria-busy={busy}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("active");
            setSearch("");
          }}
        >
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          <span>
            留底<small>LIUDI</small>
          </span>
        </a>
        <div className="workspace-label">
          我的资料空间 <span>本机</span>
        </div>
        <nav aria-label="主导航">
          <button
            className={view === "active" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setView("active");
              setSearch("");
            }}
          >
            <FolderOpen size={19} />
            处理中<span className="nav-count">{active.length}</span>
          </button>
          <button
            className={view === "resolved" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setView("resolved");
              setSearch("");
            }}
          >
            <CheckCheck size={19} />
            已办结
            <span className="nav-count">{cases.length - active.length}</span>
          </button>
          <div className="nav-divider" />
          <button className="nav-item" onClick={() => openModal("data")}>
            <HardDrive size={19} />
            备份与恢复
          </button>
          <button className="nav-item" onClick={() => openModal("help")}>
            <CircleHelp size={19} />
            使用指南
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <ShieldCheck size={25} />
            <strong>你的资料，由你保管</strong>
            <p>
              材料保存在当前浏览器中。
              <br />
              无需账户，不上传服务器。
            </p>
            <button onClick={() => openModal("data")}>
              了解本地保存 <ArrowUpRight size={14} />
            </button>
          </div>
          <a
            className="github-link"
            href="https://github.com/FuzzyLogic112/liudi"
            target="_blank"
            rel="noreferrer"
          >
            开源，让信任有迹可循 <ArrowUpRight size={13} />
          </a>
          <span className="version">留底 v0.1.1</span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <span>
            我的工作台 <ChevronRight size={14} />
            <strong>{view === "active" ? "处理中" : "已办结"}</strong>
          </span>
          <span className="local-status">
            <i />
            {offlineReady
              ? online
                ? "离线已就绪 · 本地保存"
                : "当前离线 · 本地保存"
              : "本地保存"}
          </span>
        </header>
        <div className="page">
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                少一点来回，多一份从容
              </div>
              <h1>把凭据留好，心里更有底。</h1>
              <p>从第一张订单，到最后一次沟通，把事情的来龙去脉放在一起。</p>
            </div>
            <button
              className="button primary"
              onClick={() => openModal("create")}
              disabled={busy}
            >
              <Plus size={18} />
              新建事项
            </button>
          </section>
          <section className="stats" aria-label="事项概况">
            <div className="stat">
              <span className="stat-icon sage">
                <FolderOpen size={21} />
              </span>
              <div>
                <span>正在处理</span>
                <strong>
                  {active.length}
                  <small>件事项</small>
                </strong>
              </div>
            </div>
            <div className="stat">
              <span className="stat-icon amber">
                <Clock3 size={21} />
              </span>
              <div>
                <span>到日待跟进</span>
                <strong>
                  {due}
                  <small>件事项</small>
                </strong>
              </div>
            </div>
            <div className="stat">
              <span className="stat-icon lavender">
                <CheckCheck size={21} />
              </span>
              <div>
                <span>已经办结</span>
                <strong>
                  {cases.length - active.length}
                  <small>件事项</small>
                </strong>
              </div>
              <Leaf className="stat-leaf" size={49} />
            </div>
          </section>
          {error && !modal && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}

          {!loaded ? (
            <div className="empty-state">
              <LoaderCircle className="spin" />
              <p>正在读取本地资料…</p>
            </div>
          ) : cases.length === 0 ? (
            <section className="onboarding">
              <div className="onboarding-content">
                <span className="pill">
                  <LockKeyhole size={13} />
                  只留在你的设备里
                </span>
                <h2>
                  给每一件待解决的事，
                  <br />
                  建一个安心的资料夹。
                </h2>
                <p>
                  截图散落在相册，沟通埋在聊天里？
                  <br />
                  让订单、经过和诉求各就各位，下次说明时少翻找一次。
                </p>
                <div className="onboarding-actions">
                  <button
                    className="button primary"
                    onClick={() => openModal("create")}
                  >
                    <Plus size={17} />
                    建立我的第一件事项
                  </button>
                  <button
                    className="button text-button"
                    disabled={busy}
                    onClick={() => run(loadDemo)}
                  >
                    先体验示例 <ArrowRight size={16} />
                  </button>
                </div>
                <small>所有示例均为虚构数据 · 不需要注册</small>
              </div>
              <div className="folder-illustration" aria-hidden="true">
                <div className="paper paper-back">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="paper paper-front">
                  <span className="paper-stamp">
                    <Check size={23} />
                  </span>
                  <b>每一份记录，都有着落。</b>
                  <span />
                  <span />
                  <span className="short" />
                </div>
                <div className="folder-face">
                  <span>
                    <FileCheck2 size={23} />
                    留底 · 我的材料
                  </span>
                  <i>KEEP A RECORD.</i>
                </div>
                <span className="float-label">
                  <ShieldCheck size={15} />
                  本地保存，随时整理
                </span>
              </div>
              <div className="onboarding-steps">
                <div>
                  <span>01</span>
                  <strong>记一件事</strong>
                  <p>写下商家、订单和你的诉求</p>
                </div>
                <div>
                  <span>02</span>
                  <strong>串起经过</strong>
                  <p>记录进展，关联原始材料</p>
                </div>
                <div>
                  <span>03</span>
                  <strong>带走资料</strong>
                  <p>导出材料包，沟通时更清楚</p>
                </div>
              </div>
            </section>
          ) : (
            <section className="workspace">
              <div className="case-panel">
                <div className="panel-heading">
                  <h2>
                    {view === "active" ? "处理中" : "已办结"}
                    <span>{filtered.length}</span>
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="新建事项"
                    onClick={() => openModal("create")}
                  >
                    <Plus size={19} />
                  </button>
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="搜索事项、商家或订单"
                    aria-label="搜索事项"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="case-list">
                  {filtered.map((c) => (
                    <button
                      key={c.id}
                      className={`case-card ${current?.id === c.id ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedId(c.id);
                        setTab("timeline");
                      }}
                    >
                      <div className="case-top">
                        <span
                          className={`category-symbol category-${CATEGORIES.indexOf(c.category)}`}
                        >
                          {categoryMarks[c.category]}
                        </span>
                        <span>{c.category}</span>
                        {c.status === "resolved" ? (
                          <CheckCheck size={15} />
                        ) : (
                          <span className="small-dot" />
                        )}
                      </div>
                      <h3>{c.title}</h3>
                      <p>{c.merchant || "商家尚未填写"}</p>
                      <div className="case-footer">
                        <span
                          className={
                            c.deadline &&
                            c.deadline <= today() &&
                            c.status === "active"
                              ? "due"
                              : ""
                          }
                        >
                          <Clock3 size={13} />
                          {c.status === "resolved"
                            ? "已办结"
                            : relativeDay(c.deadline)}
                        </span>
                        <span>{c.events.length} 条记录</span>
                      </div>
                    </button>
                  ))}
                  {filtered.length === 0 && (
                    <div className="list-empty">
                      <Search size={27} />
                      <p>
                        {search
                          ? "没有找到匹配的事项"
                          : view === "resolved"
                            ? "办结的事项会收在这里"
                            : "暂时没有待处理事项"}
                      </p>
                      {search && (
                        <button
                          className="text-button"
                          onClick={() => setSearch("")}
                        >
                          清除搜索
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className="import-link"
                  disabled={busy}
                  onClick={() => importRef.current?.click()}
                >
                  <Upload size={15} />
                  从材料包恢复事项
                </button>
              </div>

              {current ? (
                <article className="detail-panel" key={current.id}>
                  <div className="detail-top">
                    <div className="detail-kicker">
                      <span
                        className={`pill ${current.status === "resolved" ? "resolved" : ""}`}
                      >
                        <span className="small-dot" />
                        {current.status === "resolved" ? "已办结" : "处理中"}
                      </span>
                      <span>{current.category}</span>
                    </div>
                    <div className="detail-title">
                      <h2>{current.title}</h2>
                      <button
                        className="edit-link"
                        onClick={() => openModal("edit")}
                      >
                        编辑
                      </button>
                    </div>
                    <div className="detail-meta">
                      <span>{current.merchant || "商家未填写"}</span>
                      <i /> <span>{money(current.amount)}</span>
                    </div>
                    <div className="goal">
                      <span>我的诉求</span>
                      <p>
                        {current.goal ||
                          "还没有填写诉求。点击编辑，写下你希望如何解决。"}
                      </p>
                    </div>
                    <div className="detail-actions">
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() => run(backup)}
                      >
                        <ArrowDownToLine size={16} />
                        导出材料包
                      </button>
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await navigator.clipboard.writeText(
                              summary(current),
                            );
                            setNotice("事实摘要已复制，可在沟通时粘贴使用。");
                          })
                        }
                      >
                        <Clipboard size={15} />
                        复制摘要
                      </button>
                      <button
                        className="button small action-resolve"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const status =
                              current.status === "active"
                                ? "resolved"
                                : "active";
                            await updateCaseMeta(current.id, { status });
                            await committed(
                              status === "resolved"
                                ? "事项已归入“已办结”。"
                                : "事项已重新开启。",
                              current.id,
                              status,
                            );
                          })
                        }
                      >
                        <CheckCheck size={15} />
                        {current.status === "active" ? "标记办结" : "重新开启"}
                      </button>
                    </div>
                  </div>
                  <div className="detail-body">
                    <div className="detail-main">
                      <div
                        className="tabs"
                        role="tablist"
                        aria-label="事项内容"
                      >
                        <button
                          role="tab"
                          aria-selected={tab === "timeline"}
                          className={tab === "timeline" ? "selected" : ""}
                          onClick={() => setTab("timeline")}
                        >
                          事情经过 <span>{current.events.length}</span>
                        </button>
                        <button
                          role="tab"
                          aria-selected={tab === "files"}
                          className={tab === "files" ? "selected" : ""}
                          onClick={() => setTab("files")}
                        >
                          相关材料 <span>{attachments.length}</span>
                        </button>
                      </div>
                      <div className="tab-content">
                        {tab === "timeline" ? (
                          <>
                            <button
                              className="add-event"
                              onClick={() => openModal("event")}
                              disabled={busy}
                            >
                              <span>
                                <Plus size={17} />
                              </span>
                              记一条新进展 <small>每一步，都留个底</small>
                            </button>
                            <div className="timeline">
                              {[...current.events]
                                .sort((a, b) =>
                                  (b.date || "0000").localeCompare(
                                    a.date || "0000",
                                  ),
                                )
                                .map((e) => (
                                  <div className="timeline-item" key={e.id}>
                                    <span className="timeline-dot" />
                                    <div className="event-top">
                                      <time>{e.date || "日期不详"}</time>
                                      <button
                                        className="icon-button delete-event"
                                        title="删除这条记录"
                                        aria-label={`删除记录：${e.title}`}
                                        disabled={busy}
                                        onClick={() => {
                                          setDeleteTarget({
                                            caseId: current.id,
                                            eventId: e.id,
                                            title: e.title,
                                          });
                                          openModal("delete");
                                        }}
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </div>
                                    <h3>{e.title}</h3>
                                    <p>{e.description || "未补充详细说明。"}</p>
                                    {e.attachmentIds.length > 0 && (
                                      <div className="event-files">
                                        {e.attachmentIds.map((id) => {
                                          const file = attachments.find(
                                            (a) => a.id === id,
                                          );
                                          return file ? (
                                            <button
                                              key={id}
                                              title={`下载原始文件：${file.name}`}
                                              onClick={() =>
                                                download(file.blob, file.name)
                                              }
                                            >
                                              <Paperclip size={13} />
                                              <span>{file.name}</span>
                                              <ArrowDownToLine size={13} />
                                            </button>
                                          ) : null;
                                        })}
                                      </div>
                                    )}
                                  </div>
                                ))}
                            </div>
                            {current.events.length === 0 && (
                              <div className="mini-empty">
                                <FileText size={32} />
                                <h3>从第一条经过开始</h3>
                                <p>
                                  记录购买、发现问题或联系商家的过程，
                                  <br />
                                  把相关材料一起放进来。
                                </p>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="files-intro">
                              <span>共 {attachments.length} 份原始材料</span>
                              <button
                                className="edit-link"
                                onClick={() => openModal("event")}
                              >
                                添加材料
                              </button>
                            </div>
                            {attachments.map((a) => (
                              <div className="attachment" key={a.id}>
                                <span className="file-icon">
                                  <FileText size={20} />
                                </span>
                                <div>
                                  <strong title={a.name}>{a.name}</strong>
                                  <small>
                                    {bytes(a.size)} · SHA-256 已记录
                                  </small>
                                  <code title={a.sha256}>
                                    {a.sha256.slice(0, 20)}…
                                  </code>
                                </div>
                                <button
                                  className="icon-button"
                                  aria-label={`下载 ${a.name}`}
                                  onClick={() => download(a.blob, a.name)}
                                >
                                  <ArrowDownToLine size={17} />
                                </button>
                              </div>
                            ))}
                            {attachments.length === 0 && (
                              <div className="mini-empty">
                                <Paperclip size={32} />
                                <h3>暂时没有附件</h3>
                                <p>记录新进展时，可以一并选择相关文件。</p>
                              </div>
                            )}
                            <p className="file-note">
                              文件摘要用于比对内容是否一致，不证明材料真实性、发生时间或法律效力。
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                    <aside className="detail-aside">
                      <section className="followup">
                        <CalendarDays size={19} />
                        <h3>下次跟进</h3>
                        <strong>{current.deadline || "还未安排"}</strong>
                        <p>
                          {current.status === "resolved"
                            ? "这件事已办结"
                            : relativeDay(current.deadline)}
                        </p>
                        <button
                          disabled={
                            !current.deadline || current.status === "resolved"
                          }
                          onClick={() => {
                            calendar(current);
                            setNotice(
                              "日历文件已生成，请在日历应用中导入并设置提醒。",
                            );
                          }}
                        >
                          加入我的日历 <ArrowUpRight size={13} />
                        </button>
                      </section>
                      <section className="checklist">
                        <h3>
                          <ListChecks size={17} />
                          材料准备
                        </h3>
                        <p>按实际情况手动勾选</p>
                        {CHECKLIST.map((item) => (
                          <label key={item}>
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={current.checklist.includes(item)}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                run(async () => {
                                  await toggleChecklist(
                                    current.id,
                                    item,
                                    checked,
                                  );
                                  await committed("材料准备标记已保存。");
                                });
                              }}
                            />
                            <span>{item}</span>
                          </label>
                        ))}
                        <span className="checklist-progress">
                          <i
                            style={{
                              width: `${current.checklist.filter((i) => CHECKLIST.includes(i)).length * 25}%`,
                            }}
                          />
                        </span>
                        <small>
                          {
                            current.checklist.filter((i) =>
                              CHECKLIST.includes(i),
                            ).length
                          }{" "}
                          / 4 项已准备
                        </small>
                      </section>
                      <div className="gentle-tip">
                        <Sparkles size={16} />
                        <p>
                          保留原始文件。截图之外，订单号和沟通日期也很有帮助。
                        </p>
                      </div>
                    </aside>
                  </div>
                  <div className="detail-footer">
                    <span>
                      <LockKeyhole size={12} />
                      资料仅保存在当前浏览器
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setDeleteTarget({
                          caseId: current.id,
                          title: current.title,
                        });
                        openModal("delete");
                      }}
                    >
                      删除事项
                    </button>
                  </div>
                </article>
              ) : (
                <div className="detail-placeholder">
                  <FolderOpen size={44} />
                  <h3>每一件事，都值得好好收尾。</h3>
                  <p>选择一件事项，查看它的经过和材料。</p>
                </div>
              )}
            </section>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} />
              无需注册 · 无广告 · 不调用 AI
            </span>
            <span>
              记得定期导出备份，让记录真正留得住。
              <button onClick={() => openModal("data")}>
                备份指南 <ArrowRight size={13} />
              </button>
            </span>
          </footer>
        </div>
      </main>
      <input
        ref={importRef}
        type="file"
        accept=".zip,application/zip"
        className="visually-hidden"
        aria-label="导入留底材料包"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            run(async () => {
              const id = await importCase(file);
              setModal(null);
              setSearch("");
              setNotice("恢复完成，已创建独立副本。原有事项未被覆盖。");
              try {
                const all = await listCases();
                setCases(all);
                setSelectedId(id);
                setView(all.find((c) => c.id === id)?.status ?? "active");
              } catch {
                setError(
                  "恢复已完成，但列表刷新失败。请刷新页面查看，不要重复导入。",
                );
              }
            });
        }}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle className="spin" size={16} />
          正在处理，请稍候…
        </div>
      )}
      {(modal === "create" || modal === "edit") && (
        <Modal
          title={modal === "create" ? "新建一件事项" : "编辑事项"}
          busy={busy}
          onClose={() => setModal(null)}
        >
          <CaseForm
            busy={busy}
            error={error}
            value={modal === "edit" ? (modalCase ?? undefined) : undefined}
            onSave={(c) =>
              run(async () => {
                if (modal === "edit") {
                  const {
                    title,
                    category,
                    merchant,
                    orderNo,
                    amount,
                    goal,
                    deadline,
                  } = c;
                  await updateCaseMeta(c.id, {
                    title,
                    category,
                    merchant,
                    orderNo,
                    amount,
                    goal,
                    deadline,
                  });
                } else await saveCase(c);
                setSearch("");
                await committed(
                  "事项已保存在本机。",
                  c.id,
                  modal === "create" ? c.status : undefined,
                );
              })
            }
          />
        </Modal>
      )}
      {modal === "event" && modalCase && (
        <Modal title="记一条新进展" busy={busy} onClose={() => setModal(null)}>
          <EventForm
            error={error}
            busy={busy}
            onSave={(event, files) =>
              run(async () => {
                await addEvent(modalCase.id, event, files);
                setTab("timeline");
                await committed("进展和附件已一并保存。", modalCase.id);
              })
            }
          />
        </Modal>
      )}
      {modal === "delete" && deleteTarget && (
        <Modal
          title={deleteTarget.eventId ? "删除这条记录？" : "删除这个事项？"}
          busy={busy}
          onClose={() => setModal(null)}
        >
          <div className="prose">
            <p>
              将删除「{deleteTarget.title}」
              {deleteTarget.eventId ? "及它关联的附件" : "的全部记录和附件"}
              。此操作无法撤销。
            </p>
            <p>如果还需要保留，请先关闭弹窗并导出材料包。</p>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (deleteTarget.eventId)
                      await deleteEvent(
                        deleteTarget.caseId,
                        deleteTarget.eventId,
                      );
                    else await deleteCase(deleteTarget.caseId);
                    await committed("已删除。");
                  })
                }
              >
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "data" && (
        <Modal title="备份与恢复" busy={busy} onClose={() => setModal(null)}>
          <div className="prose">
            <div className="info-callout">
              <ShieldCheck size={22} />
              <p>
                <strong>本地保存，主动备份。</strong>
                <br />
                资料保存在当前浏览器中，清理网站数据、使用无痕模式或更换设备可能导致资料丢失。不会自动同步到其他设备。
              </p>
            </div>
            <h3>1. 导出一件事项</h3>
            <p>
              选中事项后，点击“导出材料包”。ZIP
              中包含原始附件、材料清单和可离线打开、打印的报告。每件事项需要分别备份。
            </p>
            <button
              className="button"
              disabled={!current || busy}
              onClick={() => run(backup)}
            >
              <ArrowDownToLine size={16} />
              {current ? "导出当前事项" : "先选择一个事项"}
            </button>
            <p className="field-hint">
              材料包和本地数据库均未加密。请在私人设备上使用，并妥善保管、谨慎分享文件。
            </p>
            <h3>2. 在另一台设备上恢复</h3>
            <p>
              选择由留底导出的
              ZIP。通过文件校验后，会建立独立副本，不覆盖原事项。
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={() => importRef.current?.click()}
            >
              <Upload size={16} />
              选择材料包恢复
            </button>
            <h3>3. 减少浏览器自动清理</h3>
            <p>
              可以申请持久存储；是否批准由浏览器决定。即使获准，也无法防止手动清理，仍然需要备份。
            </p>
            <button
              className="button small"
              disabled={persistent || busy}
              onClick={() =>
                run(async () => {
                  const granted = await navigator.storage?.persist?.();
                  setPersistent(!!granted);
                  setNotice(
                    granted
                      ? "浏览器已授予持久存储。仍请定期备份。"
                      : "浏览器未授予持久存储，请定期导出备份。",
                  );
                })
              }
            >
              <HardDrive size={15} />
              {persistent ? "已获得持久存储" : "申请持久存储"}
            </button>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="让每一份记录，都有着落" onClose={() => setModal(null)}>
          <div className="prose">
            <p>
              留底帮助你整理消费售后的事实和资料，适合退货退款、维修保修和预付消费等场景。
            </p>
            <ol>
              <li>
                <strong>建事项：</strong>
                写清商家、订单、涉及金额和希望如何解决。
              </li>
              <li>
                <strong>记经过：</strong>
                每次沟通、寄件或收到答复后，记一条进展并添加原文件。日期不详时可以留空。
              </li>
              <li>
                <strong>定跟进：</strong>
                自行设置跟进日期，导入日历后可在日历应用中设置提醒。
              </li>
              <li>
                <strong>带走资料：</strong>复制摘要用于沟通，导出 ZIP
                用于备份。解压后打开 report.html，可以浏览、打印或另存为 PDF。
              </li>
            </ol>
            <div className="info-callout">
              <FileCheck2 size={22} />
              <p>
                留底不提供法律判断或自动投诉。文件摘要仅用于核对内容，不代表材料真实、可信时间戳或司法证据效力。请保留原始载体，并按接收方要求提交。
              </p>
            </div>
            <h3>关于离线使用</h3>
            <p>
              正式版首次加载并显示“离线已就绪”后，可以在断网时重新打开。浏览器更换、域名变更和不同端口会使用不同的资料空间。
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await loadDemo();
                  setModal(null);
                })
              }
            >
              <Sparkles size={16} />
              添加虚构示例体验
            </button>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
