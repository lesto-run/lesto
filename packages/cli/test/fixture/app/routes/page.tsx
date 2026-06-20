// A fixture file route: proves the CLI auto-discovers `app/routes/` and applies it
// (the named-export shape — a default-export component + a named `metadata`). The
// `routes` command never renders it, so the component is a no-op here.
export const metadata = () => ({ title: "Home" });

export default function Home() {
  return null;
}
