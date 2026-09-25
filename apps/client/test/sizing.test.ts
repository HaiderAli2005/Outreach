import { describe, expect, it } from "vitest";
import { addressesFor, autoPick, campaignPerDay, planFor, planRows, recDomains, recInboxes, recommendedVolume, schedule, totals, warmChart } from "@/components/onboarding/sizing";
import { catalogue } from "./fixtures";

describe("sizing", () => {
  it("picks the smallest plan that covers the volume", () => {
    expect(planFor(catalogue, 250).id).toBe("launch");
    expect(planFor(catalogue, 500).id).toBe("launch");
    expect(planFor(catalogue, 501).id).toBe("growth");
    expect(planFor(catalogue, 9000).id).toBe("scale");
  });

  it("sizes inboxes and domains from 40 sends per warm inbox", () => {
    expect(recInboxes(catalogue, 1000)).toBe(25);
    expect(recDomains(catalogue, 1000, 3)).toBe(9);
    expect(recDomains(catalogue, 1000, 0)).toBe(25);
  });

  it("totals the first payment and monthly price from real catalogue prices", () => {
    const t = totals(catalogue, 1000, ["getnorthwind.com", "trynorthwind.com"], { "trynorthwind.com": 2 }, 3, { "getnorthwind.com": 1499, "trynorthwind.com": 1499 }, false);
    expect(t.inboxes).toBe(5);
    expect(t.plan.id).toBe("growth");
    expect(t.monthlyCents).toBe(19900 + 5 * 400);
    expect(t.dueCents).toBe(19900 + 5 * 400 + 2998);
    expect(t.capacity).toBe(200);
  });

  it("returns no price for fast start when it isn't configured", () => {
    const t = totals(catalogue, 1000, ["getnorthwind.com"], {}, 3, { "getnorthwind.com": 1499 }, true);
    expect(t.inboxPriceCents).toBeNull();
    expect(t.monthlyCents).toBeNull();
    expect(t.dueCents).toBeNull();
  });

  it("schedules standard warmup and fast start", () => {
    expect(schedule(catalogue, 14, false)).toEqual({ first: 14, full: 28, lo: 10, hi: 15 });
    expect(schedule(catalogue, 21, false)).toEqual({ first: 21, full: 35, lo: 10, hi: 15 });
    expect(schedule(catalogue, 14, true)).toEqual({ first: 3, full: 10, lo: 15, hi: 20 });
  });

  it("sends nothing during warmup and ramps to full volume", () => {
    const k = schedule(catalogue, 14, false);
    expect(campaignPerDay(27, 40, k, 1)).toBe(0);
    expect(campaignPerDay(27, 40, k, 13)).toBe(0);
    expect(campaignPerDay(27, 40, k, 14)).toBe(Math.round(27 * 12.5));
    expect(campaignPerDay(27, 40, k, 28)).toBe(1080);
    expect(campaignPerDay(27, 40, k, 40)).toBe(1080);
  });

  it("rotates sender names and address forms across domains", () => {
    const senders = [{ first: "Alex", last: "Morgan" }];
    expect(addressesFor("getnorthwind.com", senders, 3, 0).map((a) => a.address)).toEqual(["alex@getnorthwind.com", "alex.m@getnorthwind.com", "alexm@getnorthwind.com"]);
    expect(addressesFor("northwindhq.com", senders, 2, 1).map((a) => a.address)).toEqual(["a.morgan@northwindhq.com", "alex.morgan@northwindhq.com"]);
    const two = addressesFor("x.com", [{ first: "Alex", last: "Morgan" }, { first: "Sam", last: "Lee" }], 4, 0);
    expect(two.map((a) => a.sender.first)).toEqual(["Alex", "Sam", "Alex", "Sam"]);
    expect(new Set(two.map((a) => a.address)).size).toBe(4);
    expect(addressesFor("x.com", [], 1, 0)[0].address).toBe("hello@x.com");
  });

  it("skips taken domains when picking automatically", () => {
    const ideas = [
      { name: "a.com", prefix: "", suffix: "", priceCents: 1499, available: false },
      { name: "b.com", prefix: "", suffix: "", priceCents: 1499, available: true },
      { name: "c.com", prefix: "", suffix: "", priceCents: 1499, available: null },
      { name: "d.com", prefix: "", suffix: "", priceCents: 1499, available: true },
    ];
    expect(autoPick(ideas, 2)).toEqual(["b.com", "c.com"]);
  });

  it("recommends the fastest pace that leaves three months of people", () => {
    expect(recommendedVolume(null)).toBeNull();
    expect(recommendedVolume(30_000)).toBe(1000);
    expect(recommendedVolume(1_000)).toBe(250);
    expect(planRows(null).every((r) => r.months === null)).toBe(true);
  });

  it("draws a chart that labels the first emails and full volume", () => {
    const { svg, days } = warmChart(27, 40, 1000, schedule(catalogue, 14, false), false, 640);
    expect(days).toBe(35);
    expect(svg).toContain("First emails");
    expect(svg).toContain("Full volume");
    expect(svg).toContain("Warmup only");
    expect(svg).toContain("No campaign emails until day 14");
  });
});
