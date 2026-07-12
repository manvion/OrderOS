import { DashboardProvider } from '@/components/dashboard/dashboard-provider';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardProvider>
  );
}
