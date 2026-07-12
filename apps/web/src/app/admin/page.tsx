import { AdminConsole } from '@/components/admin/admin-console';

/**
 * The admin console is authenticated by definition — there is no meaningful static
 * version of it, and prerendering it would force Clerk to run at BUILD time, which
 * fails on any deployment that hasn't got a key configured yet and takes the whole
 * build down with it.
 *
 * (Route segment config like this only works in a SERVER component, which is why
 * the console itself lives in components/ and this file is a thin wrapper.)
 */
export const dynamic = 'force-dynamic';

export default function AdminPage() {
  return <AdminConsole />;
}
