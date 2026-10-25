import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { isLocalAuth } from "@/lib/auth";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource-variable/instrument-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "I'm in if…",
  description: "A private agent for the plan you haven't made yet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const tree = (
    <html lang="en">
      <body>{children}</body>
    </html>
  );

  return isLocalAuth() ? tree : <ClerkProvider>{tree}</ClerkProvider>;
}
