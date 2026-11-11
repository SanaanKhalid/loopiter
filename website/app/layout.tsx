import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { JsonLd } from "../components/json-ld";
import { siteGraph } from "../lib/structured-data";
import { siteUrl, socialImage } from "../lib/site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Loopiter — Governed improvement for AI systems",
  description: "Connect production AI behavior to verified outcomes, find recurring patterns, and turn evidence into governed improvements. MIT-licensed Python and Node.js SDKs.",
  applicationName: "Loopiter",
  openGraph: {
    siteName: "Loopiter",
    locale: "en_US",
    type: "website",
    images: [socialImage],
  },
  twitter: { card: "summary_large_image", images: [socialImage] },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <JsonLd data={siteGraph} />
        {children}
      </body>
    </html>
  );
}
