// 产品代码布局探针脚本的单一来源：bundle.cjs（构建期冻结证据）与 verify.cjs（包内验证）
// 共用同一份文本，避免两侧漂移。语义见脚本内注释。
// 产品代码布局探针。两种布局共用一份脚本：
// - 传统（macOS / 旧 win32）：产品包 pip 安装进 site-packages，全部模块都必须在 purelib 根下。
// - 组件化（win32, proposal 108 §7）：第三方依赖在组件 site-packages（purelib 根），产品代码在
//   backend/pylibs，经 SCHOLARSEED_PRODUCT_LIBS 注入 sys.path —— 6 个产品模块必须落在 pylibs 下，
//   且 purelib 根不得残留任何产品发行物（组件内容只随第三方锁变化，这是命中语义的前提）。
const RUNTIME_PROBE_SCRIPT = `
import importlib, json, os, pathlib, sysconfig
names = ("scholarseed_runtime", "damoatrace", "service.cli.serve", "service.cli.browser", "scholarseed_codex")
root = pathlib.Path(sysconfig.get_path("purelib")).resolve()
product_libs = os.environ.get("SCHOLARSEED_PRODUCT_LIBS", "")
resolved = {name: str(pathlib.Path(importlib.import_module(name).__file__).resolve()) for name in names}
assert all(
    pathlib.Path(filename).is_relative_to(root)
    or (product_libs and pathlib.Path(filename).is_relative_to(pathlib.Path(product_libs).resolve()))
    for filename in resolved.values()
)
if product_libs:
    libs = pathlib.Path(product_libs).resolve()
    assert all(pathlib.Path(filename).is_relative_to(libs) for filename in resolved.values())
    product_markers = ("service", "scholarseed_runtime", "damoatrace", "scholarseed_codex")
    assert not any((root / marker).exists() for marker in product_markers), "product code leaked into the component tree"
    assert not list(root.glob("scholarseed*-*.dist-info")) and not list(root.glob("damoatrace-*.dist-info"))
assert not list(root.glob("__editable__*")) and not list(root.glob("*.egg-link"))
assert not any(
    json.loads(item.read_text()).get("dir_info", {}).get("editable") is True
    for item in root.glob("*.dist-info/direct_url.json")
), "editable install residue in site-packages"
print(json.dumps({"site_packages": str(root), "product_libs": product_libs or None, "modules": resolved}, sort_keys=True))
`.trim()

module.exports = { RUNTIME_PROBE_SCRIPT }
