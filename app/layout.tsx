import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Every Dollar Counts",
  description: "A simple household budget tracker",
  // Installable app (#21). No `icons` key on purpose: setting one makes Next drop the
  // app/icon.png and app/apple-icon.png file conventions. statusBarStyle 'default' keeps dark
  // status-bar text over the white phone header; 'black-translucent' would make it white on white.
  appleWebApp: {
    capable: true,
    title: "EveryDollar",
    statusBarStyle: "default",
  },
};

// `cover` lets the page extend under the notch and home indicator. That is what makes the
// env(safe-area-inset-*) padding in components/AppShell.tsx non-zero, so the tab bar clears the
// home indicator. themeColor lives here, not in `metadata`, where this Next deprecates it.
export const viewport: Viewport = {
  themeColor: "#ffffff",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
