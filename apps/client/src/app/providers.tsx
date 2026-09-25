"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Provider } from "react-redux";
import { makeStore } from "@/store";
import { Toaster } from "@/components/ui/overlays";

export function Providers({ children }: { children: ReactNode }) {
  const [store] = useState(makeStore);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = (e.target as Element | null)?.closest?.(".glass") as HTMLElement | null;
      if (!g) return;
      const r = g.getBoundingClientRect();
      g.style.setProperty("--mx", `${e.clientX - r.left}px`);
      g.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => document.removeEventListener("pointermove", move);
  }, []);
  return (
    <Provider store={store}>
      {children}
      <Toaster />
    </Provider>
  );
}
