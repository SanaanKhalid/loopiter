import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "../../lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Documentation — Loopiter",
  description: "Loopiter documentation has moved to the canonical Fern docs: capture, evaluation, deployment, and governed self-improvement.",
  path: "/docs",
  index: false,
});

export default function DocsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
