/**
 * Dashboard (`GET /`, PLAN.md §9, T-5): server-rendered HTML — per-service
 * version timeline with statuses, findings table, consumer risk list, sent
 * alert log, and re-publish buttons that re-run the gate live. No frontend
 * framework: one dependency-free page reading the same registry tables.
 */

import { escapeHtml } from "../domain/html.js";
import type { Database } from "../db/database.js";

interface VersionRow {
  service: string;
  version: string;
  status: string;
  source_file: string | null;
  outcome_reason_code: string | null;
}

interface FindingRow {
  service: string;
  version: string;
  code: string;
  severity: string;
  operation_ref: string | null;
  field_path: string | null;
  consumer: string | null;
  message: string;
}

const STATUS_BADGE: Record<string, string> = {
  published: "✅ published",
  blocked: "⛔ blocked",
  rejected: "🚫 rejected",
  staged: "⏳ staged",
  invalid: "⚠️ invalid",
};

export function renderDashboard(db: Database): string {
  const versions = db
    .prepare(
      `SELECT s.name AS service, sv.version, sv.status, sv.source_file, sv.outcome_reason_code
       FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       ORDER BY s.name, sv.source_file`,
    )
    .all() as VersionRow[];
  const findings = db
    .prepare(
      `SELECT s.name AS service, sv.version, f.code, f.severity, f.operation_ref,
              f.field_path, c.name AS consumer, f.message
       FROM findings f
       JOIN spec_versions sv ON sv.id = f.spec_version_id
       JOIN services s ON s.id = sv.service_id
       LEFT JOIN consumers c ON c.id = f.consumer_id
       ORDER BY s.name, sv.id, f.id LIMIT 200`,
    )
    .all() as FindingRow[];
  const consumers = db
    .prepare("SELECT name, team FROM consumers ORDER BY name")
    .all() as Array<{ name: string; team: string | null }>;
  const risks = db
    .prepare(
      `SELECT con.name AS consumer, COUNT(*) AS n
       FROM findings f
       JOIN consumers con ON con.id = f.consumer_id
       WHERE f.consumer_id IS NOT NULL
       GROUP BY f.consumer_id ORDER BY n DESC`,
    )
    .all() as Array<{ consumer: string; n: number }>;
  const alerts = db
    .prepare(
      `SELECT webhook_path, status, attempts, sent_at FROM alerts
       ORDER BY id DESC LIMIT 50`,
    )
    .all() as Array<{
    webhook_path: string;
    status: string;
    attempts: number;
    sent_at: string | null;
  }>;

  const services = [...new Set(versions.map((row) => row.service))];

  const timeline = services
    .map((service) => {
      const rows = versions.filter((row) => row.service === service);
      const items = rows
        .map((row) => {
          const badge = STATUS_BADGE[row.status] ?? escapeHtml(row.status);
          const reason =
            row.outcome_reason_code === null || row.outcome_reason_code === ""
              ? ""
              : ` <span class="reason">${escapeHtml(row.outcome_reason_code)}</span>`;
          return `<li>${badge} <b>${escapeHtml(row.version)}</b>${reason}
            <button data-service="${escapeHtml(row.service)}" data-version="${escapeHtml(row.version)}"
              onclick="republish(this)">re-publish</button>
            <span class="out"></span></li>`;
        })
        .join("");
      return `<h3>${escapeHtml(service)}</h3><ul>${items}</ul>`;
    })
    .join("");

  const findingsTable =
    findings.length === 0
      ? "<p>No findings.</p>"
      : `<table>
        <tr><th>service</th><th>version</th><th>code</th><th>severity</th><th>operation</th><th>field</th><th>consumer</th><th>message</th></tr>
        ${findings
          .map(
            (row) => `<tr>
          <td>${escapeHtml(row.service)}</td><td>${escapeHtml(row.version)}</td>
          <td><code>${escapeHtml(row.code)}</code></td><td>${escapeHtml(row.severity)}</td>
          <td>${escapeHtml(row.operation_ref ?? "")}</td><td>${escapeHtml(row.field_path ?? "")}</td>
          <td>${escapeHtml(row.consumer ?? "")}</td><td>${escapeHtml(row.message)}</td></tr>`,
          )
          .join("")}
      </table>`;

  const riskList =
    risks.length === 0
      ? "<p>All consumers clear.</p>"
      : `<ul>${risks
          .map((risk) => `<li><b>${escapeHtml(risk.consumer)}</b> — ${risk.n} issue(s)</li>`)
          .join("")}</ul>`;

  const alertList =
    alerts.length === 0
      ? "<p>No alerts yet.</p>"
      : `<ul>${alerts
          .map(
            (alert) =>
              `<li>${alert.status === "sent" ? "📤" : alert.status === "failed" ? "❌" : "⏳"}
               <code>${escapeHtml(alert.webhook_path)}</code> — ${escapeHtml(alert.status)}
               (${alert.attempts} attempt(s)${alert.sent_at === null ? "" : `, ${escapeHtml(alert.sent_at)}`})</li>`,
          )
          .join("")}</ul>`;

  const consumerNames = consumers.map((c) => c.name).join(", ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Contract Guard</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; color: #1b1f24; }
  h1 { margin-bottom: .25rem; } h2 { margin-top: 2rem; border-bottom: 2px solid #e1e4e8; padding-bottom: .25rem; }
  ul { list-style: none; padding-left: 0; line-height: 1.9; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #d0d7de; padding: .3rem .5rem; text-align: left; }
  th { background: #f6f8fa; }
  .reason { color: #57606a; font-size: .8rem; }
  button { font-size: .75rem; cursor: pointer; }
  .out { font-size: .8rem; color: #0550ae; }
</style>
</head>
<body>
<h1>Contract Guard</h1>
<p>API contract registry — publishes are gated against known consumers. Auto-refreshes every 10 s.</p>

<h2>Version timeline</h2>
${timeline}

<h2>Consumer risks</h2>
${riskList}
<p>Consumers tracked: ${escapeHtml(consumerNames)}</p>

<h2>Findings</h2>
${findingsTable}

<h2>Alert log</h2>
${alertList}

<script>
async function republish(button) {
  const service = button.dataset.service, version = button.dataset.version;
  const out = button.nextElementSibling;
  out.textContent = "…";
  try {
    const response = await fetch(\`/api/services/\${service}/versions/\${version}/publish\`,
      { method: "POST" });
    const body = await response.json();
    out.textContent = response.status === 404
      ? "not found"
      : \`\${body.outcome}\${(body.reasonCodes ?? []).length ? " (" + body.reasonCodes.join(", ") + ")" : ""}\`;
  } catch (error) {
    out.textContent = "request failed";
  }
  setTimeout(() => location.reload(), 1200);
}
</script>
</body>
</html>
`;
}
