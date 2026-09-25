import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Users, Send, MessageCircle, CalendarCheck2, Clock, TrendingUp, Mail, Calendar } from 'lucide-react';
import { Lead } from '../types';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { ChannelHealthPanel } from './ChannelHealthPanel';
import { ChannelCard } from './ChannelCard';
import { StatTile } from './StatTile';
import { VoiceDemoWidget } from './VoiceDemoWidget';
import { useLiveHistory } from '../hooks/useLiveHistory';
import { useChannelHealth } from '../hooks/useChannelHealth';
import { getWhatsAppStats, getEmailStats, getCalendarStats } from '../utils/channelStats';

interface DashboardViewProps {
  leads: Lead[];
  userId?: string | null;
  accessToken?: string | null;
  onOpenExcelUpload: () => void;
}

interface CloudCounts {
  activeCampaigns: number;
  activeConversations: number;
  meetingsBookedCloud: number;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ leads, userId, accessToken, onOpenExcelUpload }) => {
  const [cloud, setCloud] = useState<CloudCounts | null>(null);
  const { health, loading: healthLoading, error: healthError, reload: reloadHealth } = useChannelHealth(accessToken);

  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseBrowserConfigured || !supabase || !userId) {
      setCloud(null);
      return;
    }

    const load = async () => {
      const [
        { count: activeCampaigns },
        { count: activeWaConversations },
        { count: activeEmConversations },
        { count: bookedWa },
        { count: bookedEm },
      ] = await Promise.all([
        supabase!.from('campaigns').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'running'),
        supabase!.from('whatsapp_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'active'),
        supabase!.from('email_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'active'),
        supabase!.from('whatsapp_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'confirmed'),
        supabase!.from('email_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'confirmed'),
      ]);
      if (cancelled) return;
      setCloud({
        activeCampaigns: activeCampaigns || 0,
        activeConversations: (activeWaConversations || 0) + (activeEmConversations || 0),
        meetingsBookedCloud: (bookedWa || 0) + (bookedEm || 0),
      });
    };

    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId]);

  const totalClients = leads.length;
  const contactedCount = leads.filter((l) => l.status !== 'Pending').length;
  const meetingsBookedLocal = leads.filter((l) => l.status === 'Meeting Scheduled').length;
  const failedCount = leads.filter((l) => l.whatsAppStatus === 'Failed' || l.emailStatus === 'Failed').length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const followUpsDueCount = leads.filter((l) => l.followUpDate && l.followUpDate <= todayStr).length;
  const meetingConversionRate = contactedCount > 0 ? Math.round((meetingsBookedLocal / contactedCount) * 100) : 0;

  const activeCampaigns = cloud ? cloud.activeCampaigns : null;
  const activeConversations = cloud ? cloud.activeConversations : null;
  const meetingsBooked = cloud ? cloud.meetingsBookedCloud : meetingsBookedLocal;

  // Genuine live history: starts flat and fills in from real polled/derived values as the
  // session runs, rather than fabricating a fake trend line.
  const totalClientsHistory = useLiveHistory(totalClients);
  const activeCampaignsHistory = useLiveHistory(activeCampaigns ?? 0);
  const activeConversationsHistory = useLiveHistory(activeConversations ?? 0);
  const meetingsBookedHistory = useLiveHistory(meetingsBooked);

  const waStats = useMemo(() => getWhatsAppStats(leads), [leads]);
  const emailStats = useMemo(() => getEmailStats(leads), [leads]);
  const calendarStats = useMemo(() => getCalendarStats(leads), [leads]);

  const healthStatusFor = (ok: boolean | undefined): 'ok' | 'attention' | 'checking' => {
    if (!health) return healthLoading ? 'checking' : 'attention';
    return ok ? 'ok' : 'attention';
  };

  const tiles = [
    {
      label: 'Total Clients',
      value: totalClients,
      icon: Users,
      accent: 'text-[#4285F4] bg-[#4285F4]/10',
      history: totalClientsHistory,
      color: '#4285F4',
    },
    {
      label: 'Active Campaigns',
      value: activeCampaigns,
      icon: Send,
      accent: 'text-[#25D366] bg-[#25D366]/10',
      history: activeCampaignsHistory,
      color: '#25D366',
    },
    {
      label: 'Active Conversations',
      value: activeConversations,
      icon: MessageCircle,
      accent: 'text-[#128C7E] bg-[#128C7E]/10',
      history: activeConversationsHistory,
      color: '#128C7E',
    },
    {
      label: 'Meetings Booked',
      value: meetingsBooked,
      icon: CalendarCheck2,
      accent: 'text-[#128C7E] bg-[#128C7E]/15',
      history: meetingsBookedHistory,
      color: '#128C7E',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-[#4285F4]" />
            <span>Overview</span>
          </div>
          <h2 className="text-xl font-bold text-ink">Control Center</h2>
          <p className="text-xs sm:text-sm text-ink-secondary mt-0.5">
            How many clients need attention, how campaigns are performing, and how many meetings are booked.
          </p>
        </div>
        {totalClients === 0 && (
          <button
            onClick={onOpenExcelUpload}
            className="px-4 py-2 rounded-full bg-brand-strong hover:bg-[#0d6e62] text-white text-xs font-semibold shadow-sm transition-all"
          >
            Import your first clients
          </button>
        )}
      </div>

      <VoiceDemoWidget />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile, i) => (
          <StatTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            icon={tile.icon}
            accentClass={tile.accent}
            history={tile.history}
            color={tile.color}
            delay={i * 0.05}
          />
        ))}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink mb-3">Channels</h3>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChannelCard
            icon={MessageCircle}
            iconClassName="bg-[#25D366]/15 text-[#25D366]"
            name="WhatsApp"
            mode="Outbound + Inbound"
            status={healthStatusFor(health?.whatsapp.ok)}
            stats={[
              { label: 'Sent', value: waStats.sent },
              { label: 'Replied', value: waStats.replied },
              { label: 'Failed', value: waStats.failed },
            ]}
            description={health?.whatsapp.message || 'Checking WhatsApp Cloud API status…'}
            scatterPoints={waStats.scatter}
            delay={0.1}
          />
          <ChannelCard
            icon={Mail}
            iconClassName="bg-blue-500/15 text-blue-400"
            name="Email"
            mode="Outbound + Inbound"
            status={healthStatusFor(health?.email.ok)}
            stats={[
              { label: 'Sent', value: emailStats.sent },
              { label: 'Replied', value: emailStats.replied },
              { label: 'Failed', value: emailStats.failed },
            ]}
            description={health?.email.message || 'Checking email provider status…'}
            scatterPoints={emailStats.scatter}
            delay={0.15}
          />
          <ChannelCard
            icon={Calendar}
            iconClassName="bg-[#4285F4]/15 text-[#4285F4]"
            name="Google Calendar"
            mode="Auto-booking"
            status={healthStatusFor(health?.calendar.ok)}
            stats={[
              { label: 'Booked', value: calendarStats.booked },
              { label: 'In Progress', value: calendarStats.inProgress },
              { label: 'Declined', value: calendarStats.declined },
            ]}
            description={health?.calendar.message || 'Checking Google Calendar connection…'}
            scatterPoints={calendarStats.scatter}
            delay={0.2}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.25, ease: 'easeOut' }}
          className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200"
        >
          <h3 className="font-semibold text-sm text-ink mb-3">Client Pipeline</h3>
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Contacted</span>
              <span className="font-semibold text-ink">{contactedCount} / {totalClients}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Meetings booked</span>
              <span className="font-semibold text-[#128C7E]">{meetingsBookedLocal}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Conversion rate</span>
              <span className="font-semibold text-ink">{meetingConversionRate}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-secondary">Failed dispatches</span>
              <span className="font-semibold text-rose-400">{failedCount}</span>
            </div>
            {followUpsDueCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-ink-secondary">Follow-ups due</span>
                <span className="font-semibold text-amber-400">{followUpsDueCount}</span>
              </div>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.3, ease: 'easeOut' }}
          className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200"
        >
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-ink-muted" />
            <h3 className="font-semibold text-sm text-ink">Pending Follow-ups</h3>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed">
            Replies are handled live the moment a client messages back — the AI booking bot responds instantly via
            WhatsApp or Email and books a meeting automatically once a time is confirmed.
          </p>
        </motion.div>

        <ChannelHealthPanel accessToken={accessToken} health={health} loading={healthLoading} error={healthError} onRefresh={reloadHealth} />
      </div>

      {!isSupabaseBrowserConfigured && (
        <p className="text-[11px] text-ink-muted text-center">
          Running in local/standalone mode — connect Supabase for org-wide campaign and conversation metrics.
        </p>
      )}
    </div>
  );
};
