import type {
  AlertRow,
  ConsumerSummary,
  Finding,
  HealthInfo,
  ImpactReport,
  PublishResult,
  ServiceSummary,
  VersionRow,
} from "./types";

/** Thin typed wrapper over the documented JSON API — the SPA never bypasses it. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const api = {
  health: () => get<HealthInfo>("/api/health"),
  services: () => get<ServiceSummary[]>("/api/services"),
  versions: (service: string) => get<VersionRow[]>(`/api/services/${service}/versions`),
  findings: (filters: Record<string, string> = {}) => {
    const query = new URLSearchParams(filters).toString();
    return get<Finding[]>(`/api/findings${query === "" ? "" : `?${query}`}`);
  },
  impact: (service: string, version: string) =>
    get<ImpactReport>(`/api/services/${service}/versions/${version}/impact`),
  consumers: () => get<ConsumerSummary[]>("/api/consumers"),
  alerts: (limit = 30) => get<AlertRow[]>(`/api/alerts?limit=${limit}`),
  publish: (service: string, version: string) =>
    post<PublishResult>(`/api/services/${service}/versions/${version}/publish`),
  recheck: () => post<unknown>("/api/recheck"),
};
