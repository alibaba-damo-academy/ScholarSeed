"""Product release metadata for outbound calls to the product gateway."""

import json
import os
import re
from collections.abc import Sequence
from urllib.parse import urlsplit

from service.inference.source import accepts_source

RELEASE_ENV = "SCHOLARSEED_CLIENT_RELEASE"
VERSION = re.compile(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}")
BUILD_NUMBER = re.compile(r"[0-9]{12}")
HEADERS = {
    "client_version": "X-ScholarSeed-Client-Version",
    "client_build_number": "X-ScholarSeed-Client-Build-Number",
    "client_channel": "X-ScholarSeed-Client-Channel",
}


def client_release_headers(endpoint: str, product_gateways: Sequence[str]) -> dict[str, str]:
    try:
        report = json.loads(os.environ.get(RELEASE_ENV, ""))
        if not isinstance(report, dict):
            return {}
        version, build, channel = (report.get(field, "") for field in HEADERS)
        if not all(isinstance(value, str) for value in (version, build, channel)):
            return {}
        if not VERSION.fullmatch(version) or not BUILD_NUMBER.fullmatch(build):
            return {}
        if accepts_source(endpoint, product_gateways):
            if report.get("production") is not True or channel not in ("preview", "release"):
                return {}
        else:
            test_gateway = urlsplit(report.get("test_gateway", ""))
            if (
                test_gateway.scheme not in ("http", "https")
                or not test_gateway.netloc
                or any(
                    test_gateway.hostname == urlsplit(base).hostname for base in product_gateways
                )
                or not accepts_source(endpoint, (test_gateway.geturl(),))
                or channel not in ("dev", "preview", "release")
            ):
                return {}
        return {header: report[field] for field, header in HEADERS.items()}
    except (TypeError, ValueError):
        return {}
