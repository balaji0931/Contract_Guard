/** Shapes returned by the Contract Guard API (PLAN.md §9). */

export interface ServiceSummary {
  name: string;
  title: string | null;
  owner: string | null;
  description: string | null;
  latestPublished: string | null;
  versions: string[];
}

export interface VersionRow {
  id: number;
  version: string;
  status: "published" | "blocked" | "rejected" | "staged" | "invalid";
  source_file: string | null;
  reasonCodes: string[];
  decided_at: string | null;
  owner: string | null;
}

export interface Finding {
  id: number;
  code: string;
  severity: string;
  operation_ref: string | null;
  field_path: string | null;
  message: string;
  service: string;
  version: string;
  source_file: string | null;
  consumer: string | null;
}

export interface ConsumerSummary {
  name: string;
  team: string | null;
  uses: Array<{ provider: string; method: string; path: string }>;
  openIssues: number;
}

export interface ImpactConsumer {
  consumer: string;
  team: string | null;
  issues: Array<{
    consumer: string;
    team: string | null;
    code: string;
    severity: string;
    operation_ref: string | null;
    field_path: string | null;
    message: string;
  }>;
}

export interface ImpactReport {
  service: string;
  version: string;
  statuses: string[];
  reasonCodes: string[];
  impactedConsumers: ImpactConsumer[];
}

export interface AlertRow {
  id: number;
  webhook_path: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  http_status: number | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface PublishResult {
  service: string;
  version: string;
  outcome: "published" | "blocked" | "rejected";
  reasonCodes: string[];
  baselineVersion: string | null;
  impactedConsumers: string[];
  note: string;
}

export interface HealthInfo {
  status: string;
  gateMode: string;
  asOfDate: string;
  asOfDatePinned: boolean;
  fresh: boolean;
  webhookUrl: string;
}
