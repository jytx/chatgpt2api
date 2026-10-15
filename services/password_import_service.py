"""账密批量导入服务。

解析号商常见的「邮箱----密码----TOTP密钥」凭据文本，逐个走密码登录
（含 TOTP 两步验证）换取 access_token 后写入号池，并提供进度查询。
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any

from services.account_service import account_service
from utils.log import logger

# 单个账号登录之间的间隔秒数，避免同 IP 连续登录触发风控限流
IMPORT_INTERVAL_SECONDS = 2.0
# 同时保留的进度记录上限，超出后优先清理已完成的旧记录
MAX_PROGRESS_RECORDS = 20

# 进度记录：progress_id -> {total, processed, added, skipped, failed, done, results}
_import_progress: dict[str, dict[str, Any]] = {}
_progress_lock = threading.Lock()

# 登录错误码 -> 用户可读提示
_ERROR_MESSAGES: dict[str, str] = {
    "need_totp_secret": "账号开启了两步验证，但该行未提供 TOTP 密钥",
    "mfa_verify_failed_400": "TOTP 动态码校验失败（密钥错误或已失效）",
    "mfa_verify_failed_403": "TOTP 动态码校验被拒绝，请稍后重试",
    "mfa_request_failed": "两步验证请求发送失败",
    "mfa_no_continue_url": "两步验证通过但未返回授权码",
    "need_verification_code": "触发邮箱验证码，无法自动登录",
    "invalid_password": "密码错误",
    "unsupported_country_region_territory": "地区受限，需要配置代理",
    "rate_limit_exceeded": "触发登录限流，稍后重试",
}


def parse_credential_text(text: str) -> tuple[list[dict[str, str]], int]:
    """解析账密文本，返回 (有效条目列表, 无效行数)。

    每行格式：`邮箱----密码----TOTP密钥`，其中 TOTP 密钥可选
    （账号未开启两步验证时可以只写 `邮箱----密码`）。
    """
    items: list[dict[str, str]] = []
    invalid_count = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split("----")]
        if len(parts) < 2 or "@" not in parts[0] or not parts[1]:
            invalid_count += 1
            continue
        items.append({
            "email": parts[0],
            "password": parts[1],
            "totp_secret": parts[2] if len(parts) >= 3 and parts[2] else "",
        })
    return items, invalid_count


def start_password_import(items: list[dict[str, str]]) -> str:
    """启动后台批量登录导入，返回进度 ID。"""
    progress_id = uuid.uuid4().hex
    _register_progress(progress_id, len(items))
    thread = threading.Thread(target=_run_import, args=(progress_id, items), daemon=True)
    thread.start()
    return progress_id


def get_password_import_progress(progress_id: str) -> dict[str, Any] | None:
    """查询导入进度；进度不存在时返回 None。"""
    with _progress_lock:
        progress = _import_progress.get(progress_id)
        return dict(progress) if progress else None


def _register_progress(progress_id: str, total: int) -> None:
    """登记一条新的导入进度，并清理超量的旧记录。"""
    with _progress_lock:
        while len(_import_progress) >= MAX_PROGRESS_RECORDS:
            evict_id = next(
                (key for key, value in _import_progress.items() if value.get("done")),
                next(iter(_import_progress)),
            )
            _import_progress.pop(evict_id, None)
        _import_progress[progress_id] = {
            "total": total,
            "processed": 0,
            "added": 0,
            "skipped": 0,
            "failed": 0,
            "done": False,
            "results": [],
        }


def _run_import(progress_id: str, items: list[dict[str, str]]) -> None:
    """后台线程主体：逐个登录账号并写入号池。"""
    for index, item in enumerate(items):
        if index > 0:
            time.sleep(IMPORT_INTERVAL_SECONDS)
        _import_single(progress_id, item)
    with _progress_lock:
        progress = _import_progress.get(progress_id)
        if progress is not None:
            progress["done"] = True


def _import_single(progress_id: str, item: dict[str, str]) -> None:
    """登录单个账号，成功后把凭据与 token 一起写入号池。"""
    email = item["email"]
    password = item["password"]
    totp_secret = item["totp_secret"]
    try:
        result = account_service._login_with_password(email, password, totp_secret)
    except Exception as exc:
        logger.exception("账密导入登录异常: %s", email)
        _append_result(progress_id, email, "失败", f"登录异常: {exc}")
        return

    if not result.get("ok"):
        error = _friendly_error(str(result.get("error") or "登录失败"))
        _append_result(progress_id, email, "失败", error)
        return

    add_result = account_service.add_account_items([{
        "access_token": str(result.get("access_token") or ""),
        "refresh_token": str(result.get("refresh_token") or ""),
        "id_token": str(result.get("id_token") or ""),
        "email": str(result.get("email") or email),
        "password": password,
        "totp_secret": totp_secret,
        "source_type": "password",
    }])
    added = int(add_result.get("added") or 0)
    if added > 0:
        _append_result(progress_id, email, "成功", "")
    else:
        _append_result(progress_id, email, "重复", "号池已存在该账号，凭据已合并更新")


def _friendly_error(error: str) -> str:
    """把登录错误码翻译成用户可读提示；未知错误原样返回。"""
    return _ERROR_MESSAGES.get(error, error)


def _append_result(progress_id: str, email: str, status: str, error: str) -> None:
    """记录单个账号的处理结果并累加统计。"""
    with _progress_lock:
        progress = _import_progress.get(progress_id)
        if progress is None:
            return
        progress["processed"] += 1
        progress["results"].append({"email": email, "status": status, "error": error})
        if status == "成功":
            progress["added"] += 1
        elif status == "重复":
            progress["skipped"] += 1
        else:
            progress["failed"] += 1
