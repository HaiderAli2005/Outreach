"use client";

import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, Empty, ErrorState, Field, Notice, Seg, SettingRow, SkeletonRows, Switch, TextArea, TextField, ViewHead } from "@/components/ui/primitives";
import { Confirm, Modal } from "@/components/ui/overlays";
import { useAppSelector, useRole, useToast } from "@/store";
import {
  errorMessage,
  useAutoReplyMetricsQuery,
  useAutopilotQuery,
  useCampaignsQuery,
  useChangeRoleMutation,
  useInviteMutation,
  useKillAutoReplyMutation,
  useMailboxesQuery,
  useMembersQuery,
  useOrganizationQuery,
  useProvisionMutation,
  useReleaseAutoReplyMutation,
  useRemoveCredentialMutation,
  useRemoveMemberMutation,
  useSaveCredentialMutation,
  useSettingsQuery,
  useSourcingUsageQuery,
  useUpdateOrganizationMutation,
  useUpdateSettingsMutation,
  useVerifyEmailMutation,
} from "@/store/api";
import { ago, dateLong, n0, titleCase } from "@/lib/format";
import type { AutoReplyMode, OrgSettings, Provider, SettingsView } from "@/lib/types";

const BOX_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = { ACTIVE: "g", WARMING: "b", CONNECTING: "b", CREATING: "b", PENDING: "y", PLANNED: "v", ERROR: "r", RELEASED: "v" };
const BOX_LABEL: Record<string, string> = { PLANNED: "Planned", PENDING: "Queued", CREATING: "Creating", CONNECTING: "Connecting", WARMING: "Warming up", ACTIVE: "Sending", ERROR: "Needs attention", RELEASED: "Closed" };

type Patch = Partial<OrgSettings>;

const TABS = [
  ["autopilot", "Autopilot"],
  ["replies", "Automatic replies"],
  ["sending", "Sending"],
  ["integrations", "Integrations"],
  ["brand", "Sender and brand"],
  ["team", "Team"],
] as const;

function useDraft(view: SettingsView | undefined) {
  const [draft, setDraft] = useState<Patch>({});
  const s = useMemo(() => (view ? { ...view.settings, ...draft } : null), [view, draft]);
  const changed = useMemo(() => {
    if (!view) return {} as Patch;
    const out: Patch = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify((view.settings as unknown as Record<string, unknown>)[k])) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }, [view, draft]);
  return { s, set: (p: Patch) => setDraft((d) => ({ ...d, ...p })), changed, reset: () => setDraft({}) };
}

function SaveBar({ changed, reset, disabled }: { changed: Patch; reset: () => void; disabled?: boolean }) {
  const [save, { isLoading }] = useUpdateSettingsMutation();
  const toast = useToast();
  const n = Object.keys(changed).length;
  if (!n) return null;
  return (
    <div className="ob-foot glass" style={{ marginTop: 4 }}>
      <span className="spacer muted" style={{ fontSize: 14 }}>
        {n} unsaved change{n === 1 ? "" : "s"}
      </span>
      <Button variant="text" onClick={reset}>
        Discard
      </Button>
      <Button
        variant="primary"
        loading={isLoading}
        disabled={disabled}
        onClick={() =>
          save(changed)
            .unwrap()
            .then((r) => {
              reset();
              toast(r.voidedAutoReplies ? `Saved. ${r.voidedAutoReplies} queued automatic repl${r.voidedAutoReplies === 1 ? "y was" : "ies were"} cancelled.` : "Settings saved", "good");
            })
            .catch((e) => toast(errorMessage(e), "bad"))
        }
      >
        Save changes
      </Button>
    </div>
  );
}

function Num({ label, value, onChange, min, max, hint, disabled }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; hint?: ReactNode; disabled?: boolean }) {
  return <TextField label={label} type="number" min={min} max={max} value={value} hint={hint} disabled={disabled} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />;
}

function Autopilot({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const { data: ap } = useAutopilotQuery();
  const { data: usage } = useSourcingUsageQuery();
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [s?.timezone ?? "UTC"];
    }
  }, [s?.timezone]);
  if (!s) return null;
  const planMax = view.limits.planDailyVolume;
  return (
    <>
      {ap ? (
        <div className="panel glass">
          <h3>
            Readiness<small>{ap.ready ? "everything needed is in place" : "some pieces are missing"}</small>
          </h3>
          <ul className="checks" style={{ marginTop: 14 }}>
            {ap.readiness.map((r) => (
              <li key={r.key} className={r.ok ? "" : "off"}>
                <Icon id={r.ok ? "check" : "x"} />
                <span>
                  <b>{r.label}</b>
                  {r.optional ? " (optional)" : ""}
                  {!r.ok ? <span className="muted"> · not set up</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="kvgrid" style={{ marginTop: 16 }}>
            <div>
              <small>Mailboxes</small>
              <b>{ap.sending.mailboxes}</b>
            </div>
            <div>
              <small>Mailbox ceiling</small>
              <b>{ap.sending.ceiling === null ? "no mailboxes" : `${n0(ap.sending.ceiling)} a day`}</b>
            </div>
            <div>
              <small>CSV leads waiting</small>
              <b>{n0(ap.sending.csvQueued)}</b>
            </div>
            <div>
              <small>Lead credits today</small>
              <b>{ap.sourcing.pacing.unlimited ? "no cap" : `${n0(ap.sourcing.pacing.allowanceToday ?? 0)} left`}</b>
            </div>
          </div>
        </div>
      ) : null}
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>Outreach</h3>
          <SettingRow title="Autopilot" desc="Find, write and send every working day without you doing anything.">
            <Switch label="Autopilot" checked={s.autopilotEnabled} onChange={(v) => set({ autopilotEnabled: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Weekly review" desc="Gather each week's leads into a list you approve before it sends.">
            <Switch label="Weekly review" checked={s.weeklyBatchMode} onChange={(v) => set({ weeklyBatchMode: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Approve weeks automatically" desc="Skip the review when you don't need it.">
            <Switch label="Approve automatically" checked={s.autoApproveBatches} onChange={(v) => set({ autoApproveBatches: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Personalize every email" desc="Write each first email from the prospect's own details.">
            <Switch label="Personalize" checked={s.personalizationEnabled} onChange={(v) => set({ personalizationEnabled: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Only send to verified emails" desc="Skip addresses the email checker can't confirm.">
            <Switch label="Verified only" checked={s.requireVerifiedEmail} onChange={(v) => set({ requireVerifiedEmail: v })} disabled={!canManage} />
          </SettingRow>
        </div>
        <div className="panel glass">
          <h3>Volume and timing</h3>
          <div className="grid2" style={{ marginTop: 14 }}>
            <Num label="Emails a day" min={1} max={Math.max(1, planMax)} value={s.defaultDailySendCap} onChange={(n) => set({ defaultDailySendCap: n })} hint={planMax ? `Your plan allows up to ${n0(planMax)}` : "Needs an active plan"} />
            <Num label="New leads to find a day" min={20} max={5000} value={s.dailySourceTarget} onChange={(n) => set({ dailySourceTarget: n })} />
            <Num label="Contacts per company" min={1} max={10} value={s.perCompanyContactCap} onChange={(n) => set({ perCompanyContactCap: n })} />
            <Num label="Days before a non-responder is retired" min={3} max={60} value={s.blocklistNoReplyDays} onChange={(n) => set({ blocklistNoReplyDays: n })} />
            <Field label="Time zone" htmlFor="tz">
              <select id="tz" className="input" value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid2">
              <TextField label="Sending starts" type="time" value={s.sendingWindowStart} onChange={(e) => set({ sendingWindowStart: e.target.value })} />
              <TextField label="Sending ends" type="time" value={s.sendingWindowEnd} onChange={(e) => set({ sendingWindowEnd: e.target.value })} />
            </div>
            <Field label="Email language" htmlFor="lang">
              <select id="lang" className="input" value={s.language} onChange={(e) => set({ language: e.target.value })}>
                {[
                  ["en", "English"],
                  ["sv", "Swedish"],
                  ["de", "German"],
                  ["fr", "French"],
                  ["es", "Spanish"],
                  ["nl", "Dutch"],
                  ["da", "Danish"],
                  ["no", "Norwegian"],
                ].map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <div className="panel glass">
          <h3>
            Lead credits<small>{usage?.pacing.unlimited ? "no monthly cap" : usage ? `${n0(usage.pacing.spentCycle)} used this cycle` : ""}</small>
          </h3>
          <div className="grid3" style={{ marginTop: 14 }}>
            <Num label="Monthly credit cap" min={0} max={10_000_000} value={s.monthlyCreditCap} onChange={(n) => set({ monthlyCreditCap: n })} hint="0 means no cap" />
            <Num label="Daily credit cap" min={0} max={1_000_000} value={s.dailyCreditCap} onChange={(n) => set({ dailyCreditCap: n })} hint="0 means paced from the monthly cap" />
            <Num label="Cycle resets on day" min={1} max={28} value={s.apolloCycleResetDay} onChange={(n) => set({ apolloCycleResetDay: n })} />
          </div>
          <p className="fine" style={{ marginTop: 10 }}>
            At about {view.limits.creditsPerLead} credits per usable lead, your cap supports roughly {n0(view.limits.maxDailyLeads)} new leads a working day.
          </p>
        </div>
      </fieldset>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

const MODES: { value: AutoReplyMode; label: string; desc: string }[] = [
  { value: "OFF", label: "Off", desc: "Drafts are written for you, nothing is sent automatically." },
  { value: "SHADOW", label: "Shadow", desc: "Decisions are logged as if live so you can check them. Nothing is sent." },
  { value: "CANARY", label: "Canary", desc: "Sends only for the campaigns you pick below." },
  { value: "LIVE", label: "Live", desc: "Sends safe replies for every campaign, within the limits below." },
];

function AutoReplies({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const { data: m } = useAutoReplyMetricsQuery();
  const { data: campaigns } = useCampaignsQuery();
  const [kill, killState] = useKillAutoReplyMutation();
  const [release, releaseState] = useReleaseAutoReplyMutation();
  const [confirmKill, setConfirmKill] = useState(false);
  const toast = useToast();
  if (!s) return null;
  return (
    <>
      {s.autoReplyKillSwitch ? (
        <div className="banner bad" role="alert">
          <span>The kill switch is on. No automatic reply will be sent until it is released.</span>
          {canManage ? (
            <Button size="sm" loading={releaseState.isLoading} onClick={() => release().unwrap().then(() => toast("Kill switch released", "good")).catch((e) => toast(errorMessage(e), "bad"))}>
              Release
            </Button>
          ) : null}
        </div>
      ) : null}
      {!view.aiAvailable ? (
        <Notice tone="info" icon="sparkle" title="AI isn't configured on this server">
          Reply sorting, drafts and automatic replies need an AI key on the server.
        </Notice>
      ) : null}
      {m ? (
        <div className="stats4 glass">
          <div className="stat">
            <div className="big num">{n0(m.sent.last7d)}</div>
            <div className="sub">Sent in 7 days · {n0(m.sent.last24h)} today</div>
          </div>
          <div className="stat">
            <div className="big num">{n0(m.queued)}</div>
            <div className="sub">Queued now</div>
          </div>
          <div className="stat">
            <div className="big num">{n0(m.handedOff7d)}</div>
            <div className="sub">Handed to you in 7 days</div>
          </div>
          <div className="stat">
            <div className="big num">{n0(m.meetingsBooked7d)}</div>
            <div className="sub">Meetings booked in 7 days</div>
            {m.negativeAfterAutoReply7d ? <div className="delta down">{m.negativeAfterAutoReply7d} negative after an auto reply</div> : null}
          </div>
        </div>
      ) : null}
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>Mode</h3>
          <SettingRow title="Automatic replies" desc="Answer simple, positive replies for you. Anything unclear, negative or sensitive always comes to you.">
            <Switch label="Automatic replies" checked={s.autoReplyEnabled} onChange={(v) => set({ autoReplyEnabled: v })} disabled={!canManage} />
          </SettingRow>
          <div style={{ marginTop: 14 }}>
            <Seg label="Mode" value={s.autoReplyMode} onChange={(v) => set({ autoReplyMode: v })} options={MODES.map((x) => ({ value: x.value, label: x.label }))} disabled={!canManage} />
            <p className="fine" style={{ marginTop: 8 }}>
              {MODES.find((x) => x.value === s.autoReplyMode)?.desc}
            </p>
          </div>
          {s.autoReplyMode === "CANARY" ? (
            <Field label="Canary campaigns">
              <div className="chips">
                {(campaigns ?? [])
                  .filter((c) => c.status !== "ARCHIVED")
                  .map((c) => {
                    const on = s.autoReplyCanaryCampaigns.includes(c.id);
                    return (
                      <button key={c.id} type="button" className="pill-btn" aria-pressed={on} onClick={() => set({ autoReplyCanaryCampaigns: on ? s.autoReplyCanaryCampaigns.filter((x) => x !== c.id) : [...s.autoReplyCanaryCampaigns, c.id] })}>
                        {c.name}
                      </button>
                    );
                  })}
              </div>
            </Field>
          ) : null}
          <SettingRow title="Short acknowledgements" desc="Allow a brief thank-you for replies that only need one.">
            <Switch label="Short acknowledgements" checked={s.autoReplySoftAck} onChange={(v) => set({ autoReplySoftAck: v })} disabled={!canManage} />
          </SettingRow>
        </div>
        <div className="panel glass">
          <h3>Limits</h3>
          <div className="grid3" style={{ marginTop: 14 }}>
            <TextField label="Minimum confidence" type="number" step={0.01} min={0.5} max={1} value={s.autoReplyMinConfidence} onChange={(e) => set({ autoReplyMinConfidence: Number(e.target.value) })} hint="0.5 to 1" />
            <Num label="Replies a day" min={1} max={500} value={s.autoReplyDailyCap} onChange={(n) => set({ autoReplyDailyCap: n })} />
            <Num label="Automatic sends per thread" min={1} max={10} value={s.autoReplyMaxAutoSends} onChange={(n) => set({ autoReplyMaxAutoSends: n })} />
            <Num label="Max messages in a thread" min={2} max={30} value={s.autoReplyMaxTurns} onChange={(n) => set({ autoReplyMaxTurns: n })} />
            <Num label="Wait before replying (minutes)" min={15} max={1440} value={s.autoReplyThreadGapMinutes} onChange={(n) => set({ autoReplyThreadGapMinutes: n })} />
            <div className="grid2">
              <Num label="From hour" min={6} max={12} value={s.autoReplyWindowStart} onChange={(n) => set({ autoReplyWindowStart: n })} />
              <Num label="To hour" min={13} max={22} value={s.autoReplyWindowEnd} onChange={(n) => set({ autoReplyWindowEnd: n })} />
            </div>
          </div>
        </div>
      </fieldset>
      {m && (m.skipReasons.length || m.escalationReasons.length) ? (
        <div className="grid2">
          <div className="panel glass">
            <h3>
              Why replies weren&apos;t sent<small>last 7 days</small>
            </h3>
            <div className="stack" style={{ marginTop: 12 }}>
              {m.skipReasons.map((r) => (
                <div className="kv" key={String(r.key)}>
                  <span>{titleCase(String(r.key ?? "other"))}</span>
                  <b>{n0(r.count)}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="panel glass">
            <h3>
              Why threads came to you<small>last 7 days</small>
            </h3>
            <div className="stack" style={{ marginTop: 12 }}>
              {m.escalationReasons.map((r) => (
                <div className="kv" key={String(r.key)}>
                  <span>{titleCase(String(r.key ?? "other"))}</span>
                  <b>{n0(r.count)}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {canManage && !s.autoReplyKillSwitch ? (
        <div className="panel glass">
          <h3>Kill switch</h3>
          <p style={{ marginTop: 6 }}>Stops every automatic reply at once and cancels anything queued.</p>
          <Button variant="danger" size="sm" style={{ marginTop: 12 }} onClick={() => setConfirmKill(true)}>
            Stop automatic replies now
          </Button>
        </div>
      ) : null}
      <SaveBar changed={changed} reset={reset} />
      {confirmKill ? (
        <Confirm
          title="Stop all automatic replies?"
          danger
          confirmLabel="Stop now"
          loading={killState.isLoading}
          onClose={() => setConfirmKill(false)}
          onConfirm={() =>
            kill()
              .unwrap()
              .then((r) => {
                setConfirmKill(false);
                toast(`Automatic replies stopped. ${r.cancelled} queued repl${r.cancelled === 1 ? "y" : "ies"} cancelled.`, "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="Mode switches to off and queued replies are cancelled. Drafts keep being written for you to send yourself."
        />
      ) : null}
    </>
  );
}

function Sending({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const params = useSearchParams();
  const { data, isLoading, isError, error, refetch } = useMailboxesQuery(undefined, { skip: !canManage });
  const { data: campaigns } = useCampaignsQuery();
  const [provision, { isLoading: provisioning }] = useProvisionMutation();
  const [picked, setPicked] = useState<number[] | null>(null);
  const [campaignId, setCampaignId] = useState(params.get("campaign") ?? "");
  const toast = useToast();
  const selected = picked ?? data?.attached ?? [];
  if (!s) return null;
  if (!canManage)
    return (
      <Notice tone="info" icon="lock" title="Managers only">
        Only owners and admins can change sending mailboxes.
      </Notice>
    );
  return (
    <>
      <div className="panel glass">
        <h3>
          Mailboxes<small>{data?.connected ? `${data.accounts.length} in your sending account` : ""}</small>
        </h3>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={3} />
        ) : data.accountsError ? (
          <p className="muted" style={{ marginTop: 8 }}>
            {data.accountsError}. The inboxes from your setup are listed below and keep moving along.
          </p>
        ) : !data.connected ? (
          <p style={{ marginTop: 8 }}>Connect Smartlead under Integrations to list your sending mailboxes here.</p>
        ) : !data.accounts.length ? (
          <p style={{ marginTop: 8 }}>Your Smartlead account has no mailboxes yet.</p>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {data.accounts.map((a) => {
              const on = selected.includes(a.id);
              return (
                <label key={a.id} className="kv" style={{ alignItems: "center", cursor: "pointer" }}>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <input type="checkbox" checked={on} onChange={() => setPicked(on ? selected.filter((x) => x !== a.id) : [...selected, a.id])} />
                    <span className="mono">{a.from_email}</span>
                    {a.from_name ? <span className="muted">{a.from_name}</span> : null}
                  </span>
                  <b>{a.warmup ? titleCase(a.warmup) : a.attached ? "attached" : ""}</b>
                </label>
              );
            })}
            <div className="toolbar" style={{ marginTop: 6 }}>
              <select className="select grow" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
                <option value="">Default sending campaign</option>
                {(campaigns ?? [])
                  .filter((c) => c.status !== "ARCHIVED")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <Button
                variant="primary"
                size="sm"
                loading={provisioning}
                disabled={!selected.length}
                onClick={() =>
                  provision({ mailboxIds: selected, campaignId: campaignId || undefined })
                    .unwrap()
                    .then((r) => {
                      setPicked(null);
                      toast(`${r.mailboxes} mailbox${r.mailboxes === 1 ? "" : "es"} connected to sending campaign ${r.smartleadCampaignId}`, "good");
                    })
                    .catch((e) => toast(errorMessage(e), "bad"))
                }
              >
                Connect {selected.length || ""} mailbox{selected.length === 1 ? "" : "es"}
              </Button>
            </div>
          </div>
        )}
      </div>
      {data?.planned.length ? (
        <div className="tbl-wrap glass">
          <div style={{ padding: "18px 20px 6px" }}>
            <h3 style={{ margin: 0, font: "600 17px var(--f-display)" }}>Inboxes from your setup</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
              Created, warmed up and added to your campaign automatically. Sends per inbox rise gently to the daily limit over the first two weeks.
            </p>
          </div>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th className="right">Sends a day</th>
                  <th className="right">Warmup</th>
                </tr>
              </thead>
              <tbody>
                {data.planned.map((m) => (
                  <tr key={m.id}>
                    <td className="mono strong">{m.address}</td>
                    <td className="m">
                      {m.sendingDomain?.name} · {titleCase(m.sendingDomain?.status ?? "")}
                    </td>
                    <td>
                      <Chip tone={BOX_TONE[m.status] ?? "y"}>{BOX_LABEL[m.status] ?? titleCase(m.status)}</Chip>
                      {m.lastError && m.status !== "ACTIVE" ? <div className="m" style={{ marginTop: 4, fontSize: 12.5 }}>{m.lastError}</div> : null}
                    </td>
                    <td className="num-cell">{m.status === "ACTIVE" && m.sendCap ? `${m.sendCap} of ${m.dailyLimit}` : "—"}</td>
                    <td className="num-cell">{m.warmupDays} days</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <div className="panel glass">
        <h3>Per-mailbox limit</h3>
        <div className="grid2" style={{ marginTop: 12 }}>
          <Num label="Emails per mailbox per day" min={1} max={60} value={s.perMailboxDailyCap} onChange={(n) => set({ perMailboxDailyCap: n })} hint="40 or fewer keeps reputation healthy" />
        </div>
      </div>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

const PROVIDERS: { key: Provider; name: string; desc: string; placeholder: string }[] = [
  { key: "APOLLO", name: "Apollo", desc: "Finds and enriches leads that match your campaigns.", placeholder: "Apollo API key" },
  { key: "SMARTLEAD", name: "Smartlead", desc: "Sends your sequences from your mailboxes and reports replies.", placeholder: "Smartlead API key" },
  { key: "MILLIONVERIFIER", name: "MillionVerifier", desc: "Checks every address before it is emailed.", placeholder: "MillionVerifier API key" },
  { key: "SLACK_WEBHOOK", name: "Slack", desc: "Posts new replies and weekly lists to a channel.", placeholder: "https://hooks.slack.com/services/…" },
];

function CredentialRow({ p, status, canManage }: { p: (typeof PROVIDERS)[number]; status?: SettingsView["credentials"][number]; canManage: boolean }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [save, saveState] = useSaveCredentialMutation();
  const [remove, removeState] = useRemoveCredentialMutation();
  const toast = useToast();
  return (
    <div className="setting" style={{ alignItems: "flex-start" }}>
      <div className="t">
        <b>
          {p.name}{" "}
          {status?.source === "organization" ? <Chip tone="g">Connected</Chip> : status?.source === "platform" ? <Chip tone="b">Using platform key</Chip> : <Chip tone="y">Not connected</Chip>}
        </b>
        <small>{p.desc}</small>
        {status?.masked && status.source === "organization" ? <small className="mono">{status.masked}</small> : null}
        {editing ? (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <input className="input sm grow" type="password" autoComplete="off" placeholder={p.placeholder} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${p.name} key`} />
            <Button
              size="sm"
              variant="primary"
              loading={saveState.isLoading}
              disabled={value.trim().length < 8}
              onClick={() =>
                save({ provider: p.key, value: value.trim() })
                  .unwrap()
                  .then(() => {
                    setEditing(false);
                    setValue("");
                    toast(`${p.name} connected`, "good");
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save
            </Button>
            <Button size="sm" variant="text" onClick={() => (setEditing(false), setValue(""))}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
      {canManage && !editing ? (
        <div style={{ display: "flex", gap: 6 }}>
          <Button size="sm" onClick={() => setEditing(true)}>
            {status?.source === "organization" ? "Replace" : "Connect"}
          </Button>
          {status?.source === "organization" ? (
            <Button size="sm" variant="text" loading={removeState.isLoading} onClick={() => remove(p.key).unwrap().then(() => toast(`${p.name} disconnected`, "good")).catch((e) => toast(errorMessage(e), "bad"))}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Integrations({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { data: org } = useOrganizationQuery(undefined, { skip: !canManage });
  const [email, setEmail] = useState("");
  const [verify, verifyState] = useVerifyEmailMutation();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const hooks = org?.webhookToken
    ? [
        ["Smartlead replies and events", `${origin}/api/v1/webhooks/smartlead/${org.webhookToken}`],
        ["Calendly bookings", `${origin}/api/v1/webhooks/calendly/${org.webhookToken}`],
        ["Apollo enrichment", `${origin}/api/v1/webhooks/apollo/${org.webhookToken}`],
      ]
    : [];
  return (
    <>
      <div className="panel glass">
        <h3>
          Connections<small>keys are encrypted at rest</small>
        </h3>
        <div style={{ marginTop: 8 }}>
          {PROVIDERS.map((p) => (
            <CredentialRow key={p.key} p={p} status={view.credentials.find((c) => c.provider === p.key)} canManage={canManage} />
          ))}
        </div>
      </div>
      {canManage && hooks.length ? (
        <div className="panel glass">
          <h3>
            Webhook addresses<small>paste these into each tool, keep them private</small>
          </h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {hooks.map(([l, u]) => (
              <div key={l}>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                  {l}
                </div>
                <div className="toolbar">
                  <code className="code grow">{u}</code>
                  <Button size="xs" onClick={() => navigator.clipboard?.writeText(u)}>
                    Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {canManage ? (
        <div className="panel glass">
          <h3>Test an address</h3>
          <p style={{ marginTop: 6 }}>Runs one live check with your email verifier.</p>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <input className="input sm grow" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to check" />
            <Button size="sm" loading={verifyState.isLoading} disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)} onClick={() => verify({ email }).catch(() => undefined)}>
              Check
            </Button>
          </div>
          {verifyState.data ? (
            <div className={`ok-line ${verifyState.data.ok ? "g" : "w"}`} style={{ marginTop: 12 }}>
              <Icon id={verifyState.data.ok ? "check" : "alert"} />
              <span>
                {titleCase(verifyState.data.result)}
                {verifyState.data.quality ? ` · quality ${verifyState.data.quality}` : ""}
                {verifyState.data.transient ? " · temporary result, try again later" : ""}
              </span>
            </div>
          ) : verifyState.error ? (
            <div className="banner bad" style={{ marginTop: 12 }}>
              {errorMessage(verifyState.error)}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Brand({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const toast = useToast();
  if (!s) return null;
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  return (
    <>
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>Sender</h3>
          <div className="grid2" style={{ marginTop: 14 }}>
            <TextField label="Your name" value={s.senderName ?? ""} maxLength={120} onChange={(e) => set({ senderName: e.target.value || null })} />
            <TextField label="Title" value={s.senderTitle ?? ""} maxLength={120} onChange={(e) => set({ senderTitle: e.target.value || null })} />
            <TextField label="Company" value={s.senderCompany ?? ""} maxLength={160} onChange={(e) => set({ senderCompany: e.target.value || null })} />
            <TextField label="Booking link" type="url" placeholder="https://cal.com/you/intro" value={s.meetingLink ?? ""} maxLength={500} onChange={(e) => set({ meetingLink: e.target.value || null })} hint="Offered to people who ask to talk" />
          </div>
          <div style={{ marginTop: 14 }}>
            <TextField label="Postal address" hint="Shown in the footer where the law asks for one" value={s.senderAddress ?? ""} maxLength={300} onChange={(e) => set({ senderAddress: e.target.value || null })} />
          </div>
        </div>
        <div className="panel glass">
          <h3>What you sell</h3>
          <div className="stack" style={{ marginTop: 14 }}>
            <TextArea label="Value proposition" hint="The one thing every email builds on. Plain words, no claims you can't back up." rows={3} maxLength={600} value={s.valueProp ?? ""} onChange={(e) => set({ valueProp: e.target.value || null })} />
            <TextField label="Opt-out line" hint="Added to the end of first emails" value={s.optOutLine ?? ""} maxLength={300} onChange={(e) => set({ optOutLine: e.target.value || null })} />
          </div>
        </div>
      </fieldset>
      <div className="panel glass">
        <h3>Notifications</h3>
        <SettingRow title="Browser notifications" desc={perm === "denied" ? "Blocked in this browser. Allow notifications for this site in your browser settings." : "Get a desktop notice when a new reply arrives while the app is open."}>
          <Switch
            label="Browser notifications"
            checked={s.browserNotifications}
            disabled={!canManage || perm === "unsupported"}
            onChange={async (v) => {
              if (v && perm === "default") {
                const r = await Notification.requestPermission();
                if (r !== "granted") return toast("Notifications weren't allowed in this browser", "bad");
              }
              set({ browserNotifications: v });
            }}
          />
        </SettingRow>
      </div>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

function Team({ canManage }: { canManage: boolean }) {
  const { data: org } = useOrganizationQuery();
  const { data: members, isLoading, isError, error, refetch } = useMembersQuery();
  const [updateOrg, orgState] = useUpdateOrganizationMutation();
  const [invite, inviteState] = useInviteMutation();
  const [changeRole] = useChangeRoleMutation();
  const [remove, removeState] = useRemoveMemberMutation();
  const [name, setName] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [link, setLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const me = useAppSelector((s) => s.auth.user?.id);
  const toast = useToast();

  return (
    <>
      <div className="panel glass">
        <h3>Organization</h3>
        <div className="toolbar" style={{ marginTop: 14, alignItems: "flex-end" }}>
          <div className="grow">
            <TextField label="Name" value={name ?? org?.name ?? ""} disabled={!canManage} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          {canManage && name !== null && name.trim() && name !== org?.name ? (
            <Button
              variant="primary"
              size="sm"
              loading={orgState.isLoading}
              onClick={() =>
                updateOrg({ name: name.trim() })
                  .unwrap()
                  .then(() => {
                    setName(null);
                    toast("Organization renamed", "good");
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save
            </Button>
          ) : null}
        </div>
        {org ? (
          <p className="fine" style={{ marginTop: 10 }}>
            Main domain {org.primaryDomain ?? "not set"} · created {dateLong(org.createdAt)}
          </p>
        ) : null}
      </div>
      <div className="tbl-wrap glass">
        <div className="toolbar" style={{ padding: "16px 18px" }}>
          <b style={{ font: "600 17px var(--f-display)" }}>Members</b>
          <span className="grow" />
          {canManage ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => (setInviting(true), setLink(null), setInviteEmail(""))}>
              Invite
            </Button>
          ) : null}
        </div>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !members ? (
          <SkeletonRows rows={3} />
        ) : members.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name ?? m.email}</b>
                      <div className="m">{m.email}</div>
                    </td>
                    <td>
                      {canManage && m.userId !== me ? (
                        <select
                          className="select"
                          value={m.role}
                          aria-label="Role"
                          onChange={(e) =>
                            changeRole({ id: m.id, role: e.target.value })
                              .unwrap()
                              .then(() => toast("Role updated", "good"))
                              .catch((er) => toast(errorMessage(er), "bad"))
                          }
                        >
                          <option value="OWNER">Owner</option>
                          <option value="ADMIN">Admin</option>
                          <option value="MEMBER">Member</option>
                        </select>
                      ) : (
                        titleCase(m.role)
                      )}
                    </td>
                    <td>
                      <Chip tone={m.status === "ACTIVE" ? "g" : "y"}>{m.status === "ACTIVE" ? "Active" : "Invited"}</Chip>
                    </td>
                    <td className="m">{m.lastLoginAt ? ago(m.lastLoginAt) : "never"}</td>
                    <td className="right">
                      {canManage && m.userId !== me ? (
                        <Button size="xs" variant="text" onClick={() => setRemoving(m.id)}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="users" title="Just you so far" />
        )}
      </div>
      {inviting ? (
        <Modal
          title="Invite a teammate"
          onClose={() => setInviting(false)}
          actions={
            link ? (
              <Button variant="primary" onClick={() => setInviting(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="text" onClick={() => setInviting(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={inviteState.isLoading}
                  disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)}
                  onClick={() =>
                    invite({ email: inviteEmail.trim(), role: inviteRole })
                      .unwrap()
                      .then((r) => setLink(`${window.location.origin}/invite?token=${encodeURIComponent(r.inviteToken)}`))
                      .catch((e) => toast(errorMessage(e), "bad"))
                  }
                >
                  Create invite
                </Button>
              </>
            )
          }
        >
          {link ? (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>
                Send this link to {inviteEmail}. They sign up or sign in with that email, then accept. It expires in 7 days.
              </p>
              <div className="toolbar">
                <code className="code grow">{link}</code>
                <Button size="xs" onClick={() => navigator.clipboard?.writeText(link)}>
                  Copy
                </Button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <TextField label="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              <Field label="Role" htmlFor="invRole">
                <select id="invRole" className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="MEMBER">Member · can work the inbox and leads</option>
                  <option value="ADMIN">Admin · can also change settings and billing</option>
                  <option value="OWNER">Owner · full control</option>
                </select>
              </Field>
            </div>
          )}
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove this member?"
          danger
          confirmLabel="Remove"
          loading={removeState.isLoading}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            remove(removing)
              .unwrap()
              .then(() => {
                setRemoving(null);
                toast("Member removed", "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="They lose access to this organization right away."
        />
      ) : null}
    </>
  );
}

function Settings() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tab = params.get("tab") ?? "autopilot";
  const { canManage } = useRole();
  const { data: view, isLoading, isError, error, refetch } = useSettingsQuery();
  const [key, setKey] = useState(0);
  useEffect(() => setKey((k) => k + 1), [tab]);

  return (
    <>
      <ViewHead kicker="Settings" title="How Aperture works for you." sub={canManage ? undefined : "You can view these settings. Owners and admins can change them."} />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => router.replace(`${path}?tab=${k}`, { scroll: false })}>
            {l}
          </button>
        ))}
      </div>
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !view ? (
        <SkeletonRows rows={5} h={60} />
      ) : (
        <div className="stack" key={`${tab}-${key}`}>
          {tab === "replies" ? (
            <AutoReplies view={view} canManage={canManage} />
          ) : tab === "sending" ? (
            <Sending view={view} canManage={canManage} />
          ) : tab === "integrations" ? (
            <Integrations view={view} canManage={canManage} />
          ) : tab === "brand" ? (
            <Brand view={view} canManage={canManage} />
          ) : tab === "team" ? (
            <Team canManage={canManage} />
          ) : (
            <Autopilot view={view} canManage={canManage} />
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <Settings />
    </Suspense>
  );
}
