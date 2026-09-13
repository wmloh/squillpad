import type { PropsWithChildren, ReactNode } from "react";

export interface AppShellProps extends PropsWithChildren {
  readonly title: ReactNode;
}

/** Shared browser application chrome. */
export function AppShell({ children, title }: AppShellProps) {
  return (
    <main className="app-shell">
      <header className="app-shell__header">{title}</header>
      <section className="app-shell__content">{children}</section>
    </main>
  );
}
