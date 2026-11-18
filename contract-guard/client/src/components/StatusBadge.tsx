import type { VersionRow } from "../types";

const STYLE: Record<VersionRow["status"], string> = {
  published: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  blocked: "bg-rose-500/15 text-rose-300 ring-rose-400/30",
  rejected: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  staged: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
  invalid: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
};

export function StatusBadge({ status }: { status: VersionRow["status"] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset ${STYLE[status] ?? STYLE.staged}`}
    >
      {status}
    </span>
  );
}
