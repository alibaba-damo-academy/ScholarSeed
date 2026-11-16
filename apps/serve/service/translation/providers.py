from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from typing import Callable
from urllib.parse import quote, urlencode

import httpx

from service.translation.policy import (
    MICROSOFT_CHARACTERS_PER_SECOND,
    RETRY_LIMIT,
    RateLimited,
    RequestPolicy,
    RetryReport,
    Scheduler,
    TranslationFailure,
    retry_after,
)
from service.translation.utils import response_text

LANGUAGES = frozenset({"zh-CN", "en", "ja", "fr", "de", "es", "ko", "ru", "ar", "pt", "it", "nl"})
MAX_TEXT_CHARS = 20000
CHUNK_CHARS = 1000
MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_TIMEOUT = 30.0
FIELD_LIMIT = 2048
REGION_PATTERN = re.compile(r"[a-z][a-z0-9-]{1,63}")
JSON_CONTENT_TYPE = "application/json"
PROBE_TEXT = "Hello"
PROBE_SOURCE = "en"
PROBE_TARGET = "zh-CN"


@dataclass(frozen=True)
class Provider:
    fields: tuple[str, ...]
    request: Callable[[dict[str, str], str, str, str], httpx.Request]
    result: Callable[[object], str]
    languages: dict[str, str]
    policy: RequestPolicy = RequestPolicy()
    error_path: tuple[str, ...] = ()
    errors: tuple[tuple[str, str], ...] = ()
    cooldowns: tuple[tuple[str, float], ...] = ()
    public_fields: tuple[str, ...] = ()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def signed(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def deepl(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    endpoint = (
        "https://api-free.deepl.com/v2/translate"
        if fields["apiKey"].endswith(":fx")
        else "https://api.deepl.com/v2/translate"
    )
    body = {"text": [text], "target_lang": target}
    if source != "auto":
        body["source_lang"] = source
    return httpx.Request(
        "POST", endpoint, json=body, headers={"Authorization": "DeepL-Auth-Key " + fields["apiKey"]}
    )


def youdao(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    salt, timestamp = uuid.uuid4().hex, str(int(time.time()))
    input_text = text if len(text) <= 20 else text[:10] + str(len(text)) + text[-10:]
    signature = digest(fields["appId"] + input_text + salt + timestamp + fields["appSecret"])
    return httpx.Request(
        "POST",
        "https://openapi.youdao.com/api",
        data={
            "q": text,
            "from": source,
            "to": target,
            "appKey": fields["appId"],
            "salt": salt,
            "curtime": timestamp,
            "signType": "v3",
            "sign": signature,
            "strict": "true",
        },
    )


def baidu(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    salt = uuid.uuid4().hex
    signature = hashlib.md5(
        (fields["appId"] + text + salt + fields["appSecret"]).encode(), usedforsecurity=False
    ).hexdigest()
    return httpx.Request(
        "POST",
        "https://fanyi-api.baidu.com/api/trans/vip/translate",
        data={
            "q": text,
            "from": source,
            "to": target,
            "appid": fields["appId"],
            "salt": salt,
            "sign": signature,
        },
    )


def google(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    body = {"q": text, "target": target, "format": "text"}
    if source != "auto":
        body["source"] = source
    return httpx.Request(
        "POST",
        "https://translation.googleapis.com/language/translate/v2",
        json=body,
        headers={"X-Goog-Api-Key": fields["apiKey"]},
    )


def microsoft(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    parameters = {"api-version": "3.0", "to": target}
    if source != "auto":
        parameters["from"] = source
    return httpx.Request(
        "POST",
        "https://api.cognitive.microsofttranslator.com/translate",
        params=parameters,
        json=[{"Text": text}],
        headers={
            "Ocp-Apim-Subscription-Key": fields["apiKey"],
            "Ocp-Apim-Subscription-Region": fields["region"],
        },
    )


def tencent(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    host, service, action = "tmt.tencentcloudapi.com", "tmt", "TextTranslate"
    now = datetime.now(timezone.utc)
    timestamp, date = str(int(now.timestamp())), now.strftime("%Y-%m-%d")
    body = json.dumps(
        {"SourceText": text, "Source": source, "Target": target, "ProjectId": 0},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    signed_headers = "content-type;host;x-tc-action"
    canonical = f"POST\n/\n\ncontent-type:{JSON_CONTENT_TYPE}\nhost:{host}\nx-tc-action:{action.lower()}\n\n{signed_headers}\n{digest(body)}"
    scope = f"{date}/{service}/tc3_request"
    key = signed(
        signed(signed(("TC3" + fields["secretKey"]).encode(), date), service), "tc3_request"
    )
    signature = signed(key, f"TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{digest(canonical)}").hex()
    headers = {
        "Content-Type": JSON_CONTENT_TYPE,
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Version": "2018-03-21",
        "X-TC-Timestamp": timestamp,
        "X-TC-Region": fields["region"],
        "Authorization": f"TC3-HMAC-SHA256 Credential={fields['secretId']}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
    }
    return httpx.Request("POST", f"https://{host}/", content=body.encode(), headers=headers)


def aliyun(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    parameters = {
        "Action": "TranslateGeneral",
        "Version": "2018-10-12",
        "Format": "JSON",
        "AccessKeyId": fields["accessKeyId"],
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": uuid.uuid4().hex,
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "RegionId": fields["region"],
        "FormatType": "text",
        "SourceLanguage": source,
        "TargetLanguage": target,
        "SourceText": text,
        "Scene": "general",
    }
    canonical = urlencode(sorted(parameters.items()), quote_via=quote, safe="~")
    message = "POST&%2F&" + quote(canonical, safe="~")
    parameters["Signature"] = base64.b64encode(
        hmac.new(
            (fields["accessKeySecret"] + "&").encode(), message.encode(), hashlib.sha1
        ).digest()
    ).decode()
    return httpx.Request("POST", "https://mt.aliyuncs.com/", data=parameters)


def volcengine(fields: dict[str, str], text: str, source: str, target: str) -> httpx.Request:
    host, service = "translate.volcengineapi.com", "translate"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    body_values = {"TargetLanguage": target, "TextList": [text]}
    if source != "auto":
        body_values["SourceLanguage"] = source
    body = json.dumps(body_values, ensure_ascii=False, separators=(",", ":"))
    query = "Action=TranslateText&Version=2020-06-01"
    headers = {
        "Content-Type": JSON_CONTENT_TYPE,
        "Host": host,
        "X-Date": timestamp,
        "X-Content-Sha256": digest(body),
    }
    canonical_headers = {name.lower(): value for name, value in headers.items()}
    signed_headers = ";".join(sorted(canonical_headers))
    canonical = "\n".join(
        [
            "POST",
            "/",
            query,
            "".join(f"{name}:{canonical_headers[name]}\n" for name in sorted(canonical_headers)),
            signed_headers,
            digest(body),
        ]
    )
    scope = f"{timestamp[:8]}/{fields['region']}/{service}/request"
    key = fields["accessKeySecret"].encode()
    for component in (timestamp[:8], fields["region"], service, "request"):
        key = signed(key, component)
    signature = signed(key, f"HMAC-SHA256\n{timestamp}\n{scope}\n{digest(canonical)}").hex()
    headers["Authorization"] = (
        f"HMAC-SHA256 Credential={fields['accessKeyId']}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
    return httpx.Request("POST", f"https://{host}/?{query}", content=body.encode(), headers=headers)


def youdao_result(body: object) -> str:
    if not isinstance(body, dict):
        raise TranslationFailure("invalid_response")
    if body.get("errorCode") != "0":
        raise TranslationFailure("provider_rejected")
    items = body.get("translation")
    if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
        raise TranslationFailure("invalid_response")
    return "\n".join(items)


def baidu_result(body: object) -> str:
    if not isinstance(body, dict):
        raise TranslationFailure("invalid_response")
    if body.get("error_code"):
        raise TranslationFailure("provider_rejected")
    items = body.get("trans_result")
    if not isinstance(items, list):
        raise TranslationFailure("invalid_response")
    return "\n".join(response_text(item, ("dst",)) for item in items)


def aliyun_result(body: object) -> str:
    if not isinstance(body, dict):
        raise TranslationFailure("invalid_response")
    if str(body.get("Code")) != "200":
        raise TranslationFailure("provider_rejected")
    return response_text(body, ("Data", "Translated"))


PROVIDERS = {
    "deepl": Provider(
        ("apiKey",),
        deepl,
        lambda body: response_text(body, ("translations", 0, "text")),
        {language: language.upper() for language in LANGUAGES} | {"zh-CN": "ZH"},
    ),
    "youdao": Provider(
        ("appId", "appSecret"),
        youdao,
        youdao_result,
        {"zh-CN": "zh-CHS"},
        public_fields=("appId",),
        error_path=("errorCode",),
        errors=(
            ("411", "rate_limited"),
            ("412", "rate_limited"),
            ("401", "quota"),
            ("202", "authentication"),
        ),
    ),
    "baidu": Provider(
        ("appId", "appSecret"),
        baidu,
        baidu_result,
        {"zh-CN": "zh", "ja": "jp", "fr": "fra", "es": "spa", "ko": "kor", "ar": "ara"},
        public_fields=("appId",),
        error_path=("error_code",),
        errors=(
            ("54003", "rate_limited"),
            ("54005", "rate_limited"),
            ("54004", "quota"),
            ("54001", "authentication"),
        ),
        cooldowns=(("54005", 3.0),),
    ),
    "tencent": Provider(
        ("secretId", "secretKey", "region"),
        tencent,
        lambda body: response_text(body, ("Response", "TargetText")),
        {"zh-CN": "zh"},
        public_fields=("region",),
        error_path=("Response", "Error", "Code"),
        errors=(("RequestLimitExceeded", "rate_limited"),),
    ),
    "aliyun": Provider(
        ("accessKeyId", "accessKeySecret", "region"),
        aliyun,
        aliyun_result,
        {"zh-CN": "zh"},
        public_fields=("region",),
        error_path=("Code",),
        errors=(
            ("Throttling", "rate_limited"),
            ("Throttling.User", "rate_limited"),
            ("Throttling.Api", "rate_limited"),
            ("Throttling.System", "rate_limited"),
        ),
    ),
    "volcengine": Provider(
        ("accessKeyId", "accessKeySecret", "region"),
        volcengine,
        lambda body: response_text(body, ("TranslationList", 0, "Translation")),
        {"zh-CN": "zh"},
        public_fields=("region",),
        error_path=("ResponseMetadata", "Error", "Code"),
        errors=(
            ("-429", "rate_limited"),
            ("Throttling", "rate_limited"),
            ("RequestLimitExceeded", "rate_limited"),
        ),
    ),
    "google": Provider(
        ("apiKey",),
        google,
        lambda body: html.unescape(
            response_text(body, ("data", "translations", 0, "translatedText"))
        ),
        {},
        error_path=("error", "errors"),
        errors=(
            ("rateLimitExceeded", "rate_limited"),
            ("userRateLimitExceeded", "rate_limited"),
            ("dailyLimitExceeded", "quota"),
        ),
    ),
    "microsoft": Provider(
        ("apiKey", "region"),
        microsoft,
        lambda body: response_text(body, (0, "translations", 0, "text")),
        {"zh-CN": "zh-Hans"},
        public_fields=("region",),
        policy=RequestPolicy(characters_per_second=MICROSOFT_CHARACTERS_PER_SECOND),
    ),
}


def validate_fields(provider: str, fields: dict[str, str]) -> dict[str, str]:
    definition = PROVIDERS.get(provider)
    if not definition or set(fields) != set(definition.fields):
        raise TranslationFailure("required")
    cleaned = {}
    for name, value in fields.items():
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > FIELD_LIMIT
            or any(ord(character) < 32 for character in value)
        ):
            raise TranslationFailure("required")
        cleaned[name] = value.strip()
    if "region" in cleaned and not REGION_PATTERN.fullmatch(cleaned["region"]):
        raise TranslationFailure("region")
    return cleaned


class Translator:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        scheduler: Scheduler | None = None,
    ):
        self.transport = transport
        self.scheduler = scheduler or Scheduler()

    async def translate(
        self,
        provider: str,
        fields: dict[str, str],
        text: str,
        source: str,
        target: str,
        *,
        report: RetryReport | None = None,
    ) -> str:
        fields = validate_fields(provider, fields)
        if not text.strip():
            raise TranslationFailure("empty_text")
        if len(text) > MAX_TEXT_CHARS:
            raise TranslationFailure("text_too_long")
        if target not in LANGUAGES or source not in LANGUAGES | {"auto"} or source == target:
            raise TranslationFailure("direction")
        translated = []
        report = report or RetryReport()
        remaining = text
        while remaining:
            boundary = min(CHUNK_CHARS, len(remaining))
            if boundary < len(remaining):
                separator = max(
                    remaining.rfind("\n", 0, boundary), remaining.rfind(" ", 0, boundary)
                )
                if separator > 0:
                    boundary = separator + 1
            part, remaining = remaining[:boundary], remaining[boundary:]
            if part.strip():
                while True:
                    try:
                        translated.append(
                            await self.scheduler.run(
                                provider,
                                PROVIDERS[provider].policy,
                                len(part),
                                report.retries,
                                partial(self._translate, provider, fields, part, source, target),
                            )
                        )
                        report.limited = False
                        break
                    except RateLimited:
                        report.limited = True
                        if report.retries >= RETRY_LIMIT:
                            raise TranslationFailure("rate_limited") from None
                        report.retries += 1
        return "\n".join(translated)

    async def _translate(
        self, provider: str, fields: dict[str, str], text: str, source: str, target: str
    ) -> str:
        definition = PROVIDERS[provider]
        request = definition.request(
            fields,
            text,
            definition.languages.get(source, source),
            definition.languages.get(target, target),
        )
        try:
            async with httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT, follow_redirects=False, transport=self.transport
            ) as client:
                response = await client.send(request, stream=True)
                try:
                    if response.status_code == 429:
                        raise RateLimited(retry_after(response.headers.get("Retry-After")))
                    if response.status_code == 456:
                        raise TranslationFailure("quota")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_RESPONSE_BYTES:
                            raise TranslationFailure("invalid_response")
                    try:
                        body = json.loads(content)
                    except (UnicodeError, json.JSONDecodeError):
                        if response.status_code in {401, 403}:
                            raise TranslationFailure("authentication") from None
                        raise TranslationFailure("invalid_response") from None
                    error_value = body
                    for name in definition.error_path:
                        error_value = (
                            error_value.get(name) if isinstance(error_value, dict) else None
                        )
                    codes = (
                        [str(item.get("reason")) for item in error_value if isinstance(item, dict)]
                        if isinstance(error_value, list)
                        else [str(error_value)]
                    )
                    mapped = next(
                        (
                            kind
                            for code in codes
                            for prefix, kind in definition.errors
                            if code == prefix or code.startswith(prefix + ".")
                        ),
                        None,
                    )
                    if mapped == "rate_limited":
                        cooldown = max(
                            (delay for code, delay in definition.cooldowns if code in codes),
                            default=0.0,
                        )
                        raise RateLimited(
                            max(cooldown, retry_after(response.headers.get("Retry-After")))
                        )
                    if mapped:
                        raise TranslationFailure(mapped)
                    if response.status_code in {401, 403}:
                        raise TranslationFailure("authentication")
                    if response.status_code != 200:
                        raise TranslationFailure("provider_rejected")
                    result = definition.result(body)
                    if not isinstance(result, str) or not result.strip():
                        raise TranslationFailure("invalid_response")
                    return result
                finally:
                    await response.aclose()
        except httpx.TimeoutException:
            raise TranslationFailure("timeout") from None
        except httpx.HTTPError:
            raise TranslationFailure("network") from None
        except (KeyError, IndexError, TypeError, UnicodeError, json.JSONDecodeError):
            raise TranslationFailure("invalid_response") from None
