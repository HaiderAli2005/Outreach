"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { useAppDispatch } from "@/store";
import { errorMessage, useLoginMutation, useProvidersQuery, useRegisterMutation } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { needsVerification, type Session, type Verification } from "@/lib/types";
import { NumberMatch } from "@/components/auth/NumberMatch";

function strength(v: string): number {
  if (!v) return 0;
  if (v.length < 8) return 1;
  if ((/[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v)) || v.length >= 14) return 3;
  return /[0-9]|[^A-Za-z0-9]/.test(v) ? 2 : 1;
}

const HINTS = ["Use 8 or more characters, with a number or symbol.", "Too short. Use at least 8 characters.", "Good. Add a symbol to make it stronger.", "Strong password."];

export function AuthCard({
  mode,
  onMode,
  domain,
  next,
  onDone,
  changeHref = "/",
}: {
  mode: "up" | "in";
  onMode: (m: "up" | "in") => void;
  domain?: string;
  next: string;
  onDone: (s: Session) => void;
  changeHref?: string;
}) {
  const dispatch = useAppDispatch();
  const { data: providers } = useProvidersQuery();
  const [login, loginState] = useLoginMutation();
  const [register, registerState] = useRegisterMutation();
  const [stage, setStage] = useState<"email" | "details">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ msg: string; field?: string } | null>(null);
  const [pending, setPending] = useState<Verification | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const up = mode === "up";
  const busy = loginState.isLoading || registerState.isLoading;
  const s = strength(password);

  useEffect(() => {
    const t = setTimeout(() => firstRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [stage, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (stage === "email") {
      const v = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return setErr({ msg: v ? "That email doesn't look right. Check it for typos." : "Enter your work email to continue.", field: "email" });
      setEmail(v);
      setStage("details");
      return;
    }
    if (up && !name.trim()) return setErr({ msg: "Enter your full name.", field: "name" });
    if (up && password.length < 8) return setErr({ msg: "Use at least 8 characters for your password.", field: "password" });
    if (!up && !password) return setErr({ msg: "Enter your password.", field: "password" });
    try {
      const result = up ? await register({ name: name.trim(), email, password, domain }).unwrap() : await login({ email, password }).unwrap();
      if (needsVerification(result)) return setPending(result.verification);
      dispatch(sessionReceived(result));
      onDone(result);
    } catch (e2) {
      setErr({ msg: errorMessage(e2) });
    }
  }

  const bad = (f: string) => (err?.field === f ? " bad" : "");

  if (pending)
    return (
      <div className="au-page">
        <div className="au-shell">
          <section className="au-col">
            <NumberMatch
              purpose="VERIFY"
              email={pending.email ?? email}
              verification={pending}
              onSession={onDone}
              onSignIn={() => (setPending(null), setPassword(""), onMode("in"), setStage("details"))}
            />
          </section>
        </div>
        <p className="au-legal">Nothing is sent from your account until your email is confirmed.</p>
      </div>
    );

  return (
    <div className="au-page">
      <div className="au-shell">
        <section className="au-col">
          {domain ? (
            <div className="au-dom">
              <span className="au-fav">{domain.charAt(0).toUpperCase()}</span>
              <span className="au-dn">{domain}</span>
              <Link className="au-link" href={changeHref}>
                Change
              </Link>
            </div>
          ) : null}
          <h1 className="au-h">{up ? "Create your account" : "Welcome back"}</h1>
          <p className="au-p">
            {up ? (
              domain ? (
                <>
                  Your free analysis of <b>{domain}</b> starts the moment you&apos;re in.
                </>
              ) : (
                "Free to start. No card needed until you choose a plan."
              )
            ) : domain ? (
              <>
                Sign in to continue with <b>{domain}</b>.
              </>
            ) : (
              "Sign in to pick up where you left off."
            )}
          </p>
          <div className="au-step" key={`${stage}-${mode}`}>
            {stage === "email" ? (
              <>
                {providers?.google ? (
                  <>
                    <div className="au-oauth" style={{ gridTemplateColumns: "1fr" }}>
                      <a className="au-sso" href={`/api/v1/auth/oauth/google/start?next=${encodeURIComponent(next)}`}>
                        <span className="au-ic">G</span>Continue with Google
                      </a>
                    </div>
                    <div className="au-or">
                      <span>or continue with email</span>
                    </div>
                  </>
                ) : null}
                <form className="au-form" onSubmit={submit} noValidate>
                  <div className="au-field">
                    <label htmlFor="fEmail">Work email</label>
                    <div className="au-ctl">
                      <span className="au-lead">
                        <Icon id="st-mail" />
                      </span>
                      <input
                        ref={firstRef}
                        className={`au-input${bad("email")}`}
                        id="fEmail"
                        type="email"
                        autoComplete="email"
                        placeholder={domain ? `you@${domain}` : "you@company.com"}
                        value={email}
                        onChange={(e) => (setEmail(e.target.value), setErr(null))}
                      />
                    </div>
                  </div>
                  <p className="au-err" role="alert">
                    {err?.msg ?? ""}
                  </p>
                  <button className="au-btn" type="submit">
                    Continue
                    <Icon id="arr" />
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="au-who">
                  <span className="au-lead">
                    <Icon id="st-mail" />
                  </span>
                  <span className="au-em">{email}</span>
                  <button type="button" className="au-link" onClick={() => (setStage("email"), setErr(null))}>
                    Edit
                  </button>
                </div>
                <form className="au-form" onSubmit={submit} noValidate>
                  {up ? (
                    <div className="au-field">
                      <label htmlFor="fName">Full name</label>
                      <div className="au-ctl">
                        <span className="au-lead">
                          <Icon id="st-user" />
                        </span>
                        <input ref={firstRef} className={`au-input${bad("name")}`} id="fName" autoComplete="name" placeholder="Your full name" value={name} onChange={(e) => (setName(e.target.value), setErr(null))} />
                      </div>
                    </div>
                  ) : null}
                  <div className="au-field">
                    <label htmlFor="fPass">Password</label>
                    <div className="au-ctl">
                      <span className="au-lead">
                        <Icon id="lock" />
                      </span>
                      <input
                        ref={up ? undefined : firstRef}
                        className={`au-input${bad("password")}`}
                        id="fPass"
                        type={show ? "text" : "password"}
                        autoComplete={up ? "new-password" : "current-password"}
                        placeholder={up ? "Create a password" : "Your password"}
                        value={password}
                        onChange={(e) => (setPassword(e.target.value), setErr(null))}
                      />
                      <button type="button" className="au-peek" onClick={() => setShow((x) => !x)}>
                        {show ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>
                  {!up && providers?.passwordReset ? (
                    <p className="au-hint" style={{ textAlign: "right", marginTop: -6 }}>
                      <Link className="au-link" href={`/forgot-password?email=${encodeURIComponent(email)}`}>
                        Forgot password?
                      </Link>
                    </p>
                  ) : null}
                  {up ? (
                    <>
                      <div className="au-meter" data-s={s} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </div>
                      <p className="au-hint">{HINTS[s]}</p>
                    </>
                  ) : null}
                  <p className="au-err" role="alert">
                    {err?.msg ?? ""}
                  </p>
                  <button className="au-btn" type="submit" disabled={busy}>
                    {busy ? <span className="au-spin" /> : null}
                    {busy ? (up ? "Creating your account" : "Signing in") : up ? "Create account" : "Sign in"}
                    {!busy ? <Icon id="arr" /> : null}
                  </button>
                </form>
              </>
            )}
          </div>
          <p className="au-switch">
            {up ? "Already have an account? " : "New to Aperture? "}
            <button type="button" className="au-link" onClick={() => (onMode(up ? "in" : "up"), setErr(null), setStage(email ? "details" : "email"))}>
              {up ? "Sign in" : "Create an account"}
            </button>
          </p>
        </section>
      </div>
      <p className="au-legal">By continuing, you agree to Aperture&apos;s Terms of Service and Privacy Policy.</p>
    </div>
  );
}
