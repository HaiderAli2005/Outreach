"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { FullPageLoader } from "@/components/shell/session";
import { useAppDispatch } from "@/store";
import { sessionReceived } from "@/store/authSlice";
import { errorMessage, useConfirmEmailMutation } from "@/store/api";

function Verify() {
  const params = useSearchParams();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [confirm] = useConfirmEmailMutation();
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const started = useRef(false);
  const token = params.get("token") ?? "";
  const n = params.get("n") ?? undefined;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setState("failed");
      setMessage("This link is missing its code. Open it again from the email.");
      return;
    }
    confirm({ token, n })
      .unwrap()
      .then((session) => {
        dispatch(sessionReceived(session));
        setState("done");
      })
      .catch((e) => {
        const details = (e as { data?: { error?: { details?: { reason?: string; attemptsLeft?: number } } } })?.data?.error?.details;
        if (details?.reason === "wrong_number") setTriesLeft(details.attemptsLeft ?? 0);
        setState("failed");
        setMessage(errorMessage(e));
      });
  }, [token, n, confirm, dispatch]);

  return (
    <AuthFrame>
      <div className="au-step">
        {state === "working" ? (
          <>
            <h1 className="au-h">Confirming your email</h1>
            <p className="nm-wait" style={{ justifyContent: "flex-start", marginTop: 16 }}>
              <span className="au-spin" />
              One moment
            </p>
          </>
        ) : state === "done" ? (
          <>
            <h1 className="au-h">Email confirmed</h1>
            <p className="au-p">{n ? "That's it. The screen where you signed up carries on by itself, so you can close this page." : "Your email is confirmed and you're signed in on this device."}</p>
            <button type="button" className="au-btn" style={{ marginTop: 24 }} onClick={() => router.replace("/onboarding")}>
              Continue here
            </button>
          </>
        ) : (
          <>
            <h1 className="au-h">{triesLeft ? "Not that number" : "We couldn't confirm that"}</h1>
            <p className="au-p">{message}</p>
            {triesLeft ? (
              <p className="au-p">
                Go back to the email and tap the other number. {triesLeft === 1 ? "1 try left." : `${triesLeft} tries left.`}
              </p>
            ) : (
              <>
                <p className="au-p">Sign in and we&apos;ll send you a new email.</p>
                <Link className="au-btn" href="/signin" style={{ marginTop: 24 }}>
                  Sign in
                </Link>
              </>
            )}
          </>
        )}
      </div>
    </AuthFrame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Verify />
    </Suspense>
  );
}
