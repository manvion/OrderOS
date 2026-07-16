'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Clock, Mail, Plus, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

/** "staff.role_changed" -> "staff role changed" */
function humanizeAction(action: string): string {
  return action.replace(/[._]/g, ' ');
}

const ROLE_HELP: Record<string, string> = {
  OWNER: 'Everything, including payouts, billing and removing other owners.',
  MANAGER: 'Menu, orders, staff, reports and settings. Cannot touch payouts.',
  STAFF: 'Take and manage orders, mark items sold out. Cannot see revenue.',
};

export default function StaffPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  useRequireRole('MANAGER', '/dashboard/kitchen');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'OWNER' | 'MANAGER' | 'STAFF'>('STAFF');
  const [activityUserId, setActivityUserId] = useState('');

  const { data: staff, isLoading } = useQuery({
    queryKey: ['staff', restaurant?.id],
    queryFn: () => api.listStaff(),
    enabled: Boolean(restaurant),
  });

  const { data: invites } = useQuery({
    queryKey: ['invites', restaurant?.id],
    queryFn: () => api.listInvites(),
    enabled: Boolean(restaurant),
  });

  const { data: activity, isLoading: loadingActivity } = useQuery({
    queryKey: ['activity', restaurant?.id, activityUserId],
    queryFn: () => api.getActivity({ userId: activityUserId || undefined, limit: 50 }),
    enabled: Boolean(restaurant),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
    void queryClient.invalidateQueries({ queryKey: ['invites'] });
  };

  const invite = useMutation({
    mutationFn: () => api.inviteStaff({ email: email.trim(), role }),
    onSuccess: () => {
      invalidate();
      setEmail('');
      toast.success(`Invitation emailed. They have 7 days to accept.`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not send the invite'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => {
      invalidate();
      toast.success('Invitation revoked — the link no longer works.');
    },
    onError: () => toast.error('Could not revoke the invitation'),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.updateStaffRole(id, role),
    onSuccess: () => {
      invalidate();
      toast.success('Role updated');
    },
    // The API refuses to demote the last owner, and says why. Show that verbatim.
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not change the role'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeStaff(id),
    onSuccess: () => {
      invalidate();
      toast.success('Removed from the team');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not remove them'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Your team</h1>
        <p className="text-sm text-muted-foreground">
          Invite the people who run your kitchen and your counter.
        </p>
      </div>

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4" />
              Invite someone
            </CardTitle>
            <CardDescription>
              They&apos;ll get an email with a link. It only works for that address, and it expires
              in 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="chef@bellaburger.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                >
                  <option value="STAFF">Staff</option>
                  <option value="MANAGER">Manager</option>
                  {/* Only an owner can mint an owner — the API enforces it too. */}
                  {can('OWNER') && <option value="OWNER">Owner</option>}
                </Select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{ROLE_HELP[role]}</p>

            <Button
              onClick={() => invite.mutate()}
              disabled={!email.includes('@') || invite.isPending}
            >
              <Plus className="h-4 w-4" />
              {invite.isPending ? 'Sending…' : 'Send invitation'}
            </Button>
          </CardContent>
        </Card>
      )}

      {invites && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{inv.email}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {inv.role.toLowerCase()}
                  </Badge>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => revoke.mutate(inv.id)}
                      aria-label={`Revoke invitation for ${inv.email}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On the team</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="space-y-2">
              {staff?.map((member) => {
                const name =
                  [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
                // You cannot change your own role or remove yourself — the API
                // enforces it, and showing the controls would be a lie.
                const isSelf = member.email === restaurant.email;

                return (
                  <div
                    key={member.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {can('OWNER') && !isSelf ? (
                        <Select
                          value={member.role}
                          onChange={(e) =>
                            changeRole.mutate({ id: member.id, role: e.target.value })
                          }
                          className="h-8 w-32 text-xs"
                        >
                          <option value="STAFF">Staff</option>
                          <option value="MANAGER">Manager</option>
                          <option value="OWNER">Owner</option>
                        </Select>
                      ) : (
                        <Badge variant={member.role === 'OWNER' ? 'default' : 'secondary'}>
                          {member.role.toLowerCase()}
                        </Badge>
                      )}

                      {can('OWNER') && !isSelf && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => remove.mutate(member.id)}
                          aria-label={`Remove ${name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Activity
          </CardTitle>
          <CardDescription>
            What your team actually did — orders accepted, items 86&apos;d, refunds issued.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select
            value={activityUserId}
            onChange={(e) => setActivityUserId(e.target.value)}
            className="w-full sm:w-64"
          >
            <option value="">Everyone</option>
            {staff?.map((member) => (
              <option key={member.id} value={member.id}>
                {[member.firstName, member.lastName].filter(Boolean).join(' ') || member.email}
              </option>
            ))}
          </Select>

          {loadingActivity ? (
            <Skeleton className="h-32 w-full" />
          ) : !activity?.length ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nothing here yet.
            </p>
          ) : (
            <div className="space-y-1">
              {activity.map((entry) => {
                const actorName = entry.user
                  ? [entry.user.firstName, entry.user.lastName].filter(Boolean).join(' ') ||
                    entry.user.email
                  : 'System';
                return (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{actorName}</span>{' '}
                      <span className="text-muted-foreground">{humanizeAction(entry.action)}</span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
