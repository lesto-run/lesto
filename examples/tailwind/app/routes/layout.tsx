import type { ReactNode } from "react";

/** The root layout — a Tailwind-styled shell wrapping every file-routed page. */
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return <div className="min-h-screen bg-white text-gray-900">{children}</div>;
}
