"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, Mark } from "@/components/ui/Icon";

/** exit: false hides the header link, for pages where the user is already signed in. */
export function AuthFrame({ children, legal, exit = true }: { children: ReactNode; legal?: ReactNode; exit?: boolean }) {
  return (
    <div id="onboard" className="is-auth" style={{ minHeight: "100vh" }}>
      <header className="obh">
        <div className="obh-in nav-in glass">
          <Link className="logo" href="/" aria-label="Aperture home">
            <Mark />
            <span>Aperture</span>
          </Link>
          <span style={{ flex: 1 }} />
          {exit ? (
            <Link className="obh-exit" href="/signin">
              <Icon id="back" />
              <span>Back to sign in</span>
            </Link>
          ) : null}
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
