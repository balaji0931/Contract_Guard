import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import { api } from "./api";
import { AlertFeed } from "./components/AlertFeed";
import { FindingsInspector } from "./components/FindingsInspector";
import { ImpactInspector } from "./components/ImpactInspector";
import { ServiceTimeline } from "./components/ServiceTimeline";
import { StatsOverview } from "./components/StatsOverview";
import type {
  AlertRow,
  ConsumerSummary,
  Finding,
  HealthInfo,
  ServiceSummary,
  VersionRow,
} from "./types";

const POLL_MS = 5000;

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [versionsByService, setVersionsByService] = useState<Map<string, VersionRow[]>>(new Map());
  const [findings, setFindings] = useState<Finding[]>([]);
  const [consumers, setConsumers] = useState<ConsumerSummary[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [selected, setSelected] = useState<{ service: string; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [healthInfo, serviceList, consumerList, findingList, alertList] = await Promise.all([
        api.health(),
        api.services(),
        api.consumers(),
        api.findings(),
        api.alerts(40),
      ]);
      const versionLists = await Promise.all(
        serviceList.map(async (service) => [service.name, await api.versions(service.name)] as const),
      );
      setHealth(healthInfo);
      setServices(serviceList);
      setConsumers(consumerList);
      setFindings(findingList);
      setAlerts(alertList);
      setVersionsByService(new Map(versionLists));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Initial load, then a light poll for the live parts (alerts + health).
  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => {
      void (async () => {
        try {
          const [healthInfo, alertList] = await Promise.all([api.health(), api.alerts(40)]);
          setHealth(healthInfo);
          setAlerts(alertList);
        } catch {
          // keep the last good view while the backend restarts
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  async function recheck() {
    setBusy(true);
    try {
      await api.recheck();
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <ShieldCheck className="h-6 w-6 text-sky-400" aria-hidden />
          <h1 className="text-lg font-semibold tracking-tight">Contract Guard</h1>
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-300">
            gate: {health?.gateMode ?? "…"}
          </span>
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-300">
            as of {health?.asOfDate ?? "…"}
            {health?.asOfDatePinned ? " (pinned)" : ""}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] ${
              health?.status === "ok"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-rose-500/15 text-rose-300"
            }`}
          >
            {health?.status ?? "connecting…"}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {error !== null && <span className="text-xs text-rose-300">API error: {error}</span>}
            <button
              type="button"
              onClick={() => void recheck()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-50"
            >
              <ScanSearch className={`h-3.5 w-3.5 ${busy ? "animate-pulse" : ""}`} aria-hidden />
              Run recheck
            </button>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50 hover:text-sky-300"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <StatsOverview
          services={services}
          versions={[...versionsByService.values()].flat()}
          consumers={consumers}
          alerts={alerts}
        />

        <ServiceTimeline
          services={services}
          versionsByService={versionsByService}
          selected={selected}
          onSelect={(service, version) => setSelected({ service, version })}
          onChanged={loadAll}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <FindingsInspector
              findings={findings}
              services={services.map((service) => service.name)}
              onSelect={(service, version) => setSelected({ service, version })}
            />
          </div>
          <div className="flex min-h-[24rem] flex-col gap-4">
            <ImpactInspector selected={selected} />
            <div className="min-h-[16rem] flex-1">
              <AlertFeed alerts={alerts} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
