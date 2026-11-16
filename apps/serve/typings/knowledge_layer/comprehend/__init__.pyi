from dataclasses import dataclass
from typing import Protocol

VERSION: str
PROMPT_VERSION: str

@dataclass(frozen=True)
class ExtractionOptions:
  validation_attempts: int = ...
  llm_attempts: int = ...
  timeout: float | None = ...
  output_language: str = ...
  supports_cache_prefix: bool = ...

@dataclass(frozen=True)
class SourceImage:
  number: int
  label: str
  media_type: str
  data: str

class _ExtractionClient(Protocol):
  async def chat(
    self,
    system: str,
    user: str,
    *,
    max_tokens: int | None = ...,
    json_mode: bool = ...,
    cache_prefix: str | None = ...,
    temperature: float | None = ...,
    images: tuple[SourceImage, ...] = ...,
    prompt_version: str = ...,
  ) -> tuple[str, dict]: ...

async def process_single_doc(
  llm: _ExtractionClient,
  doc_id: str,
  doc: dict,
  depth: str,
  with_source_map: bool,
  reclassify: bool,
  stop: None,
  usage_out: dict,
  fmt: None = ...,
  registry_ctx: str = ...,
  type_log: list | None = ...,
  *,
  options: ExtractionOptions = ...,
  images: tuple[SourceImage, ...] = ...,
) -> tuple[dict, dict | None]: ...
