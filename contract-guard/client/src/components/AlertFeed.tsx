import { CheckCircle2, Clock, Send, XCircle } from "lucide-react";
import type { AlertRow } from "../types";

export function AlertFeed({ alerts }: { alerts: AlertRow[] }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60 shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-800 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Send className="h-4 w-4 text-sky-300" aria-hidden />
          Alert feed
        </h3>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          live · refreshes every 5 s
        </span>
      </div>

      <ul className="flex-1 divide-y divide-slate-800/70 overflow-auto">
        {alerts.length === 0 && (
          <li className="p-4 text-xs text-slate-500">No alerts delivered yet.</li>
        )}
        {alerts.map((alert) => (
          <li key={alert.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
            {alert.status === "sent" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            ) : alert.status === "failed" ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
            ) : (
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-slate-200">{alert.webhook_path}</p>
              <p className="text-[11px] text-slate-500">
                {alert.status} · {alert.attempts} attempt(s)
                {alert.http_status !== null ? ` · HTTP ${alert.http_status}` : ""}
                {alert.sent_at !== null ? ` · ${alert.sent_at.replace("T", " ").slice(0, 19)}Z` : ""}
                {alert.last_error !== null ? (
                  <span className="text-rose-300/80"> · {alert.last_error.slice(0, 80)}</span>
                ) : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
