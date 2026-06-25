import type { PageDef, PageProps } from "@lesto/web";
import type { ReactNode } from "react";

import Counter from "../islands/counter";

const load = (): { start: number } => ({ start: 0 });

const page: PageDef<"/", PageProps<typeof load>> = {
  load,

  component: ({ start }: PageProps<typeof load>): ReactNode => (
    <main>
      <h1>Island Fast Refresh</h1>
      <p>
        Click the button, then edit <code>app/islands/counter.tsx</code> while it runs under{" "}
        <code>lesto dev</code> — the count survives the edit (no full reload).
      </p>
      <Counter start={start} />
    </main>
  ),

  metadata: () => ({ title: "Island Fast Refresh" }),
};

export default page;
