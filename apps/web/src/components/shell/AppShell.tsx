"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { useAppDispatch, useAppSelector, useToast } from "@/store";
import { api, errorMessage, refreshSession, useNavCountsQuery, usePortalMutation } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { useSignOut } from "./session";
import { NoWorkspace } from "./NoWorkspace";
import type { NavCounts } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: IconId;
  badge?: (c: NavCounts) => { n: number; tone?: "muted" | "bad" } | null;
}

const MAIN: NavItem[] = [
  { href: "/app", label: "Cockpit", icon: "home" },
  { href: "/app/inbox", label: "Inbox", icon: "inbox", badge: (c) => (c.inboxAwaiting ? { n: c.inboxAwaiting } : null) },
  { href: "/app/leads", label: "Leads", icon: "users", badge: (c) => (c.leadsPending ? { n: c.leadsPending } : null) },
  { href: "/app/campaigns", label: "Campaigns", icon: "target", badge: (c) => (c.activeCampaigns ? { n: c.activeCampaigns, tone: "muted" } : null) },
  { href: "/app/blocklist", label: "Blocklist", icon: "ban", badge: (c) => (c.blocklist ? { n: c.blocklist, tone: "muted" } : null) },
];

const WORKSPACE: NavItem[] = [
  { href: "/app/settings", label: "Settings", icon: "gear" },
  { href: "/app/billing", label: "Billing", icon: "card" },
  { href: "/app/system", label: "System", icon: "pulse", badge: (c) => (c.systemAlerts ? { n: c.systemAlerts, tone: "bad" } : null) },
];

function isActive(path: string, href: string) {
  return href === "/app" ? path === "/app" : path === href || path.startsWith(`${href}/`);
}

function useReplyNotifications(counts: NavCounts | undefined) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!counts?.browserNotifications || !counts.latestReplyAt || typeof Notification === "undefined") return;
    if (last.current && counts.latestReplyAt > last.current && Notification.permission === "granted") {
      new Notification("New reply in Aperture", { body: `${counts.inboxAwaiting} conversation${counts.inboxAwaiting === 1 ? "" : "s"} waiting for you`, tag: "ap-reply" });
    }
    last.current = counts.latestReplyAt;
  }, [counts?.browserNotifications, counts?.latestReplyAt, counts?.inboxAwaiting]);
}

function SubscriptionBanner({ status }: { status: NavCounts["subscriptionStatus"] }) {
  const [portal, { isLoading }] = usePortalMutation();
  const toast = useToast();
  if (status === "ACTIVE" || status === "TRIALING") return null;
  if (status === "PAST_DUE" || status === "UNPAID")
    return (
      <div className="banner bad" role="alert">
        <span>Your last payment failed. Sending pauses if the card isn&apos;t updated.</span>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          disabled={isLoading}
          onClick={() =>
            portal()
              .unwrap()
              .then((r) => (window.location.href = r.url))
              .catch((e) => toast(errorMessage(e), "bad"))
          }
        >
          Update card
        </button>
      </div>
    );
  return (
    <div className="banner info">
      <span>{status === "CANCELED" ? "Your subscription has ended. Pick a plan to start sending again." : "Finish setup to choose a plan and start sending."}</span>
      <Link className="btn btn-sm btn-primary" href="/onboarding">
        {status === "CANCELED" ? "Choose a plan" : "Finish setup"}
      </Link>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { user, organizations, activeOrgId } = useAppSelector((s) => s.auth);
  const org = organizations.find((o) => o.id === activeOrgId) ?? null;
  const noOrg = organizations.length === 0;
  const { data: counts } = useNavCountsQuery(undefined, { pollingInterval: 60_000, skipPollingIfUnfocused: true, skip: noOrg });
  const [open, setOpen] = useState(false);
  const signOut = useSignOut();
  useReplyNotifications(counts);

  useEffect(() => setOpen(false), [path]);

  async function switchOrg(id: string) {
    const s = await refreshSession(id);
    if (s) {
      dispatch(sessionReceived(s));
      dispatch(api.util.resetApiState());
      router.push("/app");
    }
  }

  const renderItem = (it: NavItem) => {
    const b = counts && it.badge ? it.badge(counts) : null;
    const on = isActive(path, it.href);
    return (
      <li key={it.href} className={on ? "cur" : ""}>
        <Link href={it.href} aria-current={on ? "page" : undefined}>
          <Icon id={it.icon} className="nav-ic" />
          {it.label}
          {b ? <span className={`badge-n${b.tone ? ` ${b.tone}` : ""}`}>{b.n > 999 ? "999+" : b.n}</span> : null}
        </Link>
      </li>
    );
  };

  return (
    <div className="shell-bg" style={{ minHeight: "100vh" }}>
      <div className="ob no-aside">
        <aside className={`rail glass${open ? " open" : ""}`} aria-label="Main navigation">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Link className="logo" href="/app">
              <Mark />
              Aperture
            </Link>
            {open ? (
              <button className="btn btn-text btn-xs hide-lg" type="button" onClick={() => setOpen(false)} aria-label="Close menu">
                <Icon id="x" />
              </button>
            ) : null}
          </div>
          <div className="rail-dom">
            <span className="fav">{(org?.name ?? "A").charAt(0).toUpperCase()}</span>
            <div>
              <b>{org?.primaryDomain ?? org?.name ?? "Workspace"}</b>
              <small className={counts?.autopilotEnabled ? "" : "muted"}>
                <Icon id={counts?.autopilotEnabled ? "check" : "power"} />
                {counts ? (counts.autopilotEnabled ? "Autopilot on" : "Autopilot off") : "Loading"}
              </small>
            </div>
          </div>
          {organizations.length > 1 ? (
            <select className="input sm" style={{ marginTop: 10 }} value={activeOrgId ?? ""} onChange={(e) => switchOrg(e.target.value)} aria-label="Switch organization">
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : null}
          <ol className="steps">{MAIN.map(renderItem)}</ol>
          <div className="rail-sec">Workspace</div>
          <ol className="steps" style={{ marginTop: 4 }}>
            {WORKSPACE.map(renderItem)}
            {user?.isPlatformAdmin ? renderItem({ href: "/admin", label: "Admin console", icon: "shield" }) : null}
          </ol>
          <div className="rail-foot">
            <div className="kv">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name ?? user?.email}</span>
              <b>{org?.role.toLowerCase()}</b>
            </div>
            <button className="btn btn-ghost btn-sm" type="button" onClick={signOut}>
              <Icon id="logout" />
              Sign out
            </button>
          </div>
        </aside>

        <div className="ob-main">
          <div className="rail-mob glass">
            <div className="rm-top">
              <Link className="logo" href="/app">
                <Mark />
                Aperture
              </Link>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(true)} aria-label="Open menu">
                <Icon id="menu" />
                Menu
                {counts?.inboxAwaiting ? <span className="badge-n" style={{ marginLeft: 4 }}>{counts.inboxAwaiting}</span> : null}
              </button>
            </div>
          </div>
          <main className="ob-view tight app-view">
            {counts ? <SubscriptionBanner status={counts.subscriptionStatus} /> : null}
            {noOrg ? <NoWorkspace /> : children}
          </main>
        </div>
      </div>
    </div>
  );
}
