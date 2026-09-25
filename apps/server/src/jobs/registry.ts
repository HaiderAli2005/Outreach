import { runSendJob } from "./send.js";
import { runBlocklistJob } from "./blocklist.js";
import { runReplySyncJob } from "./replySync.js";
import { runAutoReplyDispatchJob } from "./autoReplyDispatch.js";
import { runSourcingJob } from "./sourcing.js";
import { runReverifyJob } from "./reverify.js";
import { runBatchNotifyJob } from "./batchNotify.js";
import { runReportJob } from "./report.js";
import { runBillingSyncJob } from "./billingSync.js";

export interface JobDefinition {
  run: () => Promise<unknown>;
  lockMs: number;
  schedule: string;
  description: string;
}

export const JOBS: Record<string, JobDefinition> = {
  send: { run: runSendJob, lockMs: 25 * 60_000, schedule: "*/30 * * * *", description: "Verify, personalize and push the day's leads to Smartlead" },
  blocklist: { run: runBlocklistJob, lockMs: 20 * 60_000, schedule: "17 2 * * *", description: "Reconcile suppressions and retire non-responders" },
  "reply-sync": { run: runReplySyncJob, lockMs: 10 * 60_000, schedule: "*/5 * * * *", description: "Classify unread replies and send return-date nudges" },
  "auto-reply-dispatch": { run: runAutoReplyDispatchJob, lockMs: 5 * 60_000, schedule: "* * * * *", description: "Send queued automatic replies after re-checking every gate" },
  sourcing: { run: runSourcingJob, lockMs: 55 * 60_000, schedule: "0 */2 * * *", description: "Source new leads from Apollo into the next week's batch" },
  reverify: { run: runReverifyJob, lockMs: 30 * 60_000, schedule: "0 3 * * *", description: "Re-verify held email addresses" },
  "batch-notify": { run: runBatchNotifyJob, lockMs: 10 * 60_000, schedule: "0 */3 * * *", description: "Remind owners about weeks waiting for approval" },
  "report-daily": { run: () => runReportJob("daily"), lockMs: 30 * 60_000, schedule: "0 18 * * 1-5", description: "Daily Slack summary" },
  "report-weekly": { run: () => runReportJob("weekly"), lockMs: 30 * 60_000, schedule: "0 8 * * 1", description: "Weekly Slack summary" },
  "report-monthly": { run: () => runReportJob("monthly"), lockMs: 30 * 60_000, schedule: "0 8 1 * *", description: "Monthly Slack summary" },
  "billing-sync": { run: runBillingSyncJob, lockMs: 30 * 60_000, schedule: "0 * * * *", description: "Reconcile subscription status with Stripe" },
};
