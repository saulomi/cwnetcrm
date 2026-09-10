import type { Metadata } from "next";
import type { ReactNode } from "react";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// The auth pages (login / signup / forgot-password) are client components
// that build a Supabase browser client in their render body. Prerendering
// them at build time evaluates that call with no NEXT_PUBLIC_SUPABASE_* in
// the environment and throws ("Your project's URL and API key are
// required"). These are interactive forms with no SEO value (noindex
// above), so opt the whole group out of static generation.
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
