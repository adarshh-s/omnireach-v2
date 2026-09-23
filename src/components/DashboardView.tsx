import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Users, Send, MessageCircle, CalendarCheck2, Clock, TrendingUp } from 'lucide-react';
import { Lead } from '../types';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { ChannelHealthPanel } from './ChannelHealthPanel';

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

  const tiles = [
    {
      label: 'Total Clients',
      value: totalClients,
      icon: Users,
      accent: 'text-[#4285F4] bg-[#4285F4]/10',
    },
    {
      label: 'Active Campaigns',
      value: cloud ? cloud.activeCampaigns : '—',
      icon: Send,
      accent: 'text-[#25D366] bg-[#25D366]/10',
    },
    {
      label: 'Active Conversations',
      value: cloud ? cloud.activeConversations : '—',
      icon: MessageCircle,
      accent: 'text-[#128C7E] bg-[#128C7E]/10',
    },
    {
      label: 'Meetings Booked',
      value: cloud ? cloud.meetingsBookedCloud : meetingsBookedLocal,
      icon: CalendarCheck2,
      accent: 'text-[#128C7E] bg-[#128C7E]/15',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white border border-[#E4E4E7] rounded-2xl p-6 shadow-card flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-[#71717A] mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-[#4285F4]" />
            <span>Overview</span>
          </div>
          <h2 className="text-xl font-bold text-[#18181B]">Control Center</h2>
          <p className="text-xs sm:text-sm text-[#3F3F46] mt-0.5">
            How many clients need attention, how campaigns are performing, and how many meetings are booked.
          </p>
        </div>
        {totalClients === 0 && (
          <button
            onClick={onOpenExcelUpload}
            className="px-4 py-2 rounded-full bg-[#18181B] hover:bg-[#09090B] text-white text-xs font-semibold shadow-sm transition-all"
          >
            Import your first clients
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile, i) => {
          const Icon = tile.icon;
          return (
            <motion.div
              key={tile.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05, ease: 'easeOut' }}
              className="bg-white border border-[#E4E4E7] rounded-2xl p-5 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200"
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${tile.accent}`}>
                <Icon className="w-4.5 h-4.5" />
              </div>
              <div className="text-2xl font-bold text-[#18181B]">{tile.value}</div>
              <div className="text-xs text-[#71717A] mt-0.5">{tile.label}</div>
            </motion.div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border border-[#E4E4E7] rounded-2xl p-6 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200">
          <h3 className="font-semibold text-sm text-[#18181B] mb-3">Client Pipeline</h3>
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[#3F3F46]">Contacted</span>
              <span className="font-semibold text-[#18181B]">{contactedCount} / {totalClients}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#3F3F46]">Meetings booked</span>
              <span className="font-semibold text-[#128C7E]">{meetingsBookedLocal}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#3F3F46]">Failed dispatches</span>
              <span className="font-semibold text-rose-600">{failedCount}</span>
            </div>
            {followUpsDueCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[#3F3F46]">Follow-ups due</span>
                <span className="font-semibold text-amber-700">{followUpsDueCount}</span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-[#E4E4E7] rounded-2xl p-6 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-[#71717A]" />
            <h3 className="font-semibold text-sm text-[#18181B]">Pending Follow-ups</h3>
          </div>
          <p className="text-xs text-[#71717A] leading-relaxed">
            Replies are handled live the moment a client messages back — the AI booking bot responds instantly via
            WhatsApp or Email and books a meeting automatically once a time is confirmed.
          </p>
        </div>

        <ChannelHealthPanel accessToken={accessToken} />
      </div>

      {!isSupabaseBrowserConfigured && (
        <p className="text-[11px] text-[#71717A] text-center">
          Running in local/standalone mode — connect Supabase for org-wide campaign and conversation metrics.
        </p>
      )}
    </div>
  );
};
