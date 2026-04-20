import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vLLM Dashboard",
  description: "GPU inference stack control panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
