import React, { useEffect, useState } from 'react';
import { BarChart3, TrendingUp, Calendar, MessageSquare, Mail, Download } from 'lucide-react';
import { Lead } from '../types';
import { exportLeadsToExcel } from '../utils/excelParser';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { StatTile } from './StatTile';
import { useLiveHistory } from '../hooks/useLiveHistory';

interface CampaignAnalyticsProps {
  leads: Lead[];
  userId?: string | null;
}

interface CloudStats {
  meetingsBooked: number;
  activeConversations: number;
  messagesDispatched: number;
  whatsappDelivered: number;
  whatsappFailed: number;
  emailSent: number;
  emailFailed: number;
}

export const CampaignAnalytics: React.FC<CampaignAnalyticsProps> = ({ leads, userId }) => {
  // Real, cross-device outcomes — meetings and message delivery only ever happen for real
  // through the AI bot (whatsapp_conversations / email_conversations) and the persisted
  // campaign_recipients table, not the browser-local `leads` array below, which only
  // reflects what this one browser session has seen.
  const [cloud, setCloud] = useState<CloudStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseBrowserConfigured || !supabase || !userId) {
      setCloud(null);
      return;
    }

    const load = async () => {
      const [
        { count: bookedWa },
        { count: bookedEm },
        { count: activeWa },
        { count: activeEm },
        { count: dispatched },
        { count: waDelivered },
        { count: waFailed },
        { count: emSent },
        { count: emFailed },
      ] = await Promise.all([
        supabase!.from('whatsapp_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'confirmed'),
        supabase!.from('email_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'confirmed'),
        supabase!.from('whatsapp_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'active'),
        supabase!.from('email_conversations').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('status', 'active'),
        supabase!.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', userId),
        supabase!.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('whatsapp_status', 'Delivered'),
        supabase!.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('whatsapp_status', 'Failed'),
        supabase!.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('email_status', 'Sent'),
        supabase!.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', userId).eq('email_status', 'Failed'),
      ]);
      if (cancelled) return;
      setCloud({
        meetingsBooked: (bookedWa || 0) + (bookedEm || 0),
        activeConversations: (activeWa || 0) + (activeEm || 0),
        messagesDispatched: dispatched || 0,
        whatsappDelivered: waDelivered || 0,
        whatsappFailed: waFailed || 0,
        emailSent: emSent || 0,
        emailFailed: emFailed || 0,
      });
    };

    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId]);

  const total = leads.length;
  const pending = leads.filter((l) => l.status === 'Pending').length;
  const scheduled = leads.filter((l) => l.status === 'Meeting Scheduled').length;
  const contacted = leads.filter((l) => l.status === 'Contacted' || l.status === 'Interested').length;
  const notInterested = leads.filter(
    (l) => l.status === 'Not Interested' || l.status === 'Do Not Contact'
  ).length;

  // WhatsApp specific metrics
  const waDelivered = leads.filter(
    (l) => l.whatsAppStatus === 'Delivered' || l.whatsAppStatus === 'Read' || l.whatsAppStatus === 'Replied'
  ).length;
  const waReplied = leads.filter((l) => l.whatsAppStatus === 'Replied').length;

  // Email specific metrics
  const emailSent = leads.filter((l) => l.emailStatus !== 'Pending').length;
  const emailOpened = leads.filter(
    (l) => l.emailStatus === 'Opened' || l.emailStatus === 'Clicked' || l.emailStatus === 'Replied'
  ).length;
  const emailReplied = leads.filter((l) => l.emailStatus === 'Replied').length;

  const totalDispatched = leads.filter(
    (l) => l.whatsAppStatus !== 'Pending' || l.emailStatus !== 'Pending'
  ).length;

  // Prefer the same cross-device cloud counts "Total Meetings Booked" already shows —
  // otherwise this card was computed purely from the local, browser-only `leads` array
  // (whose `status` never flips to 'Meeting Scheduled' just because the AI bot booked
  // something from another device/session), so the two cards could show flatly
  // contradictory numbers side by side, e.g. "0% — 0 of 40" next to "Total Meetings
  // Booked: 6".
  const meetingsForRate = cloud ? cloud.meetingsBooked : scheduled;
  const dispatchedForRate = cloud ? cloud.messagesDispatched : totalDispatched;
  const meetingConversionRate =
    dispatchedForRate > 0 ? Math.round((meetingsForRate / dispatchedForRate) * 100) : 0;
  const overallReplyRate =
    totalDispatched > 0
      ? Math.round(((waReplied + emailReplied) / totalDispatched) * 100)
      : 0;

  const handleExport = () => {
    exportLeadsToExcel(
      leads,
      `Outreach_Campaign_Analytics_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  };

  const waEngagementRate = waDelivered > 0 ? Math.round((waReplied / waDelivered) * 100) : 0;
  const emailResponseRate = emailSent > 0 ? Math.round((emailReplied / emailSent) * 100) : 0;

  const meetingRateHistory = useLiveHistory(meetingConversionRate);
  const meetingsBookedHistory = useLiveHistory(meetingsForRate);
  const waEngagementHistory = useLiveHistory(waEngagementRate);
  const emailResponseHistory = useLiveHistory(emailResponseRate);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-1">
            <BarChart3 className="w-3.5 h-3.5 text-[#25D366]" />
            <span>Outreach Performance & Conversion Funnel</span>
          </div>
          <h2 className="text-xl font-bold text-ink">
            WhatsApp & Email Campaign Analytics
          </h2>
          <p className="text-xs sm:text-sm text-ink-secondary mt-0.5">
            Real-time delivery rates, prospect responses, and Google Meet booking conversion KPIs.
          </p>
        </div>

        <button
          onClick={handleExport}
          className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-[#25D366] hover:bg-[#25D366] text-white font-bold text-xs shadow-xs transition-all"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Analytics Excel</span>
        </button>
      </div>

      {/* 4 Metric KPI Cards — same StatTile the Dashboard uses, for a consistent look */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="Meeting Conversion Rate"
          value={meetingConversionRate}
          suffix="%"
          icon={TrendingUp}
          accentClass="text-[#25D366] bg-[#25D366]/10"
          history={meetingRateHistory}
          color="#25D366"
        />
        <StatTile
          label="Total Meetings Booked"
          value={meetingsForRate}
          icon={Calendar}
          accentClass="text-[#4285F4] bg-[#4285F4]/10"
          history={meetingsBookedHistory}
          color="#4285F4"
          delay={0.05}
        />
        <StatTile
          label="WhatsApp Engagement"
          value={waEngagementRate}
          suffix="%"
          icon={MessageSquare}
          accentClass="text-[#25D366] bg-[#25D366]/10"
          history={waEngagementHistory}
          color="#25D366"
          delay={0.1}
        />
        <StatTile
          label="Email Response Rate"
          value={emailResponseRate}
          suffix="%"
          icon={Mail}
          accentClass="text-blue-400 bg-blue-500/10"
          history={emailResponseHistory}
          color="#4285F4"
          delay={0.15}
        />
      </div>

      {/* Outcome Distribution Bar & Breakdown */}
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card space-y-5">
        <h3 className="font-bold text-sm text-ink">Overall Lead Status Distribution</h3>

        {/* Multi-segment Progress Bar */}
        <div className="w-full bg-canvas h-4 rounded-full overflow-hidden flex border border-border">
          {total > 0 && (
            <>
              <div
                style={{ width: `${(scheduled / total) * 100}%` }}
                className="bg-[#25D366] h-full"
                title={`Meeting Scheduled: ${scheduled}`}
              />
              <div
                style={{ width: `${(contacted / total) * 100}%` }}
                className="bg-[#4285F4] h-full"
                title={`Interested / Contacted: ${contacted}`}
              />
              <div
                style={{ width: `${(pending / total) * 100}%` }}
                className="bg-amber-400 h-full"
                title={`Pending: ${pending}`}
              />
              <div
                style={{ width: `${(notInterested / total) * 100}%` }}
                className="bg-slate-500 h-full"
                title={`Not Interested: ${notInterested}`}
              />
            </>
          )}
        </div>

        {/* Legend Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-[#25D366]" />
            <span className="text-ink-secondary">
              <strong>{scheduled}</strong> Meeting Scheduled ({total > 0 ? Math.round((scheduled / total) * 100) : 0}%)
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-[#4285F4]" />
            <span className="text-ink-secondary">
              <strong>{contacted}</strong> Contacted / Interested
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-amber-400" />
            <span className="text-ink-secondary">
              <strong>{pending}</strong> Pending ({total > 0 ? Math.round((pending / total) * 100) : 0}%)
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-slate-500" />
            <span className="text-ink-secondary">
              <strong>{notInterested}</strong> Declined / Unsubscribed
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
