import { useEffect, useState } from "react";
import { Loader2, MousePointerClick, Users } from "lucide-react";
import { api } from "../api";
import type { ImpactReport } from "../types";

interface Props {
  selected: { service: string; version: string } | null;
}

export function ImpactInspector({ selected }: Props) {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selected === null) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .impact(selected.service, selected.version)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60 shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-800 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-amber-300" aria-hidden />
          Impact inspector
        </h3>
        {selected !== null && (
          <span className="ml-auto rounded-full bg-slate-800 px-2.5 py-0.5 font-mono text-[11px] text-slate-300">
            {selected.service} @ {selected.version}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {selected === null && (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-slate-500">
            <MousePointerClick className="h-6 w-6" aria-hidden />
            <p className="text-xs">Pick a version in the timeline or a findings row to see who it breaks.</p>
          </div>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> loading impact…
          </div>
        )}
        {error !== null && <p className="text-xs text-rose-300">impact request failed: {error}</p>}

        {report !== null && !loading && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">statuses:</span>
              {[...new Set(report.statuses)].map((status) => (
                <span key={status} className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">
                  {status}
                </span>
              ))}
              {report.reasonCodes.map((code) => (
                <span
                  key={code}
                  className="rounded-full bg-rose-500/10 px-2 py-0.5 font-mono text-[11px] text-rose-300 ring-1 ring-inset ring-rose-400/30"
                >
                  {code}
                </span>
              ))}
            </div>

            {report.impactedConsumers.length === 0 ? (
              <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-300">
                No known consumer is exposed by this version.
              </p>
            ) : (
              report.impactedConsumers.map((consumer) => (
                <div key={consumer.consumer} className="rounded-lg border border-slate-800 bg-slate-950/50">
                  <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                    <span className="text-xs font-semibold text-slate-100">{consumer.consumer}</span>
                    <span className="text-[11px] text-slate-500">{consumer.team ?? "no team"}</span>
                    <span className="ml-auto rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300 ring-1 ring-inset ring-rose-400/30">
                      {consumer.issues.length} issue(s)
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-800/70">
                    {consumer.issues.map((issue, index) => (
                      <li key={index} className="px-3 py-2 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-slate-200">{issue.code}</span>
                          {issue.operation_ref !== null && (
                            <span className="font-mono text-slate-500">{issue.operation_ref}</span>
                          )}
                          {issue.field_path !== null && (
                            <span className="font-mono text-sky-300/80">{issue.field_path}</span>
                          )}
                        </div>
                        <p className="mt-1 text-slate-400">{issue.message}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
