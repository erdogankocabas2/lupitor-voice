import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const sans = Public_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "Lupitor console",
  description: "Build, run and audit voice agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={sans.className}>
        <div className="shell">
          <aside className="rail">
            <div className="brand">
              <span className="brand-mark" aria-hidden /> Lupitor
            </div>
            <nav aria-label="Main">
              <Link href="/">Agents</Link>
              <Link href="/accounts">Accounts</Link>
              <Link href="/redteam">Red team</Link>
              <Link href="/audit">Evaluation guide</Link>
            </nav>
            <p className="foot">Call history is append-only. Nothing here can be deleted.</p>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
