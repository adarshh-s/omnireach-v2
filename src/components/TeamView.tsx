import React, { useEffect, useState } from 'react';
import { Loader2, UserPlus, Trash2, RefreshCw } from 'lucide-react';
import { PageHeader, headerSecondaryButton } from './PageHeader';

interface TeamMember {
  userId: string;
  email: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string | null;
}

interface TeamViewProps {
  accessToken?: string | null;
}

const ROLE_LABEL: Record<TeamMember['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** Everyone on this workspace. The owner and admins can invite and remove people; every
 * teammate sees and works on the same leads, campaigns, inbox and channel setup
 * (lib/teamMembers.ts). */
export const TeamView: React.FC<TeamViewProps> = ({ accessToken }) => {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [myRole, setMyRole] = useState<TeamMember['role'] | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const canManage = myRole === 'owner' || myRole === 'admin';

  const load = () => {
    if (!accessToken) return;
    setLoading(true);
    fetch('/api/whatsapp/subscribe-app?action=team', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => res.json())
      .then((data) => {
        if (!data?.members) {
          setError(data?.error || 'Could not load your team.');
          return;
        }
        setMembers(data.members);
        setMyRole(data.myRole);
        setMyUserId(data.myUserId);
      })
      .catch(() => setError('Failed to reach the server.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const post = async (action: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/whatsapp/subscribe-app?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;
    setInviting(true);
    setError(null);
    setInfo(null);
    try {
      const data = await post('team-invite', { email, role });
      if (data.ok) {
        setInfo(
          data.invited
            ? `Invite sent to ${email}. They'll get an email with a link to join and set a password.`
            : `${email} already had an account — they're on the team now and will see this workspace next time they sign in.`
        );
        setEmail('');
        load();
      } else {
        setError(data.error || 'Could not invite that person.');
      }
    } catch {
      setError('Failed to reach the server.');
    } finally {
      setInviting(false);
    }
  };

  const remove = async (member: TeamMember) => {
    const leaving = member.userId === myUserId;
    if (!window.confirm(leaving ? 'Leave this workspace?' : `Remove ${member.email || 'this person'} from the team?`)) return;
    setRemovingId(member.userId);
    setError(null);
    try {
      const data = await post('team-remove', { userId: member.userId });
      if (!data.ok) setError(data.error || 'Could not remove that person.');
      else if (leaving) window.location.reload();
      else load();
    } catch {
      setError('Failed to reach the server.');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Everyone here shares this workspace — leads, campaigns, the AI inbox and channel setup."
        actions={
          <button onClick={load} disabled={loading} className={headerSecondaryButton} title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        }
      />

      {canManage && (
        <form onSubmit={invite} className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-5 shadow-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Invite a teammate</h2>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="flex-1 min-w-0 bg-canvas border border-border-strong rounded-lg px-3 py-2 text-xs text-ink"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
              className="bg-canvas border border-border-strong rounded-lg px-3 py-2 text-xs text-ink"
            >
              <option value="member">Member</option>
              {myRole === 'owner' && <option value="admin">Admin (can manage the team)</option>}
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-brand-strong hover:bg-[#0d6e62] text-white text-xs font-semibold disabled:opacity-60"
            >
              {inviting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              <span>{inviting ? 'Inviting…' : 'Send Invite'}</span>
            </button>
          </div>
          {info && <p className="text-xs text-emerald-300">{info}</p>}
        </form>
      )}

      {error && <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300">{error}</div>}

      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-ink-muted uppercase tracking-wider text-[10px]">
                <th className="px-5 py-3 font-semibold">Email</th>
                <th className="px-5 py-3 font-semibold">Role</th>
                <th className="px-5 py-3 font-semibold">Joined</th>
                <th className="px-5 py-3 font-semibold text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members === null && !error && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-ink-muted">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Loading team…
                  </td>
                </tr>
              )}
              {members?.map((m) => {
                const isMe = m.userId === myUserId;
                const removable =
                  m.role !== 'owner' && (isMe || myRole === 'owner' || (myRole === 'admin' && m.role === 'member'));
                return (
                  <tr key={m.userId} className="hover:bg-surface-hover transition-colors">
                    <td className="px-5 py-3 text-ink font-medium">
                      {m.email || '—'}
                      {isMe && <span className="ml-1.5 text-[10px] text-ink-muted">(you)</span>}
                    </td>
                    <td className="px-5 py-3 text-ink-secondary">{ROLE_LABEL[m.role]}</td>
                    <td className="px-5 py-3 text-ink-muted">{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}</td>
                    <td className="px-5 py-3 text-right">
                      {removable && (
                        <button
                          onClick={() => remove(m)}
                          disabled={removingId === m.userId}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 disabled:opacity-50"
                        >
                          {removingId === m.userId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                          <span>{isMe ? 'Leave' : 'Remove'}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
