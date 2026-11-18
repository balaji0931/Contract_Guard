import { Activity, AlertTriangle, Ban, Send, Users, WifiOff } from "lucide-react";
import type { AlertRow, ConsumerSummary, ServiceSummary, VersionRow } from "../types";

interface Props {
  services: ServiceSummary[];
  versions: VersionRow[];
  consumers: ConsumerSummary[];
  alerts: AlertRow[];
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "text-slate-100",
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400">
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </div>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function StatsOverview({ services, versions, consumers, alerts }: Props) {
  const blocked = versions.filter((v) => v.status === "blocked").length;
  const exposed = consumers.filter((c) => c.openIssues > 0).length;
  const failedAlerts = alerts.filter((a) => a.status === "failed").length;
  const pendingAlerts = alerts.filter((a) => a.status === "pending").length;
  const alertTone =
    failedAlerts > 0 || pendingAlerts > 0 ? "text-rose-300" : "text-emerald-300";

  return (
    <section
      aria-label="Stats overview"
      className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5"
    >
      <Stat icon={Activity} label="Services" value={services.length} hint="providers registered" />
      <Stat
        icon={Users}
        label="Exposed consumers"
        value={exposed}
        hint={`${consumers.length} tracked`}
        tone={exposed > 0 ? "text-amber-300" : "text-emerald-300"}
      />
      <Stat
        icon={Ban}
        label="Blocked versions"
        value={blocked}
        hint={`${versions.length} intakes decided`}
        tone={blocked > 0 ? "text-rose-300" : "text-emerald-300"}
      />
      <Stat
        icon={AlertTriangle}
        label="Open consumer issues"
        value={consumers.reduce((sum, c) => sum + c.openIssues, 0)}
        hint="attributed findings"
        tone={
          consumers.some((c) => c.openIssues > 0) ? "text-amber-300" : "text-emerald-300"
        }
      />
      <Stat
        icon={failedAlerts + pendingAlerts > 0 ? WifiOff : Send}
        label="Alerts"
        value={failedAlerts > 0 ? `${failedAlerts} failed` : pendingAlerts > 0 ? `${pendingAlerts} pending` : "healthy"}
        hint={`${alerts.length} recent deliveries`}
        tone={alertTone}
      />
    </section>
  );
}
