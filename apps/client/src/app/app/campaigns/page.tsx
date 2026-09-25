"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Empty, ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { CampaignPill } from "@/components/app/CampaignPill";
import { Modal } from "@/components/ui/overlays";
import { CampaignForm, initialCampaign, toPayload } from "@/components/app/CampaignForm";
import { useRole, useToast } from "@/store";
import { errorMessage, useCampaignsQuery, useCreateCampaignMutation } from "@/store/api";
import { ago, n0 } from "@/lib/format";
import type { Campaign } from "@/lib/types";

function NewCampaign({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState(initialCampaign());
  const [create, { isLoading }] = useCreateCampaignMutation();
  const [err, setErr] = useState("");
  const router = useRouter();
  const toast = useToast();
  return (
    <Modal
      wide
      title="New campaign"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={isLoading}
            disabled={!v.name.trim()}
            onClick={() =>
              create(toPayload(v))
                .unwrap()
                .then((c) => {
                  toast("Campaign created", "good");
                  router.push(`/app/campaigns/${c.id}`);
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Create campaign
          </Button>
        </>
      }
    >
      <CampaignForm value={v} onChange={setV} />
      {err ? (
        <div className="banner bad" role="alert" style={{ marginTop: 14 }}>
          {err}
        </div>
      ) : null}
    </Modal>
  );
}

export default function CampaignsPage() {
  const { data, isLoading, isError, error, refetch } = useCampaignsQuery();
  const { canManage } = useRole();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const rows = (data ?? []).filter((c) => showArchived || c.status !== "ARCHIVED");

  return (
    <>
      <ViewHead
        kicker="Campaigns"
        title="Markets you're working."
        sub="Each campaign has its own audience and angle. Daily sends are shared across running campaigns, weighted toward the ones getting replies."
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New campaign
            </Button>
          ) : null
        }
      />
      <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>
      <div className="tbl-wrap glass">
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          <SkeletonRows rows={4} />
        ) : rows.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th className="right">Leads</th>
                  <th className="right">Contacted</th>
                  <th className="right">Replies</th>
                  <th className="right">Reply rate</th>
                  <th className="right">Share of sends</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/app/campaigns/${c.id}`}>
                        <b>{c.name}</b>
                      </Link>
                      <div className="m">
                        {c.niche ?? "No niche set"} · created {ago(c.createdAt)}
                      </div>
                    </td>
                    <td>
                      <CampaignPill c={c} />
                    </td>
                    <td className="num-cell">{n0(c.leadCount)}</td>
                    <td className="num-cell">{n0(c.contactedCount)}</td>
                    <td className="num-cell">{n0(c.replyCount)}</td>
                    <td className="num-cell">{c.replyRate === null ? "n/a" : `${c.replyRate}%`}</td>
                    <td className="num-cell">{c.dailyShare ? `${c.dailyShare}%` : "0%"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="target"
            title="No campaigns yet"
            action={
              canManage ? (
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                  Create your first campaign
                </Button>
              ) : null
            }
          >
            A campaign describes a market: who to find and what to say to them.
          </Empty>
        )}
      </div>
      {creating ? <NewCampaign onClose={() => setCreating(false)} /> : null}
    </>
  );
}
