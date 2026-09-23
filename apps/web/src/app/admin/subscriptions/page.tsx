"use client";

import Link from "next/link";
import { Chip, ViewHead } from "@/components/ui/primitives";
import { AdminTable } from "@/components/app/AdminTable";
import { dateLong, money, n0, titleCase } from "@/lib/format";

type S = { id: string; status: string; dailyVolume: number; inboxQuantity: number; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; plan: { name: string; priceMonthlyCents: number }; organization: { id: string; name: string } };
const STATUSES = ["INCOMPLETE", "INCOMPLETE_EXPIRED", "TRIALING", "ACTIVE", "PAST_DUE", "UNPAID", "CANCELED"];

export default function AdminSubscriptions() {
  return (
    <>
      <ViewHead kicker="Admin" title="Subscriptions." />
      <AdminTable
        resource="subscriptions"
        filters={[{ key: "status", label: "Any status", options: STATUSES.map((s) => [s, titleCase(s)] as [string, string]) }]}
        columns={[
          { label: "Organization", render: (r) => { const s = r as unknown as S; return <Link href={`/admin/organizations/${s.organization.id}`}><b>{s.organization.name}</b></Link>; } },
          { label: "Plan", render: (r) => { const s = r as unknown as S; return `${s.plan.name} · ${money(s.plan.priceMonthlyCents)}/mo`; } },
          { label: "Status", render: (r) => { const s = r as unknown as S; return <Chip tone={s.status === "ACTIVE" || s.status === "TRIALING" ? "g" : s.status === "PAST_DUE" || s.status === "UNPAID" ? "r" : "y"}>{titleCase(s.status)}{s.cancelAtPeriodEnd ? " · ending" : ""}</Chip>; } },
          { label: "Volume", right: true, render: (r) => n0((r as unknown as S).dailyVolume) },
          { label: "Inboxes", right: true, render: (r) => n0((r as unknown as S).inboxQuantity) },
          { label: "Period end", render: (r) => <span className="m">{r.currentPeriodEnd ? dateLong(String(r.currentPeriodEnd)) : ""}</span> },
        ]}
      />
    </>
  );
}
