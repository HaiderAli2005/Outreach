import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { ok } from "../../lib/http.js";
import { notFound, notConfigured } from "../../lib/errors.js";
import { parseBody } from "../../middleware/validate.js";
import { env, features } from "../../config/env.js";
import { infraforge, registrantContact } from "../../integrations/infraforge.js";
import { reconcileInfra, resumeOrg, retryItem } from "../../domain/infra.js";

/** Platform view of the Infraforge setup: credits, where every domain and inbox is, and what needs a hand. */
export async function infraOverview(_req: Request, res: Response) {
  const api = infraforge();
  const [domainGroups, boxGroups, held, badDomains, badBoxes, workspaces, dedicated] = await Promise.all([
    prisma.sendingDomain.groupBy({ by: ["status"], where: { status: { not: "SELECTED" } }, _count: { _all: true } }),
    prisma.mailbox.groupBy({ by: ["status"], where: { status: { not: "PLANNED" } }, _count: { _all: true } }),
    prisma.infraWorkspace.findMany({ where: { heldReason: { not: null } }, include: { organization: { select: { name: true } } }, orderBy: { heldAt: "asc" } }),
    prisma.sendingDomain.findMany({
      where: { OR: [{ status: "FAILED" }, { lastError: { not: null } }] },
      include: { organization: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.mailbox.findMany({
      where: { OR: [{ status: "ERROR" }, { lastError: { not: null }, status: { not: "RELEASED" } }] },
      include: { organization: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.infraWorkspace.count(),
    prisma.infraWorkspace.count({ where: { dedicatedIp: true } }),
  ]);
  let balance: { availableCents: number; autoTopup: boolean } | null = null;
  let balanceError: string | null = null;
  if (api) {
    try {
      balance = await api.creditBalance();
    } catch (e) {
      balanceError = (e as Error).message;
    }
  }
  const { missing } = registrantContact();
  return ok(res, {
    configured: features.infraforge,
    sslForwarding: features.infraSslForwarding,
    dedicatedIpFromVolume: env.INFRAFORGE_DEDICATED_IP_MIN_VOLUME,
    missingContact: missing,
    balance,
    balanceError,
    workspaces,
    dedicatedIps: dedicated,
    domains: Object.fromEntries(domainGroups.map((g) => [g.status, g._count._all])),
    mailboxes: Object.fromEntries(boxGroups.map((g) => [g.status, g._count._all])),
    held: held.map((h) => ({ orgId: h.organizationId, orgName: h.organization.name, reason: h.heldReason, since: h.heldAt })),
    problems: [
      ...badDomains.map((d) => ({ kind: "domain" as const, id: d.id, orgId: d.organizationId, orgName: d.organization.name, name: d.name, status: d.status, error: d.lastError, attempts: d.attempts, updatedAt: d.updatedAt })),
      ...badBoxes.map((m) => ({ kind: "mailbox" as const, id: m.id, orgId: m.organizationId, orgName: m.organization.name, name: m.address, status: m.status, error: m.lastError, attempts: m.attempts, updatedAt: m.updatedAt })),
    ].sort((a, b) => +b.updatedAt - +a.updatedAt),
  });
}

export async function infraRetry(req: Request, res: Response) {
  const body = parseBody(req, z.object({ kind: z.enum(["domain", "mailbox"]), id: z.string().min(1) }));
  const exists = body.kind === "domain" ? await prisma.sendingDomain.count({ where: { id: body.id } }) : await prisma.mailbox.count({ where: { id: body.id } });
  if (!exists) throw notFound(body.kind === "domain" ? "Domain" : "Inbox");
  const { orgId } = await retryItem(body.kind, body.id);
  return ok(res, await reconcileInfra(orgId));
}

export async function infraResume(req: Request, res: Response) {
  const body = parseBody(req, z.object({ orgId: z.string().min(1) }));
  await resumeOrg(body.orgId);
  return ok(res, await reconcileInfra(body.orgId));
}

export async function infraRun(req: Request, res: Response) {
  if (!features.infraforge) throw notConfigured("Infraforge");
  const body = parseBody(req, z.object({ orgId: z.string().min(1) }));
  return ok(res, await reconcileInfra(body.orgId));
}
