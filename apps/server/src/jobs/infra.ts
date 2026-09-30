import { features } from "../config/env.js";
import { reconcileInfra, releaseInfra } from "../domain/infra.js";
import { forEachOrg } from "./runner.js";

/** Every paid setup with domains or inboxes still moving, plus active inboxes that are ramping up. */
export function runInfraProvisionJob() {
  if (!features.infraforge) return Promise.resolve({ skipped: "Infraforge is not configured" });
  return forEachOrg(
    "infra-provision",
    { onboarding: { paidAt: { not: null } }, subscription: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } } },
    reconcileInfra,
  );
}

/** Ended subscriptions past the grace period: close their inboxes and stop domain renewal. */
export function runInfraReleaseJob() {
  if (!features.infraforge) return Promise.resolve({ skipped: "Infraforge is not configured" });
  return forEachOrg(
    "infra-release",
    { subscription: { status: { in: ["CANCELED", "INCOMPLETE_EXPIRED", "UNPAID"] } }, mailboxes: { some: { providerId: { not: null } } } },
    releaseInfra,
  );
}
