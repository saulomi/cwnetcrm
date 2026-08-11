"use client";

import { useTheme } from "@/hooks/use-theme";

/**
 * Brand mark shown at the top of the login/signup/forgot-password
 * cards. Swaps between the white and full-color icon crops so it
 * reads clearly against the `bg-primary/10` chip in both modes —
 * same logic as the sidebar logo.
 */
export function AuthBrandMark() {
  const { mode } = useTheme();
  return (
    <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={mode === "dark" ? "/brand/cwnet-icon-white.png" : "/brand/cwnet-icon-color.png"}
        alt="cwnet"
        className="h-6 w-6 object-contain"
      />
    </div>
  );
}
