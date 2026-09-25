import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logSystem } from "../domain/systemLog.js";

export interface OrgJobResult {
  orgId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function forEachOrg(
  job: string,
  where: Prisma.OrganizationWhereInput,
  fn: (orgId: string) => Promise<unknown>,
): Promise<OrgJobResult[]> {
  const orgs = await prisma.organization.findMany({ where: { status: "ACTIVE", ...where }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const out: OrgJobResult[] = [];
  for (const { id } of orgs) {
    try {
      out.push({ orgId: id, ok: true, result: await fn(id) });
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ job, orgId: id, err: message }, "job failed for organization");
      await logSystem(id, "ERROR", job, `Scheduled ${job} failed: ${message}`);
      out.push({ orgId: id, ok: false, error: message });
    }
  }
  return out;
}

export const payingOrgs: Prisma.OrganizationWhereInput = { subscription: { status: { in: ["ACTIVE", "TRIALING"] } } };
export const autopilotOrgs: Prisma.OrganizationWhereInput = { ...payingOrgs, settings: { autopilotEnabled: true } };
