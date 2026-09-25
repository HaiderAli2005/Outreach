import type { Subscription, Plan } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { paymentRequired, unprocessable } from "../lib/errors.js";

export type SubscriptionWithPlan = Subscription & { plan: Plan };

export async function subscriptionOf(orgId: string): Promise<SubscriptionWithPlan | null> {
  return prisma.subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });
}

export function isActive(sub: Pick<Subscription, "status"> | null): boolean {
  return !!sub && (sub.status === "ACTIVE" || sub.status === "TRIALING");
}

export async function hasActiveSubscription(orgId: string): Promise<boolean> {
  return isActive(await subscriptionOf(orgId));
}

export async function assertActiveSubscription(orgId: string): Promise<SubscriptionWithPlan> {
  const sub = await subscriptionOf(orgId);
  if (!sub || !isActive(sub)) throw paymentRequired();
  return sub;
}

export function dailyVolumeLimit(sub: SubscriptionWithPlan | null): number {
  if (!sub || !isActive(sub)) return 0;
  return Math.min(sub.plan.maxDailyVolume, sub.dailyVolume || sub.plan.maxDailyVolume);
}

export async function assertCampaignCapacity(orgId: string, excludeId?: string): Promise<void> {
  const sub = await assertActiveSubscription(orgId);
  const max = sub.plan.maxCampaigns;
  if (max == null) return;
  const running = await prisma.campaign.count({ where: { organizationId: orgId, status: "ACTIVE", ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (running >= max) throw unprocessable(`Your ${sub.plan.name} plan runs ${max} campaign${max === 1 ? "" : "s"} at a time. Pause one or upgrade to run more.`);
}
