import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { notFound } from "../../lib/errors.js";
import { CAMPAIGN_START, FAST_START } from "../../config/plans.js";
import { keepAlive, sseHeaders, sseWrite } from "./events.js";

export const PROVISION_STEPS = ["buy_domains", "dns", "mailboxes", "warmup", "campaign"] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];
export type RowState = "done" | "running" | "waiting";

export interface ChecklistRow {
  step: ProvisionStep;
  label: string;
  detail: string;
  state: RowState;
}

const PAID = ["ACTIVE", "TRIALING", "PAST_DUE"];

/** The setup checklist after payment, worked out from the domains and inboxes the org has. */
export async function provisioningChecklist(orgId: string): Promise<{ paid: boolean; sending: boolean; rows: ChecklistRow[] }> {
  const [o, sub, domains, boxes] = await Promise.all([
    prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { warmupDays: true, fastStart: true } }),
    prisma.subscription.findUnique({ where: { organizationId: orgId }, select: { status: true } }),
    prisma.sendingDomain.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { name: true, status: true } }),
    prisma.mailbox.findMany({ where: { organizationId: orgId }, select: { status: true } }),
  ]);
  const paid = !!sub && PAID.includes(sub.status);
  const fast = !!o?.fastStart;
  const first = fast ? FAST_START.days : o?.warmupDays ?? 21;
  const lo = fast ? FAST_START.lo : CAMPAIGN_START.lo;
  const hi = fast ? FAST_START.hi : CAMPAIGN_START.hi;
  const registered = domains.length > 0 && domains.every((d) => d.status === "REGISTERED");
  const boxesReady = boxes.length > 0 && boxes.every((m) => m.status === "WARMING" || m.status === "ACTIVE");
  const boxesActive = boxes.length > 0 && boxes.every((m) => m.status === "ACTIVE");
  const names = domains.slice(0, 2).map((d) => d.name).join(", ") + (domains.length > 2 ? ` +${domains.length - 2}` : "");
  const pending = domains.filter((d) => d.status === "PENDING_REGISTRATION").length;
  const failed = domains.filter((d) => d.status === "FAILED").length;
  const rows: ChecklistRow[] = [
    {
      step: "buy_domains",
      label: `Registering ${domains.length} domains`,
      detail: registered ? names : failed ? `${failed} need attention` : pending ? `${pending} queued for registration` : "Waiting for payment",
      state: registered ? "done" : paid ? "running" : "waiting",
    },
    { step: "dns", label: "Publishing SPF, DKIM and DMARC", detail: registered ? `${domains.length * 4} records` : "After registration", state: registered ? "done" : "waiting" },
    {
      step: "mailboxes",
      label: `Creating ${boxes.length} inboxes`,
      detail: boxesReady ? `${boxes.length} inboxes ready` : boxes.some((m) => m.status === "PENDING") ? "Queued" : "After registration",
      state: boxesReady ? "done" : registered ? "running" : "waiting",
    },
    {
      step: "warmup",
      label: fast ? "Connecting pre-warmed inboxes" : "Warming up inboxes",
      detail: boxesActive ? "Complete" : boxesReady ? `Running · ${first} days` : `Starts when inboxes are ready · ${first} days`,
      state: boxesActive ? "done" : boxesReady ? "running" : "waiting",
    },
    {
      step: "campaign",
      label: "First campaign emails",
      detail: boxesActive ? `Sending ${lo} to ${hi} per inbox a day` : `About day ${first} after inboxes are ready`,
      state: boxesActive ? "running" : "waiting",
    },
  ];
  return { paid, sending: boxesActive, rows };
}

export const PROVISION_POLL_MS = 5_000;

/**
 * Same event shape as the analysis stream, so the launch screen reuses the same component.
 * Nothing is stored: the checklist is derived, so a reload simply recomputes it.
 */
export async function streamProvisioning(req: Request, res: Response, orgId: string, pathOrgId: string): Promise<void> {
  if (pathOrgId !== orgId) throw notFound("Organization");
  sseHeaders(res);
  let seq = 0;
  const send = (e: Record<string, unknown>) => sseWrite(res, { ...e, seq: ++seq }, seq);
  const seen = new Map<ProvisionStep, { state: RowState; detail: string }>();
  let ended = false;
  const poll = setInterval(() => void tick(), PROVISION_POLL_MS);
  const stop = keepAlive(req, res, () => {
    ended = true;
    clearInterval(poll);
  });

  const first = await provisioningChecklist(orgId);
  send({ type: "run.start", runId: `provisioning:${orgId}`, steps: [...PROVISION_STEPS], labels: Object.fromEntries(first.rows.map((r) => [r.step, r.label])), paid: first.paid });

  async function tick(snapshot?: Awaited<ReturnType<typeof provisioningChecklist>>) {
    if (ended) return;
    const c = snapshot ?? (await provisioningChecklist(orgId));
    for (const r of c.rows) {
      const prev = seen.get(r.step);
      if (r.state === "waiting") {
        if (!prev) seen.set(r.step, { state: r.state, detail: r.detail });
        continue;
      }
      if (!prev || prev.state === "waiting") send({ type: "step.start", step: r.step, label: r.label });
      if (!prev || prev.detail !== r.detail || prev.state !== r.state) send({ type: "step.log", step: r.step, text: r.detail, state: r.state === "done" ? "done" : "running" });
      if (r.state === "done" && prev?.state !== "done") send({ type: "step.done", step: r.step, summary: { detail: r.detail } });
      seen.set(r.step, { state: r.state, detail: r.detail });
    }
    if (c.sending && !ended) {
      send({ type: "run.done", runId: `provisioning:${orgId}`, outcome: "sending" });
      stop();
      res.end();
    }
  }

  await tick(first);
}
