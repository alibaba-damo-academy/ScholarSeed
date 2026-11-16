import fixtures from "./fixtures.json";
import NARRATIVE from "./narrative.json";
import INTERPRETATION from "./interpretation.json";
import { createPreviewSession } from "../../../apps/desktop/src/renderer/src/components/business/preview.ts";

const UI = window.scholarseedUI;
const { React, Conversation: C } = UI;
const el = React.createElement;
const DATA = {
  columns: [
    { key: "material", label: "材料" },
    { key: "mass", label: "质量", unit: "kg" },
    { key: "delta", label: "净变化", unit: "kg" },
  ],
  rows: [
    { id: "copper", values: ["铜", 7, -3] },
    { id: "aluminium", values: ["铝", 11, 0] },
    { id: "steel", values: ["钢", 0, 4] },
    { id: "polymer", values: ["聚合物", 5, null] },
  ],
};
const IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e9efea"/><path d="M90 260V100H160V260M240 260V60H310V260M390 260V180H460V260" stroke="#426557" stroke-width="30"/><text x="40" y="325" font-size="22" fill="#27483b">MOCK · synthetic chart illustration</text></svg>',
  );
const CHARTS = {
  Plot: "bar",
  BarChart: "bar",
  GroupedBarChart: "grouped-bar",
  StackedBarChart: "stacked-bar",
  LineChart: "line",
  ScatterChart: "scatter",
  PieChart: "pie",
  DonutChart: "donut",
  Histogram: "histogram",
  BoxPlot: "boxplot",
  Heatmap: "heatmap",
};
const GROUPS = {
  图表与富内容: [
    "Plot",
    "BarChart",
    "GroupedBarChart",
    "StackedBarChart",
    "LineChart",
    "ScatterChart",
    "PieChart",
    "DonutChart",
    "Histogram",
    "BoxPlot",
    "Heatmap",
    "DataTable",
    "Markdown",
    "Formula",
    "Tabulation",
  ],
  科研结果与引用: [
    "Results",
    "Details",
    "Review",
    "CitationLink",
    "CitationSources",
  ],
  产物与工作台: [
    "Artifact",
    "ArtifactGroup",
    "ArtifactMenuItems",
    "FileMenuItems",
    "ArtifactDestination",
    "FileFormatIcon",
    "Canvas",
  ],
};
const LABELS = {
  Plot: "通用图表",
  Markdown: "正文",
  Formula: "公式",
  Tabulation: "简表",
  CitationLink: "文献引用标记",
  CitationSources: "引用来源",
  Artifact: "文件产物",
  ArtifactGroup: "产物分组",
  ArtifactMenuItems: "产物操作菜单",
  FileMenuItems: "文件操作菜单",
  FileFormatIcon: "文件格式",
  BarChart: "柱状图",
  GroupedBarChart: "分组柱状图",
  StackedBarChart: "堆叠柱状图",
  LineChart: "折线图",
  ScatterChart: "散点图",
  PieChart: "饼图",
  DonutChart: "环图",
  Histogram: "直方图",
  BoxPlot: "箱线图",
  Heatmap: "热力图",
  DataTable: "交互数据表",
  Results: "科研结果卡",
  Details: "结果详情",
  Review: "科研综述",
  ArtifactDestination: "产物保存目标",
  Canvas: "画布",
};
const CITATION = {
  handle: "mock-source",
  pages: [],
  source_kind: "resource",
  source_id: "mock-notes",
  content_level: "structured_text",
  project_id: "mock-ui",
  path: "materials/notes.md",
  title: "MOCK 合成说明",
  revision: "mock-v1",
  quote: "这些数值只用于设计调整。",
  version_bound: true,
  state: "source_only",
  matches: [],
  presentation: {
    version: 1,
    mode: "structured_text",
    precision: "source",
    text: "这些数值只用于设计调整。",
    quality_reasons: [],
    manual_check: true,
  },
};
const WEB = {
  number: 1,
  kind: "searched",
  title: "MOCK 网页参考",
  url: "https://example.com",
  site: "example.com",
};
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: String(error) };
  }
  render() {
    return this.state.error
      ? el(
          "pre",
          {
            className:
              "whitespace-pre-wrap break-words text-[var(--vds-text-error)]",
            "data-demo-error": this.props.name,
          },
          this.state.error,
        )
      : this.props.children;
  }
}

function Laboratory({ state, onAction }) {
  const name = state.data.sample;
  const [mode, setMode] = React.useState("normal");
  const [generation, setGeneration] = React.useState(0);
  const [log, setLog] = React.useState("尚无操作。所有回执均为本地模拟。");
  const [long, setLong] = React.useState(false);
  const report = React.useCallback((message) => {
    setLog(message);
    onAction?.(message);
  }, [onAction]);
  if (!Object.values(GROUPS).flat().includes(name))
    return el(
      UI.Alert,
      { tone: "error" },
      el(UI.AlertDescription, null, "未找到示例。"),
    );
  const narrative =
    NARRATIVE[name] + (long ? "\n\n" + NARRATIVE[name].repeat(8) : "");
  return el(
    "section",
    {
      "data-demo-sample": name,
      className: "grid min-w-0 gap-[var(--vds-conversation-block-gap)]",
    },
    el(C.Markdown, { text: narrative, math: true }),
    el(
      "div",
      { className: "min-w-0 [&>*]:my-0", "data-demo-component": name },
      el(
        Boundary,
        { key: name + generation, name },
        el(Sample, { name, mode, log: report }),
      ),
    ),
    el(C.Markdown, { text: INTERPRETATION[name] }),
    el(
      UI.Collapsible,
      { "data-demo-debug": name, className: "!gap-0" },
      el(
        UI.CollapsibleTrigger,
        { asChild: true },
        el(
          UI.Button,
          {
            size: "xs",
            variant: "ghost",
            className: "justify-self-start text-[var(--vds-text-secondary)]",
            "aria-label": "设计调试：" + (LABELS[name] || name),
          },
          "设计调试",
        ),
      ),
      el(
        UI.CollapsibleContent,
        { className: "!border-0 !p-0" },
        el(
          UI.Card,
          { className: "grid min-w-0 gap-[var(--vds-space-3)]" },
          el(
            "p",
            {
              className:
                "m-0 break-words text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]",
            },
            "Conversation." +
              name +
              " · 官方 UI " +
              UI.version +
              " · MOCK · 不执行真实操作",
          ),
          el(
            "div",
            {
              className: "flex flex-wrap items-center gap-[var(--vds-space-2)]",
            },
            ...["normal", "loading", "failure"].map((value) =>
              el(
                UI.Button,
                {
                  key: value,
                  size: "sm",
                  variant: mode === value ? "primary" : "secondary",
                  onClick: () => setMode(value),
                },
                { normal: "正常", loading: "等待 / 延迟", failure: "失败" }[
                  value
                ],
              ),
            ),
            el(
              UI.Button,
              {
                size: "sm",
                variant: "secondary",
                onClick: () => {
                  setGeneration((value) => value + 1);
                  report("已重置模拟交互。");
                },
              },
              "重置",
            ),
            el(
              UI.Button,
              {
                size: "sm",
                variant: "secondary",
                "aria-pressed": long,
                onClick: () => setLong((value) => !value),
              },
              "长内容",
            ),
          ),
          el(C.Markdown, { text: "```text\n" + log + "\n```" }),
        ),
      ),
    ),
  );
}
export { Laboratory, GROUPS, LABELS };
function chartModel(name) {
  const kind = CHARTS[name];
  if (kind === "scatter")
    return {
      kind,
      dataset: {
        columns: [
          { key: "load", label: "负载" },
          { key: "error", label: "误差" },
        ],
        rows: [
          [-3, 2],
          [0, -2],
          [2, 4],
          [5, 1],
        ].map((values, index) => ({ id: `point-${index}`, values })),
      },
      x: 0,
      y: [1],
    };
  if (kind === "histogram")
    return {
      kind,
      dataset: {
        columns: [{ key: "delay", label: "延迟", unit: "ms" }],
        rows: [0, 1, 1, 4, 5, 7, 8, 9, 10, 14, 15, 19, 20].map(
          (value, index) => ({ id: `obs-${index}`, values: [value] }),
        ),
      },
      x: 0,
      y: [],
      bins: 4,
    };
  if (kind === "boxplot")
    return {
      kind,
      dataset: {
        columns: ["批次", "最小值", "Q1", "中位数", "Q3", "最大值"].map(
          (label, index) => ({ key: `field-${index}`, label }),
        ),
        rows: [
          { id: "east", values: ["东", -3, 0, 2, 7, 11] },
          { id: "west", values: ["西", -1, 2, 4, 4, 9] },
        ],
      },
      x: 0,
      y: [1, 2, 3, 4, 5],
    };
  if (kind === "heatmap")
    return {
      kind,
      dataset: {
        columns: [
          { key: "region", label: "区域" },
          { key: "period", label: "时段" },
          { key: "temperature", label: "温度", unit: "℃" },
        ],
        rows: [
          ["东", "上午", -3],
          ["东", "下午", 2],
          ["西", "上午", 0],
          ["西", "下午", 7],
        ].map((values, index) => ({ id: `cell-${index}`, values })),
      },
      x: 0,
      y: [1],
      value: 2,
    };
  return {
    kind,
    dataset: DATA,
    x: 0,
    y:
      kind === "grouped-bar" || kind === "stacked-bar" || kind === "line"
        ? [1, 2]
        : [1],
  };
}
function Sample({ name, mode, log }) {
  const [selected, setSelected] = React.useState([]);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [removed, setRemoved] = React.useState(false);
  const [location, setLocation] = React.useState({
    path: "",
    name: "mock-report.md",
  });
  const fixtureKey = {
    Results: "results",
    Details: "details",
    Review: "review",
  }[name];
  const fixture = fixtures[fixtureKey] || { data: {}, responses: {} };
  const execution = React.useMemo(
    () => createPreviewSession(fixture),
    [fixtureKey],
  );
  const record = async (action, values) => {
    log(`${name}: ${action} ${JSON.stringify(values ?? {})}`);
    if (mode === "failure") throw Error("MOCK：演示操作失败，可切回正常重试");
    if (mode === "loading")
      await new Promise((resolve) => setTimeout(resolve, 1200));
  };
  const onCopy = async (text) => {
    await record("copy-preview", { text });
  };
  const ports = React.useMemo(
    () =>
      UI.createLiteraturePorts(
        async (action, values = {}) => {
          await record(action, values);
          const reply = execution.execute(action, values);
          if (reply.state === "failed") throw Error(reply.data.error);
          return reply.data.result;
        },
        { projectId: "sample-project", projectName: "MOCK 对话卡片实验室" },
      ),
    [name, mode],
  );
  const menu = {
    apps: [],
    appsLoading: mode === "loading",
    canSaveAs: true,
    canUsePath: true,
    downloading: false,
    loadApps: () => log("MOCK 加载应用列表"),
    onCopyPath: () => log("MOCK 复制路径，不写剪贴板"),
    onOpenWith: () => log("MOCK 外部打开"),
    onReveal: () => log("MOCK 定位文件，不打开系统窗口"),
    onSaveAs: () => log("MOCK 另存为，不写文件"),
    revealLabel: "MOCK 显示文件位置",
    onOpen: () => log("MOCK 打开文件"),
    onImport: () => log("MOCK 导入，不写资料库"),
    canImport: true,
  };
  const artifact = {
    artifact_id: "mock-report",
    publication_id: "mock-publication",
    name: "mock-report.md",
    title: "MOCK 研究报告",
    path: "materials/notes.md",
    absolute_path: "/mock/materials/notes.md",
    media_type: "text/markdown",
    size: 1024,
    sha256: "0".repeat(64),
    status: "available",
    role: "final",
    updated_at: 1700000000,
    change: "create",
  };
  const artifactCard = () =>
    el(C.Artifact, {
      primary: artifact,
      versions: [artifact],
      primaryMeta: "1 KB · MOCK v1",
      canImport: true,
      menuProps: menu,
      preview: () => record("preview", artifact.path),
      previewVersion: () => record("version", artifact.path),
      openImport: () => log("MOCK 入库，不执行"),
    });
  if (CHARTS[name])
    return el(C[name], {
      model: chartModel(name),
      selected,
      onSelectionChange: (ids) => {
        setSelected(ids);
        log(`${name}: 原始 ID ${ids.join(", ")}`);
      },
      title: LABELS[name] || "材料质量比较",
      sources: ["MOCK 合成材料，不代表实际实验"],
      onCopy,
    });
  switch (name) {
    case "DataTable":
      return el(C.DataTable, {
        dataset: DATA,
        selected,
        onSelectionChange: setSelected,
        onCopy,
      });
    case "Markdown":
      return el(C.Markdown, {
        text: '### 材料对比说明\n\n这批合成材料使用一致的质量单位，下表保留铜与铝的原始记录。\n\n|材料|kg|\n|---|---:|\n|铜|7|\n|铝|11|\n\n$E=mc^2$\n\n```python\nprint("仅显示，不执行")\n```',
        math: true,
        onOpenExternal: async (url) => record("navigate-blocked", url),
      });
    case "Formula":
      return el(C.Formula, {
        source: "$$\\frac{7+11}{23}$$",
        caption: "MOCK 公式",
        notes: "渲染不等于数学核验",
        onCopy,
      });
    case "Tabulation":
      return el(
        C.Tabulation,
        { caption: "材料质量记录", copyText: "材料\tkg\n铜\t7", onCopy },
        el(
          UI.Table,
          null,
          el(
            UI.TableBody,
            null,
            el(
              UI.TableRow,
              null,
              el(UI.TableCell, null, "铜"),
              el(UI.TableCell, null, "7 kg"),
            ),
          ),
        ),
      );
    case "Canvas":
      return el(C.Canvas, { title: "材料比较笔记", document: { format: "html", version: 1, source: "<p>MOCK 只读画布，不调用模型。</p>" }, onOpen: () => record("open-canvas") });
    case "Results":
    case "Details":
    case "Review":
      return el(C[name], {
        content: fixture.data,
        cardId: `mock-${name}`,
        ports,
      });

    case "CitationLink":
      return el(
        C.CitationLink,
        {
          resolve: async () => {
            await record("resolve");
            return CITATION;
          },
          reveal: () => record("reveal"),
          previewUrl: () => "/materials/sample.pdf",
        },
        "[1]",
      );
    case "CitationSources":
      return el(C.CitationSources, {
        sourceKey: "mock",
        answerSources: [WEB],
        resolveSource: async () => CITATION,
        reveal: () => record("reveal"),
        previewUrl: () => "/materials/sample.pdf",
        openWebSource: (url) => log(`MOCK 来源 ${url}`),
      });

    case "Artifact":
      return artifactCard();
    case "ArtifactGroup":
      return el(
        C.ArtifactGroup,
        null,
        artifactCard(),
        el(C.Artifact, {
          primary: {
            ...artifact,
            artifact_id: "mock-csv",
            name: "measurements.csv",
            path: "materials/measurements.csv",
          },
          versions: [],
          primaryMeta: "MOCK CSV",
          canImport: false,
          menuProps: menu,
          preview: () => record("preview-csv"),
          previewVersion: () => record("preview-version"),
          openImport: () => {},
        }),
      );
    case "ArtifactMenuItems":
    case "FileMenuItems":
      return el(
        UI.DropdownMenu,
        null,
        el(
          UI.DropdownMenuTrigger,
          { asChild: true },
          el(UI.Button, { variant: "secondary" }, `打开 ${name} 菜单`),
        ),
        el(
          UI.DropdownMenuContent,
          null,
          el(C[name], { ...menu, kind: "dropdown" }),
        ),
      );
    case "ArtifactDestination":
      return el(
        React.Fragment,
        null,
        el(UI.Button, { onClick: () => setOpen(true) }, "选择 MOCK 保存位置"),
        el(C.ArtifactDestination, {
          open,
          onOpenChange: setOpen,
          title: "MOCK 保存报告",
          description: "仅改变模拟状态，不创建文件、不入库",
          error: "",
          location,
          onLocationChange: setLocation,
          onSubmit: () => {
            log(`MOCK 保存 ${JSON.stringify(location)}`);
            setOpen(false);
          },
          projectName: "对话卡片实验室",
          saving: false,
          tree: [],
        }),
      );
    case "FileFormatIcon":
      return el(
        "div",
        { className: "flex flex-wrap items-center gap-[var(--vds-space-2)]" },
        ...[
          "pdf",
          "md",
          "csv",
          "xlsx",
          "docx",
          "png",
          "svg",
          "py",
          "json",
          "lean",
          "zip",
          "txt",
        ].map((ext) =>
          el(
            "span",
            {
              key: ext,
              className: "flex flex-wrap items-center gap-[var(--vds-space-2)]",
            },
            el(C.FileFormatIcon, { name: `mock.${ext}` }),
            ext,
          ),
        ),
      );
    default:
      throw Error(`Official export missing explicit demo: ${name}`);
  }
}
