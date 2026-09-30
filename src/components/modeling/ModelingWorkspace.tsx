import type { ReactNode } from 'react';

interface ModelingWorkspaceProps {
  children: ReactNode;
}

export function ModelingWorkspace({ children }: ModelingWorkspaceProps) {
  return (
    <div className="min-h-full bg-background" data-modeling-mode="simulator">
      <main className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6">
        {children}
      </main>
    </div>
  );
}
