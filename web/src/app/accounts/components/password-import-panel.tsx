"use client";

// 账密批量导入面板：粘贴「邮箱----密码----TOTP密钥」凭据文本，
// 后端逐个走密码登录（含 TOTP 两步验证）换取 token 入池，前端轮询展示每个账号的结果。
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchAccounts,
  fetchPasswordImportProgress,
  startPasswordImport,
  type Account,
  type PasswordImportProgress,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 2000;

type PasswordImportPanelProps = {
  disabled: boolean;
  onImported: (items: Account[]) => void;
};

/** 解析预览：统计有效凭据行数（规则与后端 parse_credential_text 保持一致）。 */
function countCredentialLines(value: string): number {
  return value.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    const parts = trimmed.split("----");
    return parts.length >= 2 && parts[0].includes("@") && parts[1].trim() !== "";
  }).length;
}

function resultStatusClass(status: string) {
  if (status === "成功") {
    return "text-emerald-600";
  }
  if (status === "重复") {
    return "text-amber-600";
  }
  return "text-red-600";
}

export function PasswordImportPanel({ disabled, onImported }: PasswordImportPanelProps) {
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<PasswordImportProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载时停止轮询（后台导入不受影响，会继续执行）
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // 导入完成：停轮询、总结提示、拉取最新账号列表通知父级刷新
  const finishImport = (finalProgress: PasswordImportProgress) => {
    stopPolling();
    setIsSubmitting(false);
    const summary = `账密导入完成：成功 ${finalProgress.added} 个，重复 ${finalProgress.skipped} 个，失败 ${finalProgress.failed} 个`;
    if (finalProgress.failed > 0) {
      toast.warning(summary);
    } else {
      toast.success(summary);
    }
    fetchAccounts()
      .then((data) => onImported(data.items))
      .catch(() => {
        // 列表刷新失败不影响导入结果，用户可手动刷新
      });
  };

  const pollProgress = (progressId: string) => {
    pollRef.current = setInterval(() => {
      fetchPasswordImportProgress(progressId)
        .then((data) => {
          setProgress(data);
          if (data.done) {
            finishImport(data);
          }
        })
        .catch(() => {
          // 单次轮询失败（如网络抖动）不终止流程，等待下一轮
        });
    }, POLL_INTERVAL_MS);
  };

  const handleSubmit = async () => {
    if (countCredentialLines(input) === 0) {
      toast.error("请先粘贴至少一行有效凭据（邮箱----密码----TOTP密钥）");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await startPasswordImport(input);
      setProgress({
        total: data.total,
        processed: 0,
        added: 0,
        skipped: 0,
        failed: 0,
        done: false,
        results: [],
      });
      toast.success(
        `已开始后台导入 ${data.total} 个账号${data.invalid_count > 0 ? `，忽略 ${data.invalid_count} 行无效格式` : ""}`,
      );
      pollProgress(data.progress_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动账密导入失败";
      toast.error(message);
      setIsSubmitting(false);
    }
  };

  const credentialCount = countCredentialLines(input);
  const importing = isSubmitting && progress !== null && !progress.done;
  const isDone = progress !== null && progress.done;

  return (
    <div className="space-y-4">
      {!isDone ? (
        <>
          <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-600">
            每行一条：{" "}
            <code className="rounded bg-stone-200 px-1">邮箱----密码----TOTP密钥</code>
            （账号未开启两步验证时，TOTP 密钥可省略）。导入在后台逐个登录，期间请勿关闭本页面；
            意外关闭也不会中断导入，账号仍会入池。
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            <div className="font-medium">风险提示</div>
            <div>
              批量登录建议配置可用代理并控制数量，避免同 IP 连续登录触发风控限流；导入的凭据
              （密码、TOTP 密钥）会保存在本地号池中，用于 token 过期后自动重新登录。
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-stone-700">账密凭据列表</label>
              <span className="text-xs text-stone-400">当前识别 {credentialCount} 个账号</span>
            </div>
            <Textarea
              placeholder={"user1@icloud.com----password1----TOTPSECRET32BASE32\nuser2@icloud.com----password2"}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={importing}
              className="min-h-40 resize-none rounded-xl border-stone-200 font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
            onClick={() => void handleSubmit()}
            disabled={disabled || importing || credentialCount === 0}
          >
            {importing ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {importing ? "导入中..." : "开始批量导入"}
          </Button>
        </>
      ) : null}

      {progress ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-stone-700">
              进度 {progress.processed}/{progress.total}
              {isDone ? "（已完成）" : ""}
            </span>
            <span className="text-xs text-stone-400">
              成功 {progress.added} · 重复 {progress.skipped} · 失败 {progress.failed}
            </span>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-stone-200 bg-white p-3">
            {progress.results.map((item, index) => (
              <div key={`${item.email}-${index}`} className="flex items-start justify-between gap-3 text-xs leading-5">
                <span className="break-all font-mono text-stone-700">{item.email}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {item.error ? <span className="text-stone-400">{item.error}</span> : null}
                  <span className={cn("font-medium", resultStatusClass(item.status))}>{item.status}</span>
                </span>
              </div>
            ))}
            {!progress.results.length ? (
              <div className="py-2 text-center text-xs text-stone-400">正在登录第一个账号...</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
