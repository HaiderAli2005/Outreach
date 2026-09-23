"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/onboarding/AuthStep";
import { Icon, Mark } from "@/components/ui/Icon";
import { useSessionBootstrap, FullPageLoader } from "@/components/shell/session";

function safeNext(v: string | null): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
}

function SignIn() {
  const params = useSearchParams();
  const router = useRouter();
  const status = useSessionBootstrap();
  const [mode, setMode] = useState<"up" | "in">(params.get("mode") === "up" ? "up" : "in");
  const next = safeNext(params.get("next"));
  const oauthError = params.get("error");

  useEffect(() => {
    if (status === "authed") router.replace(next ?? "/app");
  }, [status, next, router]);

  if (status === "idle" || status === "loading" || status === "authed") return <FullPageLoader />;

  return (
    <div id="onboard" className="is-auth" style={{ minHeight: "100vh" }}>
      <header className="obh">
        <div className="obh-in nav-in glass">
          <Link className="logo" href="/" aria-label="Aperture home">
            <Mark />
            <span>Aperture</span>
          </Link>
          <span style={{ flex: 1 }} />
          <Link className="obh-exit" href="/">
            <Icon id="back" />
            <span>Back to site</span>
          </Link>
        </div>
      </header>
      {oauthError ? (
        <div style={{ width: "min(460px, calc(100% - 32px))", margin: "24px auto -12px" }}>
          <div className="banner bad" role="alert">
            {oauthError}
          </div>
        </div>
      ) : null}
      <AuthCard mode={mode} onMode={setMode} next={next ?? "/app"} onDone={() => router.replace(mode === "up" ? "/onboarding" : next ?? "/app")} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <SignIn />
    </Suspense>
  );
}
