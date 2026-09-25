# Polish the live onboarding: one thing at a time, with air

## Context

The live analysis workspace is built and working. The problem is density and pacing, not
features. Today the centre column stacks every section at once: fetched pages, extracted
signals, facts, audience cards, counts, companies, plus a third column with the email. The
result is a wall. The reference experience (AutoGTM by Explee) does the same work and feels
calm, because the centre only ever holds ONE thing.

Nothing about the pipeline, the data or the steps changes. This is presentation only.

## The governing rule

> The centre shows only the phase that is running.
> Everything already finished lives in the left rail, nowhere else.
> Everything not yet started is not on screen at all.

If a section is in the rail, it must not also be in the centre.

---

## 1. Turn the centre into a phase machine

Replace the stacked list of sections with a single stage that swaps content per phase.

| Phase | The ONLY thing in the centre | Docks to the rail as |
|---|---|---|
| `reading` | The domain chip and a short "reading your site" state with the pages ticking off | folded into the business card |
| `business` | One large business card: name, domain, one-liner, offerings, country and language chips, proof lines with their source chips | "Your business" with the one-liner |
| `audiences` | Audience cards appearing one at a time: icon, name, why they buy, 2 to 4 pain lines, keyword chips | "Your buyers" listing the audience names |
| `market` | The counts: total and reachable per audience, then the three breakdown bars | "Your market" with both numbers |
| `companies` | The companies table filling row by row | folded into "Your market" |
| `people` | The people table filling row by row, masked | folded into "Your market" |
| `emails` | Lead column on the left of the centre, email pane on the right | "Sample sequence" |

Each phase gets a **minimum dwell time of 1.2 seconds** even when the data arrives instantly, so
nothing flashes past. If a phase has no data (no competitors found, for example) skip it
entirely rather than showing an empty card.

Put the phase in the URL, for example `/onboarding?phase=audiences`. It makes the run
resumable, shareable and far easier to test.

---

## 2. Skeleton first, never reflow

Before a phase has data, render its shape as skeletons: the same card and row geometry in a
muted fill, with a slow shimmer. Items then replace their skeleton in place.

- Campaign and audience cards: show the next two as skeletons while the first is written.
- Tables: reserve six to eight skeleton rows, then fill them.
- The email pane: show the message frame with skeleton lines before the first token arrives.

The page must never change height because content arrived.

---

## 3. Motion, with exact values

| Moment | Spec |
|---|---|
| Item arrives | opacity 0 to 1, translateY 8px to 0, 200ms, ease-out |
| Stagger between items | 60ms, capped so a long list finishes inside 1.2s |
| Trailing rows | the last three arriving rows sit at 70%, 50%, 30% opacity, then settle to full |
| Numbers | roll from 0 to value over 600ms, tabular figures |
| Bars | grow from scaleX(0) over 700ms, ease-out |
| Dock to rail | FLIP: the centre card scales to about 0.35 and translates into its rail slot over 420ms, ease-out, then the rail card fades in and the centre unmounts |
| Tick on the rail card | stroke draws over 200ms, starting 200ms after it lands |
| Phase swap | outgoing fades out over 140ms, incoming starts 60ms later. Never cross-fade two panels in the same space |
| Typing | 40 characters per second, blinking caret, hard cap 6 seconds then reveal the rest |
| Reduced motion | no flying, no typing, no shimmer. Items appear, rail cards fade in over 120ms |

---

## 4. Give the centre air

The current styling is tight and hairlined everywhere, which reads as busy even when the
content is correct.

- Centre content max width 840px, centred, with 28px between blocks.
- Card padding 24px, not 20px. Row height 44px minimum in tables.
- Drop the alternating row stripes. Separate rows with space and one hairline, not fills.
- Raise the one thing that matters per phase: the phase headline at 28 to 32px, the key number
  at 40px or more. Everything supporting stays at 13 to 14px.
- One accent colour, used for the current phase and the primary action only. Ticks are the
  success colour. Warnings are amber. Nothing else is coloured.
- Remove the hairline outline from cards nested inside cards. Use background separation instead.

---

## 5. The rail is the memory

Keep what exists and tighten it:

- Each finished phase is one card: icon, title, one line of detail, tick, chevron to expand.
- Expanded state holds the detail that used to be in the centre: the competitor chips with
  favicons, the audience list with counts, the fact list with sources.
- The audience list is selectable, and selecting one filters the centre.
- The live log stays pinned at the bottom: a pulsing dot, the step count, up to four lines,
  ticks on finished lines and a caret on the running one.
- The running total sits under the log from the volume step onward, and stays visible.

---

## 6. The email phase

Three states in order, all visible as they happen:

1. **Finding the address.** The lead card shows our resolution steps as small chips filling left
   to right: pending outline, then solid with a tick, or muted with a dash for a miss. The
   result line is monospace: `sarah@glowskin.co.uk · verified`, or `no email found` in muted
   text. Before payment the address is masked.
2. **Frame.** The email pane renders To, Subject and an empty body as skeleton lines.
3. **Writing.** To fills, then the subject types with a caret, then the body types. The primary
   action appears only when the body is finished.

Lead cards accept and reject with a tick and a cross, and a rejected card collapses with an undo
toast.

---

## 7. The value bar

Do not show it on the first screen. It appears once there is something worth buying, which is
when the market numbers land, and it stays from there to payment. Content stays factual: what
they get, three short proofs, one primary action.

No countdown timers, no "spots left", no urgency devices of any kind. The reference product uses
them and they cheapen a product people are about to trust with their sending reputation.

---

## 8. Cut list

Remove from the centre entirely:

- The fetched pages list with word counts. This is debug output. Put the page count in the
  business rail card and nothing more.
- The raw extracted signals table (country, currency, language as key and value rows). Fold
  country and language into chips on the business card.
- Any section for a phase that has already docked to the rail.
- The repairs list, if it is currently rendered anywhere in the customer-facing flow. It belongs
  in the admin or system view.

---

## 9. Acceptance checks

1. At any moment during a run, the centre column contains exactly one phase panel.
2. Nothing on screen jumps or resizes when data arrives.
3. A full run from domain to sample emails reads as a sequence of six calm screens, not one long
   scrolling page.
4. With `prefers-reduced-motion` on, every phase still completes and nothing animates.
5. At 1280px, 900px and 390px wide, no horizontal scroll and no overlapping panels.
6. Reloading mid-run resumes at the same phase and continues.
7. A phase with no data is skipped, not shown empty.
