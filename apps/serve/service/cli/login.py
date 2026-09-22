"""`scholarseed login` / `scholarseed logout` / `scholarseed whoami` — serve 简单认证的 CLI 客户端。

凭据存 ``~/.scholarseed/credentials.json`` (paths.CREDENTIALS_FILE, chmod 600):
  {"url": "...", "token": "...", "user_id": "...", "email": "..."}
脚本/CI 用 env ``SCHOLARSEED_AUTH_TOKEN`` 覆盖 (不落盘)。

用法:
  scholarseed login [--url http://127.0.0.1:8770] [--email a@b.c]    # 交互输密码
  scholarseed login --register                                        # 注册 (首个用户 bootstrap)
  scholarseed whoami
  scholarseed logout
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from typing import List, Optional

import httpx

from service.paths import CREDENTIALS_FILE

# dev 默认 (单机 serve); 产品部署经 --url / SCHOLARSEED_SERVE_URL 覆盖 (rerun-2 P2 归类)
DEFAULT_URL = os.environ.get("SCHOLARSEED_SERVE_URL", "http://127.0.0.1:8770")


def _load_creds() -> dict:
    try:
        return json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_creds(d: dict) -> None:
    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        CREDENTIALS_FILE.chmod(0o600)
    except OSError:
        pass


def login_main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="scholarseed login")
    ap.add_argument("--url", default="", help=f"serve base url (默认沿用上次 / {DEFAULT_URL})")
    ap.add_argument("--email", default="")
    ap.add_argument("--password", default="", help="不传则交互输入 (推荐)")
    ap.add_argument("--register", action="store_true", help="注册新用户 (无用户时 bootstrap)")
    args = ap.parse_args(argv)

    creds = _load_creds()
    url = (args.url or creds.get("url") or DEFAULT_URL).rstrip("/")
    email = (
        args.email or input(f"email [{creds.get('email', '')}]: ").strip() or creds.get("email", "")
    )
    if not email:
        print("email required", file=sys.stderr)
        return 2
    password = args.password or getpass.getpass("password: ")

    try:
        if args.register:
            headers = {}
            tok = os.environ.get("SCHOLARSEED_AUTH_TOKEN") or creds.get("token")
            if tok:
                headers["authorization"] = f"Bearer {tok}"
            r = httpx.post(
                f"{url}/api/auth/register",
                json={"email": email, "password": password},
                headers=headers,
                timeout=15,
            )
            if r.status_code != 200:
                print(f"register failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
                return 1
            print(f"registered: {r.json().get('email')} ({r.json().get('user_id')})")
        r = httpx.post(
            f"{url}/api/auth/login", json={"email": email, "password": password}, timeout=15
        )
    except httpx.HTTPError as e:
        print(f"cannot reach serve at {url}: {e}", file=sys.stderr)
        return 1
    if r.status_code != 200:
        print(f"login failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
        return 1
    out = r.json()
    _save_creds(
        {"url": url, "token": out["token"], "user_id": out["user_id"], "email": out["email"]}
    )
    print(f"logged in as {out['email']} ({out['user_id']}) @ {url}")
    print(f"token saved to {CREDENTIALS_FILE}")
    return 0


def logout_main(argv: Optional[List[str]] = None) -> int:
    creds = _load_creds()
    if creds.get("token") and creds.get("url"):
        try:
            httpx.post(
                f"{creds['url'].rstrip('/')}/api/auth/logout",
                headers={"authorization": f"Bearer {creds['token']}"},
                timeout=10,
            )
        except httpx.HTTPError:
            pass  # 服务端不可达也要清本地凭据
    try:
        CREDENTIALS_FILE.unlink()
    except OSError:
        pass
    print("logged out (local credentials cleared)")
    return 0


def whoami_main(argv: Optional[List[str]] = None) -> int:
    creds = _load_creds()
    tok = os.environ.get("SCHOLARSEED_AUTH_TOKEN") or creds.get("token")
    url = (creds.get("url") or DEFAULT_URL).rstrip("/")
    if not tok:
        print("not logged in (no credentials; run `scholarseed login`)")
        return 1
    try:
        r = httpx.get(f"{url}/api/auth/me", headers={"authorization": f"Bearer {tok}"}, timeout=10)
    except httpx.HTTPError as e:
        print(f"cannot reach serve at {url}: {e}", file=sys.stderr)
        return 1
    if r.status_code != 200:
        print(f"token invalid/expired ({r.status_code}); run `scholarseed login`")
        return 1
    out = r.json()
    print(
        f"{out.get('email') or out.get('user_id')} @ {url}"
        + ("" if out.get("auth") else "  (auth disabled on server)")
    )
    return 0


__all__ = ["login_main", "logout_main", "whoami_main"]
