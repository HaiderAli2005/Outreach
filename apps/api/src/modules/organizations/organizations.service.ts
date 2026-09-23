import type { MemberRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../lib/errors.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import type { OrgContext } from "../../lib/http.js";
import { brandFromDomain, extractDomain, isValidDomain } from "../../lib/normalize.js";
import { createOrganizationWithOwner } from "../auth/auth.repository.js";

const MAX_OWNED_ORGS = 5;

export async function createOrganization(userId: string, input: { name?: string; domain?: string }) {
  const domain = input.domain ? extractDomain(input.domain) : null;
  if (input.domain && (!domain || !isValidDomain(domain))) throw badRequest("That doesn't look like a domain. Try something like northwind.io");
  const owned = await prisma.membership.count({ where: { userId, role: "OWNER", status: "ACTIVE" } });
  if (owned >= MAX_OWNED_ORGS) throw unprocessable(`You can own up to ${MAX_OWNED_ORGS} organizations`);
  const name = input.name?.trim() || (domain ? brandFromDomain(domain) : "My workspace");
  const org = await prisma.$transaction(async (tx) => {
    const o = await createOrganizationWithOwner(tx, userId, name, domain);
    if (domain) await tx.onboarding.create({ data: { organizationId: o.id, domain, brand: brandFromDomain(domain), icp: { industries: [], titles: [], sizes: [], regions: [] } } });
    return o;
  });
  return { id: org.id, name: org.name, primaryDomain: org.primaryDomain };
}

export async function getOrganization(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, primaryDomain: true, status: true, createdAt: true, webhookToken: true },
  });
  if (!org) throw notFound("Organization");
  return org;
}

export async function updateOrganization(orgId: string, data: { name?: string }) {
  return prisma.organization.update({ where: { id: orgId }, data, select: { id: true, name: true, primaryDomain: true } });
}

export async function listMembers(orgId: string) {
  const rows = await prisma.membership.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, status: true, invitedEmail: true, createdAt: true, user: { select: { id: true, email: true, name: true, lastLoginAt: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    status: m.status,
    email: m.user?.email ?? m.invitedEmail,
    name: m.user?.name ?? null,
    userId: m.user?.id ?? null,
    lastLoginAt: m.user?.lastLoginAt ?? null,
    createdAt: m.createdAt,
  }));
}

export async function inviteMember(ctx: OrgContext, email: string, role: MemberRole) {
  if (role === "OWNER" && ctx.role !== "OWNER") throw forbidden("Only the owner can invite another owner");
  const normalized = email.trim().toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });
  if (existingUser) {
    const already = await prisma.membership.findFirst({ where: { organizationId: ctx.orgId, userId: existingUser.id } });
    if (already) throw conflict("That person is already a member");
  }
  const token = randomToken(24);
  await prisma.membership.upsert({
    where: { organizationId_invitedEmail: { organizationId: ctx.orgId, invitedEmail: normalized } },
    create: { organizationId: ctx.orgId, invitedEmail: normalized, role, status: "INVITED", inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + 7 * 86_400_000) },
    update: { role, status: "INVITED", inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + 7 * 86_400_000) },
  });
  return { email: normalized, role, inviteToken: token, expiresInDays: 7 };
}

async function loadMembership(orgId: string, membershipId: string) {
  const m = await prisma.membership.findFirst({ where: { id: membershipId, organizationId: orgId } });
  if (!m) throw notFound("Member");
  return m;
}

async function ownerCount(orgId: string) {
  return prisma.membership.count({ where: { organizationId: orgId, role: "OWNER", status: "ACTIVE" } });
}

export async function changeRole(ctx: OrgContext, membershipId: string, role: MemberRole) {
  const m = await loadMembership(ctx.orgId, membershipId);
  if ((m.role === "OWNER" || role === "OWNER") && ctx.role !== "OWNER") throw forbidden("Only an owner can change owner roles");
  if (m.role === "OWNER" && role !== "OWNER" && (await ownerCount(ctx.orgId)) <= 1) throw unprocessable("An organization needs at least one owner");
  await prisma.membership.update({ where: { id: m.id }, data: { role } });
  return { id: m.id, role };
}

export async function removeMember(ctx: OrgContext, membershipId: string) {
  const m = await loadMembership(ctx.orgId, membershipId);
  if (m.role === "OWNER" && ctx.role !== "OWNER") throw forbidden("Only an owner can remove an owner");
  if (m.role === "OWNER" && (await ownerCount(ctx.orgId)) <= 1) throw unprocessable("An organization needs at least one owner");
  await prisma.membership.delete({ where: { id: m.id } });
  return { removed: true };
}
