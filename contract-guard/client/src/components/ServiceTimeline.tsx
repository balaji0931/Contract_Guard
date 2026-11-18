import { useState } from "react";
import { CheckCircle2, FileCode2, RefreshCw, Rocket, XCircle } from "lucide-react";
import { api } from "../api";
import { StatusBadge } from "./StatusBadge";
import type { PublishResult, ServiceSummary, VersionRow } from "../types";

interface Props {
  services: ServiceSummary[];
  versionsByService: Map<string, VersionRow[]>;
  selected: { service: string; version: string } | null;
  onSelect: (service: string, version: string) => void;
  onChanged: () => Promise<void> | void;
}

function fileLabel(sourceFile: string | null): string {
  if (sourceFile === null) return "?";
  return sourceFile.replace(/^specs\//, "").replace(/\.yaml$/, "");
}

export function ServiceTimeline({ services, versionsByService, selected, onSelect, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, PublishResult>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  async function republish(service: string, version: string) {
    const key = `${service}@${version}`;
    setBusy(key);
    setErrors((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    try {
      const result = await api.publish(service, version);
      setResults((prev) => new Map(prev).set(key, result));
      await onChanged();
    } catch (error) {
      setErrors((prev) => new Map(prev).set(key, (error as Error).message));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Service version timelines" className="grid gap-4 lg:grid-cols-3">
      {services.map((service) => {
        const versions = versionsByService.get(service.name) ?? [];
        return (
          <div
            key={service.name}
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{service.name}</h3>
                <p className="text-xs text-slate-500">
                  {service.owner ?? "no owner"} · latest published{" "}
                  <span className="font-medium text-emerald-300">
                    {service.latestPublished ?? "—"}
                  </span>
                </p>
              </div>
            </div>

            <ol className="mt-4 space-y-2">
              {versions.map((row) => {
                const key = `${service.name}@${row.version}`;
                const result = results.get(key);
                const isSelected =
                  selected?.service === service.name && selected?.version === row.version;
                return (
                  <li
                    key={`${row.id}`}
                    className={`rounded-lg border p-2.5 transition-colors ${
                      isSelected
                        ? "border-sky-500/60 bg-sky-500/10"
                        : "border-slate-800 bg-slate-950/50 hover:border-slate-700"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(service.name, row.version)}
                      className="flex w-full items-center justify-between gap-2 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <StatusBadge status={row.status} />
                        <span className="text-sm font-medium tabular-nums">{row.version}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <FileCode2 className="h-3.5 w-3.5 text-slate-600" aria-hidden />
                        <span className="text-[11px] text-slate-500">{fileLabel(row.source_file)}</span>
                      </span>
                    </button>

                    {row.reasonCodes.length > 0 && (
                      <p className="mt-1.5 truncate font-mono text-[11px] text-slate-400">
                        {row.reasonCodes.join(", ")}
                      </p>
                    )}

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        disabled={busy === key}
                        onClick={() => void republish(service.name, row.version)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-50"
                      >
                        {busy === key ? (
                          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <Rocket className="h-3 w-3" aria-hidden />
                        )}
                        re-publish
                      </button>
                      {result !== undefined && (
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                            result.outcome === "published"
                              ? "text-emerald-300"
                              : result.outcome === "blocked"
                                ? "text-rose-300"
                                : "text-amber-300"
                          }`}
                        >
                          {result.outcome === "published" ? (
                            <CheckCircle2 className="h-3 w-3" aria-hidden />
                          ) : (
                            <XCircle className="h-3 w-3" aria-hidden />
                          )}
                          {result.outcome}
                          {result.reasonCodes.length > 0 ? ` · ${result.reasonCodes[0]}` : ""}
                        </span>
                      )}
                      {errors.get(key) !== undefined && (
                        <span className="text-[11px] text-rose-300">{errors.get(key)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </section>
  );
}
