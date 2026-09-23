import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, paginationSchema, boolish } from "../../lib/http.js";
import { parseBody, parseParams, parseQuery } from "../../middleware/validate.js";
import { streamCsv, type CsvColumn } from "../../lib/csv.js";
import { prisma } from "../../lib/prisma.js";
import * as service from "./contacts.service.js";

const statuses = ["NEW", "PERSONALIZED", "QUEUED", "CONTACTED", "REPLIED", "NO_RESPONSE", "BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED", "REJECTED"] as const;
const filters = z.object({
  status: z.enum(statuses).optional(),
  suppressed: boolish.optional(),
  campaignId: z.string().max(40).optional(),
  batchId: z.string().max(40).optional(),
  tier: z.enum(["A", "B", "C", "a", "b", "c"]).optional(),
  reply: z.enum(["urgent", "lead", "replied", ...service.REPLY_CLASSES]).optional(),
  contacted: boolish.optional(),
  search: z.string().trim().max(120).optional(),
});

type Row = Awaited<ReturnType<typeof prisma.contact.findMany<{ select: typeof service.listSelect }>>>[number];

export const exportColumns: CsvColumn<Row>[] = [
  { key: "email", label: "Email" },
  { key: "fullName", label: "Name" },
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "title", label: "Title" },
  { key: "seniority", label: "Seniority" },
  { key: "company", label: "Company" },
  { key: "website", label: "Website" },
  { key: "linkedinUrl", label: "LinkedIn" },
  { key: "phone", label: "Phone" },
  { key: "industry", label: "Industry" },
  { key: "location", label: "Location" },
  { key: "status", label: "Status" },
  { key: "personalizationStatus", label: "Personalization" },
  { key: "emailStatus", label: "Email Status" },
  { key: "verifyResult", label: "Verification" },
  { key: "tier", label: "Tier" },
  { key: "fitScore", label: "Fit Score" },
  { key: "replyClass", label: "Reply" },
  { key: "source", label: "Source" },
  { key: "campaignId", label: "Campaign" },
  { key: "lastContactedAt", label: "Last Contacted" },
  { key: "repliedAt", label: "Replied" },
  { key: "createdAt", label: "Added" },
];

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, paginationSchema(500, 50).extend(filters.shape));
  const r = await service.list(ctx(req).orgId, q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total, replyCounts: r.replyCounts });
}

export async function stats(req: Request, res: Response) {
  return ok(res, await service.stats(ctx(req).orgId));
}

export async function exportCsv(req: Request, res: Response) {
  const q = parseQuery(req, filters);
  const where = service.buildWhere(ctx(req).orgId, q);
  const tag = q.campaignId ?? (q.batchId ? `week-${q.batchId}` : q.suppressed ? "suppressed" : "all");
  await streamCsv(res, `leads-${tag}-${new Date().toISOString().slice(0, 10)}.csv`, exportColumns, (skip, take) =>
    prisma.contact.findMany({ where, select: service.listSelect, orderBy: [{ fitScore: "desc" }, { id: "asc" }], skip, take }),
  );
}

export async function detail(req: Request, res: Response) {
  const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
  return ok(res, await service.detail(ctx(req).orgId, id));
}

export async function importCsv(req: Request, res: Response) {
  const body = parseBody(req, z.object({ text: z.string().min(1).max(4_500_000), campaignId: z.string().max(40).optional() }));
  return ok(res, await service.importCsv(ctx(req).orgId, body.text, body.campaignId));
}

export async function daily(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ date: z.string().optional() }));
  return ok(res, await service.daily(ctx(req).orgId, q.date));
}

export async function dailyExport(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ date: z.string().optional() }));
  const d = await service.daily(ctx(req).orgId, q.date);
  const orgId = ctx(req).orgId;
  await streamCsv(res, `sent-${d.date}.csv`, exportColumns, (skip, take) =>
    prisma.contact.findMany({ where: { organizationId: orgId, lastContactedAt: { gte: d.range.from, lt: d.range.to } }, select: service.listSelect, orderBy: { id: "asc" }, skip, take }),
  );
}
