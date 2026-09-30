"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Avatar, Button, Chip, Empty, ErrorState, Pager, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { useToast } from "@/store";
import { errorMessage, useDealClosedMutation, useInboxQuery, useMarkHandledMutation, useRemoveConversationMutation, useReplyMutation, useThreadQuery } from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, dateTime, n0 } from "@/lib/format";

const FILTERS = [
  ["all", "All"],
  ["needs", "Needs reply"],
  ["replied", "Handled"],
  ["sent", "Sent only"],
] as const;

const REPLY_FILTERS = ["urgent", "lead", "hot", "question", "review", "curious", "not_now", "away", "moved", "auto"];

function Thread({ id, onBack, onGone }: { id: string; onBack: () => void; onGone: () => void }) {
  const { data, isLoading, isError, error, refetch } = useThreadQuery(id);
  const [reply, replyState] = useReplyMutation();
  const [handled, handledState] = useMarkHandledMutation();
  const [closed, closedState] = useDealClosedMutation();
  const [remove, removeState] = useRemoveConversationMutation();
  const [body, setBody] = useState("");
  const [ask, setAsk] = useState<"closed" | "remove" | null>(null);
  const toast = useToast();

  useEffect(() => {
    setBody(data?.contact.aiDraft ?? "");
  }, [data?.contact.id, data?.contact.aiDraft]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={4} h={70} />;
  const c = data.contact;
  const needsReply = data.messages.at(-1)?.direction === "INBOUND" && !c.handledAt;

  async function send() {
    try {
      await reply({ id, body }).unwrap();
      toast("Reply sent", "good");
      setBody("");
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  }

  return (
    <>
      <button className="btn btn-text btn-sm back-to-list" type="button" onClick={onBack} style={{ justifySelf: "start" }}>
        <Icon id="back" />
        All conversations
      </button>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          <Avatar name={c.fullName ?? c.email} url={c.photoUrl} size={44} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 17 }}>{c.fullName ?? c.email}</b>
            <div className="muted" style={{ fontSize: 13.5 }}>
              {[c.title, c.company].filter(Boolean).join(" at ")}
              {c.title || c.company ? " · " : ""}
              <span className="mono">{c.email}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {c.replyClass ? <Chip tone={REPLY_TONE[c.replyClass] ?? "v"}>{REPLY_LABEL[c.replyClass] ?? c.replyClass}</Chip> : null}
              {c.replyUrgent ? <Chip tone="r">Urgent</Chip> : null}
              {data.campaign ? <Chip tone="v">{data.campaign.name}</Chip> : null}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {needsReply ? (
            <Button size="sm" loading={handledState.isLoading} onClick={() => handled(id).unwrap().then(() => toast("Marked as handled", "good")).catch((e) => toast(errorMessage(e), "bad"))}>
              Mark handled
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setAsk("closed")}>
            Deal closed
          </Button>
          <Button size="sm" variant="danger" onClick={() => setAsk("remove")}>
            Remove
          </Button>
        </div>
      </div>

      {data.autoReply ? (
        <div className="banner info">
          <span>
            An automatic reply is queued for {dateTime(data.autoReply.sendAfter)}
            {data.autoReply.willSend ? "." : ` but auto-reply is in ${data.autoReply.mode.toLowerCase()} mode, so it won't be sent.`} Replying yourself cancels it.
          </span>
        </div>
      ) : null}

      <div className="stack">
        {data.messages.map((m) => (
          <div key={m.id} className={`msg${m.direction === "OUTBOUND" ? " out" : ""}`}>
            <div className="meta">
              <span>
                <b>{m.direction === "OUTBOUND" ? (m.via === "auto-reply" ? "Automatic reply" : data.email.fromName ?? "You") : c.fullName ?? c.email}</b>
                {m.subject ? ` · ${m.subject}` : ""}
              </span>
              <span>{dateTime(m.createdAt)}</span>
            </div>
            <div className="body" dir="auto">
              {m.body}
            </div>
            {m.attachments.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {m.attachments.map((a) => (
                  <a key={a.url} className="btn btn-ghost btn-xs" href={a.url} target="_blank" rel="noopener noreferrer">
                    <Icon id="download" />
                    {a.name}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="panel glass">
        <h3>
          Your reply<small>{c.aiDraft ? "a suggested draft is filled in, edit freely" : "sent from the inbox that emailed them"}</small>
        </h3>
        <label className="sr" htmlFor="replyBody">
          Reply
        </label>
        <textarea id="replyBody" dir="auto" className="input" rows={7} style={{ marginTop: 12 }} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} placeholder="Write your reply" />
        {data.email.signature ? (
          <div className="code" dir="auto" style={{ marginTop: 10 }}>
            {data.email.signature}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <Button variant="primary" icon="plane" loading={replyState.isLoading} disabled={!body.trim()} onClick={send}>
            Send reply
          </Button>
        </div>
      </div>

      {ask === "closed" ? (
        <Confirm
          title="Mark this deal as closed?"
          confirmLabel="Deal closed"
          loading={closedState.isLoading}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            closed(id)
              .unwrap()
              .then((r) => {
                setAsk(null);
                toast(`${r.name} marked as a closed deal and won't be emailed again`, "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="They become a customer on your blocklist, so outreach never contacts them again."
        />
      ) : null}
      {ask === "remove" ? (
        <Confirm
          title="Remove this conversation?"
          danger
          confirmLabel="Remove and block"
          loading={removeState.isLoading}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            remove(id)
              .unwrap()
              .then((r) => {
                setAsk(null);
                toast(`${r.name} removed and ${r.blocked} blocked`, "good");
                onGone();
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="The conversation leaves your inbox and the address is added to your blocklist. You can restore it from the blocklist."
        />
      ) : null}
    </>
  );
}

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const filter = params.get("filter") ?? "all";
  const reply = params.get("reply") ?? undefined;
  const page = Number(params.get("page") ?? 1) || 1;
  const selected = params.get("c");
  const { data, isLoading, isFetching, isError, error, refetch } = useInboxQuery({ filter, reply, page }, { pollingInterval: 60_000, skipPollingIfUnfocused: true });

  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    router.replace(`${path}?${p.toString()}`, { scroll: false });
  };

  const counts = data?.meta.counts;

  return (
    <>
      <ViewHead kicker="Inbox" title="Conversations." sub="Every reply to your outreach, sorted so the ones that need you come first." />
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Filter conversations">
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setParam({ filter: k, page: null })}>
              {l}
              {counts ? <span className={`badge-n${k === "needs" && counts.needs ? "" : " muted"}`}>{n0(counts[k])}</span> : null}
            </button>
          ))}
        </div>
        <select className="select" value={reply ?? ""} onChange={(e) => setParam({ reply: e.target.value || null, page: null })} aria-label="Reply type">
          <option value="">All reply types</option>
          {REPLY_FILTERS.map((r) => (
            <option key={r} value={r}>
              {r === "urgent" ? "Urgent" : r === "lead" ? "Leads (interested)" : REPLY_LABEL[r] ?? r}
              {counts && r !== "urgent" && r !== "lead" && counts.byClass[r] ? ` (${counts.byClass[r]})` : r === "urgent" && counts?.urgent ? ` (${counts.urgent})` : ""}
            </option>
          ))}
        </select>
        {isFetching && !isLoading ? <span className="spinner" style={{ borderColor: "rgba(255,240,220,.2)", borderTopColor: "var(--gold)" }} /> : null}
      </div>

      <div className={`inbox-grid${selected ? " has-thread" : ""}`}>
        <div className="inbox-list glass">
          {isError ? (
            <ErrorState error={error} onRetry={refetch} />
          ) : isLoading || !data ? (
            <SkeletonRows rows={7} h={58} />
          ) : !data.data.length ? (
            <Empty icon="inbox" title={filter === "needs" ? "You're all caught up" : "No conversations here"}>
              {filter === "needs" ? "Nobody is waiting on a reply from you." : "Conversations appear once emails go out and people answer."}
            </Empty>
          ) : (
            <>
              {data.data.map((r) => (
                <button key={r.id} type="button" className="list-row" aria-current={selected === r.id} onClick={() => setParam({ c: r.id })}>
                  <Avatar name={r.fullName ?? r.email} url={r.photoUrl} />
                  <div style={{ minWidth: 0 }}>
                    <div className="who">
                      {r.needsReply ? <span className="unread" aria-label="Needs reply" /> : null}
                      <b>{r.fullName ?? r.email}</b>
                      {r.company ? <span className="co">{r.company}</span> : null}
                    </div>
                    <p dir="auto">
                      {r.lastMessageDirection === "OUTBOUND" ? "You: " : ""}
                      {r.lastMessagePreview}
                    </p>
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {r.replyUrgent ? <span className="chip-s r">Urgent</span> : null}
                      {r.replyClass ? <span className={`chip-s ${REPLY_TONE[r.replyClass] ?? "v"}`}>{REPLY_LABEL[r.replyClass] ?? r.replyClass}</span> : null}
                      {r.hasDraft ? <span className="chip-s b">Draft ready</span> : null}
                    </div>
                  </div>
                  <span className="when">{ago(r.lastMessageAt)}</span>
                </button>
              ))}
              <Pager page={page} limit={data.meta.limit ?? 30} total={data.meta.total ?? 0} onPage={(p) => setParam({ page: String(p) })} />
            </>
          )}
        </div>
        <div className="inbox-thread glass">
          {selected ? (
            <Thread key={selected} id={selected} onBack={() => setParam({ c: null })} onGone={() => setParam({ c: null })} />
          ) : (
            <Empty icon="inbox" title="Pick a conversation">
              The full thread, a suggested reply and actions show up here.
            </Empty>
          )}
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <Inbox />
    </Suspense>
  );
}
