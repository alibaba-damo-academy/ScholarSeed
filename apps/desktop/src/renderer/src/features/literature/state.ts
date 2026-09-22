/**
 * 文献库领域状态切片。
 *
 * 本文件只定义数据形状与纯函数，不持有可变状态；
 * 可变状态由全局 Store 的 `literature` 切片持有。
 */

import type { LiteratureNote } from '../../contracts/literature'

/** 全文获取状态。 */
export type FulltextStatus =
  "none" | "oa" | "restricted" | "ready" | "fetching";

/** 后端支持的 BibTeX 文献类型。 */
export type PublicationType =
  | "inproceedings"
  | "article"
  | "misc"
  | "book"
  | "techreport"
  | "incollection"
  | "phdthesis"
  | "mastersthesis";

/** 文献条目。 */
export interface LiteratureItem {
  id: string;
  pubtype: PublicationType;
  title: string;
  authors: string;
  journal: string;
  url: string;
  venue: string;
  year: number | null;
  pages: string;
  volume: string;
  arxiv: string;
  publisher: string;
  address: string;
  tags: string[];
  fulltext: FulltextStatus;
  /** 所属分类；空串表示没有分类，全览的未整理还需排除项目关联。 */
  collection: string;
  added_at: number;
  hasPdf: boolean;
  abstract?: string;
  doi?: string;
  notes?: LiteratureNote[];
}

/** 左侧导航当前选中的范围。 */
export type LiteratureScope =
  | { kind: "all" }
  | { kind: "recent" }
  | { kind: "collection"; name: string }
  | { kind: "tag"; name: string };

/** 分类项。 */
export interface LiteratureCollection {
  name: string;
  count: number;
  parent: string;
}

/** 标签项。 */
export interface LiteratureTag {
  name: string;
  count: number;
}

/** 列表排序字段。 */
export type LiteratureSort = "added" | "title" | "year" | "authors" | "journal";

/** PDF 状态筛选。 */
export type PdfFilter = "all" | "pdf" | "meta";

/** 右键菜单状态。 */
export interface LiteratureMenuState {
  id: string;
  x: number;
  y: number;
}

/** 分类新建/重命名草稿。 */
export interface CollectionDraft {
  mode: "create" | "rename" | "child";
  target: string;
  value: string;
}

/** 详情面板 Tab。 */
export type DetailTab = "basic" | "notes" | "marks";

export interface LiteratureState {
  items: LiteratureItem[];
  /** 库内总条目数（不受筛选影响）。 */
  total: number;
  /** 「最近添加」的条目数，侧栏计数用。 */
  recentTotal: number;
  collections: LiteratureCollection[];
  tags: LiteratureTag[];
  /** 库内出现过的年份，倒序，供筛选下拉使用。 */
  years: number[];
  /** 各全文状态计数。 */
  fulltextCounts: Record<string, number>;
  scope: LiteratureScope;
  /** 列表搜索关键词。 */
  searchText: string;
  /** PDF 状态筛选。 */
  pdfFilter: PdfFilter;
  sort: LiteratureSort;
  sortDesc: boolean;
  /** 勾选的条目 id，用于批量操作。 */
  selected: Record<string, boolean>;
  /** 筛选面板开合。 */
  filterOpen: boolean;
  /** 导入菜单开合。 */
  importMenuOpen: boolean;
  /** 批量打标输入框内容。 */
  tagDraft: string;
  /** 分类分组是否展开。 */
  collectionsOpen: boolean;
  /** 标签分组是否展开。 */
  tagsOpen: boolean;
  /** 分类新建/重命名草稿；null = 无。 */
  collectionDraft: CollectionDraft | null;
  /** 行右键菜单。 */
  rowMenu: LiteratureMenuState | null;
  /** 批量「加入分类」下拉是否展开。 */
  collectionPickerOpen: boolean;
  /** 条目详情抽屉当前条目 id；null = 不展示。 */
  detailId: string | null;
  /** 详情面板当前 Tab。 */
  detailTab: DetailTab;
  /** 笔记输入草稿。 */
  noteDraft: string;
  /** AI 检索卡片的输入内容。 */
  aiSearchText: string;
  /** 一次性提示。 */
  notice: { tone: "ok" | "error"; text: string } | null;
  /** 加载态。 */
  loadState: "idle" | "loading" | "ready" | "error";
}

export const INITIAL_LITERATURE_STATE: LiteratureState = {
  items: [],
  total: 0,
  recentTotal: 0,
  collections: [],
  tags: [],
  years: [],
  fulltextCounts: {},
  scope: { kind: "all" },
  searchText: "",
  pdfFilter: "all",
  sort: "added",
  sortDesc: false,
  selected: {},
  filterOpen: false,
  importMenuOpen: false,
  tagDraft: "",
  collectionsOpen: true,
  tagsOpen: true,
  collectionDraft: null,
  rowMenu: null,
  collectionPickerOpen: false,
  detailId: null,
  detailTab: "basic",
  noteDraft: "",
  aiSearchText: "",
  notice: null,
  loadState: "idle",
};

/** 全文状态的中文标签。 */
export const FULLTEXT_LABEL: Record<FulltextStatus, string> = {
  none: "未获取",
  oa: "开放获取",
  restricted: "需权限",
  ready: "已就绪",
  fetching: "获取中",
};

/** 系统保留的分类名。 */
export const UNFILED_COLLECTION = "未整理";

/** 标签调色板。 */
export const TAG_PALETTE = [
  "#9A6A16",
  "#17452F",
  "#3C6B52",
  "#8A3A2E",
  "#6B5428",
  "#2F5340",
  "#B4842B",
] as const;

/** 标签名 → 颜色。 */
export function tagColor(tag: string): string {
  let sum = 0;
  for (let index = 0; index < tag.length; index += 1) {
    sum += tag.charCodeAt(index);
  }
  return TAG_PALETTE[sum % TAG_PALETTE.length];
}
