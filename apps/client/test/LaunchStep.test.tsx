import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { LaunchStep } from "@/components/onboarding/LaunchStep";
import { totals } from "@/components/onboarding/sizing";
import type { Mailbox, OnboardingState, SendingDomain } from "@/lib/types";
import { catalogue, json, onboardingState } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

afterEach(() => vi.unstubAllGlobals());

const domain = (name: string, status: SendingDomain["status"]): SendingDomain => ({ id: name, name, priceCents: 1499, status, forwardTo: "northwind.io" });
const box = (address: string, status: Mailbox["status"]): Mailbox => ({ id: address, sendingDomainId: null, address, provider: "google", status, warmupDays: 14, dailyLimit: 40 });
const draft = { volume: 1000, picks: [], per: {}, warmupDays: 14, inboxesPerDomain: 3, fastStart: false, senders: [] } as never;

function show(state: OnboardingState) {
  const t = totals(catalogue, 1000, state.domains.map((d) => d.name), {}, 3, {}, false);
  return renderWithStore(<LaunchStep state={state} cat={catalogue} t={t} draft={draft} market={undefined} onOpenApp={vi.fn()} />);
}

describe("LaunchStep", () => {
  it("waits for payment and does not launch", async () => {
    const { fetchMock } = mockServer({});
    show(onboardingState({ domains: [domain("getnorthwind.com", "SELECTED")] }));
    expect(screen.getByRole("heading", { name: "Waiting for payment" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("launches once after payment and reports what is still missing", async () => {
    const { calls } = mockServer({
      "POST /onboarding/launch": () => json({ data: { campaignId: "c1", provisioned: null, missing: ["Connect Smartlead in Settings to start sending."], state: onboardingState() } }),
    });
    const state = onboardingState({
      subscription: { status: "ACTIVE", planId: "growth" },
      domains: [domain("getnorthwind.com", "PENDING_REGISTRATION"), domain("trynorthwind.com", "PENDING_REGISTRATION")],
      mailboxes: [box("alex@getnorthwind.com", "PENDING")],
    });
    const { rerender } = show(state);
    expect(screen.getByRole("heading", { name: "Setting up your sending" })).toBeInTheDocument();
    expect(screen.getByText("2 queued for registration")).toBeInTheDocument();
    expect(await screen.findByText("Connect Smartlead in Settings to start sending.")).toBeInTheDocument();
    rerender(<LaunchStep state={state} cat={catalogue} t={totals(catalogue, 1000, [], {}, 3, {}, false)} draft={draft} market={undefined} onOpenApp={vi.fn()} />);
    await waitFor(() => expect(calls.filter((c) => c.path === "/onboarding/launch")).toHaveLength(1));
  });

  it("shows sending once every inbox is active", () => {
    mockServer({});
    const state = onboardingState({
      subscription: { status: "ACTIVE", planId: "growth" },
      domains: [domain("getnorthwind.com", "REGISTERED")],
      mailboxes: [box("alex@getnorthwind.com", "ACTIVE"), box("alex.m@getnorthwind.com", "ACTIVE")],
      onboarding: { ...onboardingState().onboarding!, launchedAt: new Date().toISOString(), paidAt: new Date().toISOString() },
    });
    show(state);
    expect(screen.getByRole("heading", { name: "Your campaign is sending" })).toBeInTheDocument();
    expect(screen.getByText("4 of 5 done", { exact: false })).toBeInTheDocument();
  });
});
