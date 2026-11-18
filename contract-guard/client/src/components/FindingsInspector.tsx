import { useMemo, useState } from "react";
import { Search, ShieldAlert } from "lucide-react";
import type { Finding } from "../types";

interface Props {
  findings: Finding[];
  services: string[];
  onSelect: (service: string, version: string) => void;
}

const SEVERITY_STYLE: Record<string, string> = {
  blocking: "bg-rose-500/15 text-rose-300 ring-rose-400/30",
  warning: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
  intake_reject: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
};

export function FindingsInspector({ findings, services, onSelect }: Props) {
  const [serviceFilter, setServiceFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () =>
      findings.filter((finding) => {
        if (serviceFilter !== "" && finding.service !== serviceFilter) return false;
        if (severityFilter !== "" && finding.severity !== severityFilter) return false;
        if (
          query !== "" &&
          !`${finding.code} ${finding.operation_ref ?? ""} ${finding.field_path ?? ""} ${finding.consumer ?? ""} ${finding.message}`
            .toLowerCase()
            .includes(query.toLowerCase())
        )
          return false;
        return true;
      }),
    [findings, serviceFilter, severityFilter, query],
  );

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-rose-300" aria-hidden />
          Findings
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
            {filtered.length}
          </span>
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search code, field, consumer…"
              className="w-52 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
            />
          </label>
          <select
            value={serviceFilter}
            onChange={(event) => setServiceFilter(event.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            <option value="">all services</option>
            {services.map((service) => (
              <option key={service} value={service}>
                {service}
              </option>
            ))}
          </select>
          <select
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            <option value="">all severities</option>
            {["blocking", "warning", "info"].map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-900 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2">Service / version</th>
              <th className="px-2 py-2">Code</th>
              <th className="px-2 py-2">Severity</th>
              <th className="px-2 py-2">Operation</th>
              <th className="px-2 py-2">Field</th>
              <th className="px-2 py-2">Consumer</th>
              <th className="px-4 py-2">Message</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {filtered.map((finding) => (
              <tr
                key={finding.id}
                onClick={() => onSelect(finding.service, finding.version)}
                className="cursor-pointer hover:bg-slate-800/40"
              >
                <td className="whitespace-nowrap px-4 py-2 text-slate-300">
                  {finding.service}
                  <span className="text-slate-500"> @ {finding.version}</span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-slate-200">
                  {finding.code}
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ${SEVERITY_STYLE[finding.severity] ?? "bg-slate-500/15 text-slate-300 ring-slate-400/30"}`}
                  >
                    {finding.severity}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-slate-400">
                  {finding.operation_ref ?? ""}
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-slate-400">
                  {finding.field_path ?? ""}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-slate-300">
                  {finding.consumer ?? <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2 text-slate-400">{finding.message}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  No findings match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
