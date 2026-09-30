import { Outlet } from 'react-router-dom';

export function WikiLayout() {
  return (
    <div className="flex-1 bg-background">
      <main className="max-w-6xl mx-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
