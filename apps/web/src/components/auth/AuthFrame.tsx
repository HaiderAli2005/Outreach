"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, Mark } from "@/components/ui/Icon";

export function AuthFrame({ children, legal }: { children: ReactNode; legal?: ReactNode }) {
  return (
    <div id="onboard" className="is-auth" style={{ minHeight: "100vh" }}>
      <header className="obh">
        <div className="obh-in nav-in glass">
          <Link className="logo" href="/" aria-label="Aperture home">
            <Mark />
            <span>Aperture</span>
          </Link>
          <span style={{ flex: 1 }} />
          <Link className="obh-exit" href="/signin">
            <Icon id="back" />
            <span>Back to sign in</span>
          </Link>
        </div>
      </header>
      <div className="au-page">
        <div className="au-shell">
          <section className="au-col">{children}</section>
        </div>
        {legal ? <p className="au-legal">{legal}</p> : null}
      </div>
    </div>
  );
}
