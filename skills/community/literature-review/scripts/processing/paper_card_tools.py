#!/usr/bin/env scholarseed-skill-python
"""
Paper Processing CLI — Script-Driven (LLM calls inside script)

================================================================================
概述
================================================================================
批量处理论文，从 selected_paper.json + paper_info.json 中提取结构化论文卡片。
所有 LLM 调用在脚本内完成，上层 agent 仅做编排。

================================================================================
子命令
================================================================================
  list-pending <folder>       列出待处理论文数量
  run          <folder>       批量处理所有待处理论文
  stats        <folder>       输出处理统计

================================================================================
CLI 参数 (run 子命令)
================================================================================
  --provider PROVIDER             LLM provider (仅在 model_config.json 缺 processing stage 时生效)
  --model MODEL                   模型名 (仅在 model_config.json 缺 processing stage 时生效)
  --base-url URL                  base URL (仅在 model_config.json 缺 processing stage 时生效)
                                  API token 只从 SCHOLARSEED_ACCOUNT_TOKEN 读取，无 CLI 覆盖
  --thinking                      开启 thinking/reasoning 模式
  --concurrency N                 并发数 (default: 20)
  --relevance {L1,L2,L3}          覆盖所有论文的 relevance level
  --limit N                       只处理前 N 篇
  --with-delta                    开启 delta 提取 (默认关闭)
  --with-ideation                 开启 ideation claims 提取 (默认关闭)
  --with-source-map               开启 source_map 溯源 (默认开启)
    --no-source-map                 关闭 source_map 溯源
  --output-dir DIR                覆盖输出目录

================================================================================
输入文件 (<folder>/02_retrieval/)
================================================================================
  selected_paper.json   {paperId: {title, abstract, year, relevance_level, paper_type}}
  paper_info.json       {paperId: {info_type, sections, bib, ...}}
    - info_type: "origin_latex" | "origin_pdf" | "abstract"
    - sections: 带 #N 编号的字符串 (新格式) 或为空
    - bib: {bib_id: {title, author, year, venue}} (仅 origin_latex)

================================================================================
输出文件 (<folder>/03_process/)
================================================================================
  paper_cards.json            所有论文的结构化卡片 (始终产出)
  deltas.json                 论文间进展关系 (--with-delta 时产出)
  claims_for_ideation.json    idea 生成用 claims (--with-ideation 时产出)
  source_maps.json            溯源映射 (--with-source-map 时产出)
  processing_progress.json    实时进度

================================================================================
Per-Paper 处理流程
================================================================================
  Step 1: Classify      — 论文类型分类 (method/benchmark/survey/theory)
  Step 2: Prepare       — 根据 reading_depth 准备内容
  Step 3: Warmup        — KV Cache 预热 (sleep 3s)
  Step 4: Card+Common   — 合并提取卡片 + 通用字段 (+ optional source_map)
  Step 5: Delta         — 提取论文间进展 (--with-delta, method/theory + origin_latex)
  Step 6: Ideation      — 提取 idea claims (--with-ideation, method/theory)

================================================================================
Reading Depth 矩阵
================================================================================
  relevance_level | has_full_text=True              | has_full_text=False
  L1              | full                            | metadata_only
  L2              | partial (动态截断，见下)          | metadata_only
  L3              | metadata_only                   | metadata_only

  Partial 动态截断策略：
    ≤ 60k chars  → 不截断 (等同 full，覆盖 ~62% 论文)
    > 60k chars  → 取前 min(原文 × 70%, 80k chars)，按行边界截断

================================================================================
使用示例
================================================================================
  # 查看待处理数量
  scholarseed-skill-python paper_card_tools.py list-pending /path/to/workspace

  # 快速模式 — 只出 card (模型由 model_config.json 的 processing stage 决定)
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --concurrency 20

  # 深度模式 — 全部开启
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace \\
    --with-delta --with-ideation --with-source-map --relevance L1 --concurrency 20

  # 限制处理数量 + 单线程 (调试用)
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --limit 3 --concurrency 1

  # 指定所有论文为 L2 relevance (partial depth)
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --relevance L2

  # 只开 delta (提取论文间进展关系)
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --with-delta

  # 只开 ideation (提取 idea claims)
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --with-ideation

  # 开启 thinking/reasoning 模式
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --thinking

  # 指定输出目录
  scholarseed-skill-python paper_card_tools.py run /path/to/workspace --output-dir /tmp/output

  # 查看处理统计
  scholarseed-skill-python paper_card_tools.py stats /path/to/workspace
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import asyncio
import json
import os

from utils import _load_json, _resolve_folder, _resolve_input_dir, _resolve_output_dir
from run_pipeline import _run_async


# ============================================================================
# CMD: list-pending
# ============================================================================

def cmd_list_pending(args):
    """List pending papers (lightweight, no LLM)."""
    folder_path = _resolve_folder(args.folder)
    input_dir = _resolve_input_dir(folder_path)
    output_dir = _resolve_output_dir(args, folder_path)
    entity = _load_json(os.path.join(input_dir, "selected_paper.json"), {})
    cards = _load_json(os.path.join(output_dir, "paper_cards.json"), {})

    pending_count = 0
    for pid in entity:
        if pid not in cards:
            pending_count += 1
            if args.limit and pending_count >= args.limit:
                break

    actual_pending = sum(1 for pid in entity if pid not in cards)

    output = {
        "pending": actual_pending,
        "total": len(entity),
        "already_processed": len(cards),
    }
    if args.limit and actual_pending > args.limit:
        output["limited_to"] = args.limit

    print(json.dumps(output, ensure_ascii=False, indent=2))


# ============================================================================
# CMD: run
# ============================================================================

def cmd_run(args):
    """Entry point for the run subcommand."""
    asyncio.run(_run_async(args))


# ============================================================================
# CMD: stats
# ============================================================================

def cmd_stats(args):
    """Output processing statistics."""
    folder_path = _resolve_folder(args.folder)
    input_dir = _resolve_input_dir(folder_path)
    output_dir = _resolve_output_dir(args, folder_path)
    cards = _load_json(os.path.join(output_dir, "paper_cards.json"), {})
    entity = _load_json(os.path.join(input_dir, "selected_paper.json"), {})
    progress = _load_json(os.path.join(output_dir, "processing_progress.json"), {})

    type_dist = {}
    depth_dist = {}
    for card_data in cards.values():
        pt = card_data.get("paper_type", "unknown")
        type_dist[pt] = type_dist.get(pt, 0) + 1
        dp = card_data.get("reading_depth", "unknown")
        depth_dist[dp] = depth_dist.get(dp, 0) + 1

    output = {
        "total_entity": len(entity),
        "total_cards": len(cards),
        "pending": len(entity) - len(cards),
        "type_distribution": type_dist,
        "depth_distribution": depth_dist,
        "last_progress": progress,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


# ============================================================================
# CLI Entry Point
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="Paper Processing CLI (Script-Driven)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Common arguments helper
    def add_common_args(sp):
        sp.add_argument("folder", help="Folder name or relative path from project root")
        sp.add_argument("--output-dir", default=None, help="Override output directory (default: ./folder/03_process/)")

    # list-pending
    sp_list = subparsers.add_parser("list-pending", help="List pending paper count")
    add_common_args(sp_list)
    sp_list.add_argument("--limit", type=int, default=None, help="Limit display count")
    sp_list.set_defaults(func=cmd_list_pending)

    # run
    sp_run = subparsers.add_parser("run", help="Process all pending papers end-to-end")
    add_common_args(sp_run)
    sp_run.add_argument("--concurrency", type=int, default=20, help="LLM concurrent requests")
    sp_run.add_argument("--provider", default=None,
                        help="LLM provider (only used if model_config.json has no 'processing' stage)")
    sp_run.add_argument("--model", default=None,
                        help="LLM model name (only used if model_config.json has no 'processing' stage)")
    sp_run.add_argument("--base-url", default=None,
                        help="LLM API base URL (only used if model_config.json has no 'processing' stage)")
    sp_run.add_argument("--thinking", action="store_true", default=False,
                        help="Enable thinking/reasoning mode")
    sp_run.add_argument("--relevance", choices=["L1", "L2", "L3"], default=None,
                        help="Override relevance level for ALL papers")
    sp_run.add_argument("--limit", type=int, default=None, help="Only process first N pending papers")
    sp_run.add_argument("--with-source-map", action="store_true", default=True,
                        help="Enable source_map extraction (provenance tracking, default: on)")
    sp_run.add_argument("--no-source-map", action="store_false", dest="with_source_map",
                        help="Disable source_map extraction")
    sp_run.add_argument("--with-delta", action="store_true", default=False,
                        help="Enable delta extraction (default: off)")
    sp_run.add_argument("--with-ideation", action="store_true", default=False,
                        help="Enable ideation claims extraction (default: off)")
    sp_run.add_argument("--reclassify-type", action="store_true", default=False,
                        help="Ignore upstream paper_type and use LLM to reclassify (for fast mode)")
    sp_run.add_argument("--max-retries", type=int, default=5,
                        help="Outer validation retry count (card quality check)")
    sp_run.add_argument("--llm-retries", type=int, default=5,
                        help="Inner LLM call retry count (API/network/parse failures)")
    sp_run.set_defaults(func=cmd_run)

    # stats
    sp_stats = subparsers.add_parser("stats", help="Show processing statistics")
    add_common_args(sp_stats)
    sp_stats.set_defaults(func=cmd_stats)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
