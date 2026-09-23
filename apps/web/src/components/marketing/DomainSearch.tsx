"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { normDomain, validDomain } from "@/lib/format";

const SAMPLES = ["yourcompany.com", "northwind.io", "brightlabs.co", "harborandco.com"];

function useTypedPlaceholder(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const input = ref.current;
    if (!input || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    let j = 0;
    let del = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.activeElement === input || input.value) {
        t = setTimeout(tick, 700);
        return;
      }
      const s = SAMPLES[i];
      if (!del) {
        j++;
        input.placeholder = s.slice(0, j);
        if (j >= s.length) {
          del = true;
          t = setTimeout(tick, 2000);
          return;
        }
      } else {
        j--;
        input.placeholder = s.slice(0, Math.max(j, 0));
        if (j <= 0) {
          del = false;
          i = (i + 1) % SAMPLES.length;
        }
      }
      t = setTimeout(tick, del ? 32 : 85);
    };
    tick();
    return () => clearTimeout(t);
  }, [ref]);
}

export function DomainSearch({ id, cta, onDomain, hero }: { id: string; cta?: boolean; onDomain?: (d: string) => void; hero?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const router = useRouter();
  useTypedPlaceholder(inputRef);

  useEffect(() => {
    if (!hero) return;
    const focus = () => inputRef.current?.focus({ preventScroll: true });
    window.addEventListener("ap:focus-search", focus);
    return () => window.removeEventListener("ap:focus-search", focus);
  }, [hero]);

  const open = (d: string) => router.push(`/onboarding?domain=${encodeURIComponent(d)}`);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = inputRef.current?.value ?? "";
    const d = normDomain(raw);
    if (!validDomain(d)) {
      setErr(raw.trim() ? "That doesn't look like a domain. Try something like northwind.io" : "Enter your company domain, like northwind.io");
      inputRef.current?.focus();
      return;
    }
    setErr("");
    onDomain?.(d);
    open(d);
  }

  return (
    <>
      <div className={`sring${cta ? " sring-cta" : ""}`}>
        <form className={`sbar${cta ? " sbar-cta" : ""}`} onSubmit={submit} noValidate>
          <label htmlFor={id}>
            <span className="sr">Your company domain</span>
            <Icon id="globe" className="sbar-ico" />
            <input
              ref={inputRef}
              id={id}
              name="domain"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="yourcompany.com"
              onChange={(e) => {
                setErr("");
                const c = e.currentTarget.value.replace(/^\s*https?:\/\//i, "");
                if (c !== e.currentTarget.value) e.currentTarget.value = c;
                const d = normDomain(c);
                if (validDomain(d)) onDomain?.(d);
              }}
            />
          </label>
          <button className="sbar-go" type="submit">
            Analyze
            <Icon id="arr" />
          </button>
        </form>
      </div>
      <div className={`search-err${cta ? " cta-err" : ""}`} role="alert">
        {err}
      </div>
      {hero ? (
        <p className="proof">
          <span>Free preview in about a minute</span>
          <i aria-hidden="true" />
          <span>No card needed</span>
          <i aria-hidden="true" />
          <button type="button" className="proof-link" onClick={() => open("northwind.io")}>
            Try it with northwind.io
            <Icon id="arr" />
          </button>
        </p>
      ) : null}
    </>
  );
}
