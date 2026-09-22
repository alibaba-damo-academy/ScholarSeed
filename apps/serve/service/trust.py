"""trust.py — 出站 TLS 信任库，与操作系统对齐。

Python 默认拿 certifi 内置的根证书验签，而企业出口代理做 TLS 中间人时注入的根
只装在 OS 信任库里，certifi 永远不含它。于是同一台机器上浏览器与 curl 一切正常，
产品进程的每一条出站 HTTPS 却都验签失败 —— 而且失败发生在握手阶段，与业务无关，
从错误信息上看不出是信任问题。产品不自建第二套信任策略，改为采用平台的那一套。

truststore 在各目标平台原生解析 OS 信任库：

- macOS：Security.framework 信任设置，含安装器写入系统钥匙串的根。
- Windows：Windows 证书库，含组策略下发的根。
- Linux：OpenSSL 默认路径，即发行版 CA bundle。

certifi 的 bundle 仍会载入同一个 context，两侧取并集而非替换：任一侧信任的主机
继续可验，故脱离企业代理的环境行为不变。
"""

from __future__ import annotations

import truststore


def apply_system_trust_store() -> None:
    """让此后创建的每个 ``ssl`` context 都走 OS 信任库。

    注入方式是替换 ``ssl.SSLContext``，因此必须在第一条出站 TLS 连接之前调用，
    而不是等到失败再补救；重复调用只是重新赋同一个值。
    """
    truststore.inject_into_ssl()


__all__ = ["apply_system_trust_store"]
