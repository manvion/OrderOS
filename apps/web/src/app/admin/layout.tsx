import { AdminQueryProvider } from '@/components/admin/admin-query-provider';

/**
 * Every page under /admin fetches with react-query, and react-query THROWS without
 * a QueryClientProvider above it — which is a 500 on the whole route, not a
 * degraded page. The dashboard has its own provider inside DashboardProvider; the
 * admin routes had none, so /admin returned a server error on every request.
 *
 * The provider lives in a layout rather than in each page so that adding a new
 * admin page cannot reintroduce the same bug.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminQueryProvider>{children}</AdminQueryProvider>;
}
