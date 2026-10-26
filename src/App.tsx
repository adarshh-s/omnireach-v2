import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar, ActiveTab } from './components/Sidebar';
import { BatchCampaignRunner } from './components/BatchCampaignRunner';
import { MessageSimulator } from './components/MessageSimulator';
import { SheetsView } from './components/SheetsView';
import { CalendarView } from './components/CalendarView';
import { ConversationsView } from './components/ConversationsView';
import { DashboardView } from './components/DashboardView';
import { TemplateManagerView } from './components/TemplateManagerView';
import { ExcelUploadModal } from './components/ExcelUploadModal';
import { ChannelConfigModal } from './components/ChannelConfigModal';
import { OnboardingWizard } from './components/OnboardingWizard';
import { AuthGate } from './components/AuthGate';
import { AccessLockedScreen } from './components/AccessLockedScreen';
import { AdminDashboard } from './components/AdminDashboard';
import { AiLearningView } from './components/AiLearningView';
import { TeamView } from './components/TeamView';
import { ReportsView } from './components/ReportsView';
import { AuthState } from './hooks/useAuth';
import { useCloudSettings } from './hooks/useCloudSettings';
import { useCloudClients } from './hooks/useCloudClients';
import { supabase, isSupabaseBrowserConfigured } from './lib/supabaseClient';
import {
  Lead,
  CalendarSlot,
  CampaignSettings,
  ChannelApiSettings,
  MessageTemplate,
} from './types';
import { INITIAL_LEADS, INITIAL_CALENDAR_SLOTS } from './data/sampleLeads';
import { hasChannelSecret } from './utils/channelSecrets';
import { DEFAULT_TEMPLATES, DEFAULT_CAMPAIGN_SETTINGS } from './data/sampleTemplates';
import { useOrgUsage, usageWarning } from './components/UsagePanel';

const DEFAULT_CHANNEL_SETTINGS: ChannelApiSettings = {
  whatsAppProvider: 'web_direct',
  emailProvider: 'resend',
  twilioAccountSid: '',
  twilioAuthToken: '',
  emailApiKey: '',
  n8nWebhookUrl: '',
  safeDailyWhatsAppLimit: 250,
};

const PAGE_TABS: ActiveTab[] = ['dashboard', 'reports', 'campaign', 'sheets', 'templates', 'inbox', 'learning', 'simulator', 'calendar', 'team', 'admin'];

function tabFromHash(): ActiveTab {
  if (typeof window === 'undefined') return 'dashboard';
  const hash = window.location.hash.replace(/^#/, '') as ActiveTab;
  return PAGE_TABS.includes(hash) ? hash : 'dashboard';
}

export default function App() {
  return <AuthGate>{(auth) => <AppContent auth={auth} />}</AuthGate>;
}

function AppContent({ auth }: { auth: AuthState }) {
  // The open page lives in the URL hash (#inbox, #campaign…) so a refresh stays on it and the
  // browser's back button moves between pages. Anything else in the hash (e.g. an auth
  // redirect's tokens) just means the dashboard.
  const [activeTab, setActiveTabState] = useState<ActiveTab>(tabFromHash);
  const setActiveTab = (tab: ActiveTab) => {
    setActiveTabState(tab);
    if (window.location.hash !== `#${tab}`) window.history.pushState(null, '', `#${tab}`);
  };
  useEffect(() => {
    const onHashChange = () => setActiveTabState(tabFromHash());
    window.addEventListener('popstate', onHashChange);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', onHashChange);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined)?.trim().toLowerCase();
  const isAdmin = Boolean(ADMIN_EMAIL && auth.user?.email && auth.user.email.trim().toLowerCase() === ADMIN_EMAIL);

  // No self-serve subscription checkout — every new signup starts 'locked' (see the
  // on_auth_user_created_access trigger in supabase/schema.sql) until the platform owner
  // manually activates them from the Admin dashboard after a direct conversation and
  // payment outside the app. A missing org_access row (every org that existed before this
  // was added) or standalone/no-Supabase mode both mean 'active' — nobody who already had
  // access loses it because of this rollout.
  const [orgAccessStatus, setOrgAccessStatus] = useState<'active' | 'locked' | 'loading'>('active');
  useEffect(() => {
    if (!auth.configured || !auth.orgId || !isSupabaseBrowserConfigured || !supabase) {
      setOrgAccessStatus('active');
      return;
    }
    let cancelled = false;
    setOrgAccessStatus('loading');
    (async () => {
      try {
        const { data } = await supabase!.from('org_access').select('status').eq('org_id', auth.orgId!).maybeSingle();
        if (cancelled) return;
        setOrgAccessStatus((data?.status as 'active' | 'locked') || 'active');
      } catch {
        if (!cancelled) setOrgAccessStatus('active');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.configured, auth.orgId]);

  // Leads State with LocalStorage Persistence
  const [leads, setLeads] = useState<Lead[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('omnireach_leads_v1');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch {}
      }
    }
    return INITIAL_LEADS;
  });

  // Clients (Lead[]) sync with Supabase, scoped to the signed-in org — same
  // graceful-degradation pattern as campaignSettings/channelSettings: falls back
  // to the localStorage-backed state above when Supabase/auth isn't available.
  const cloudClients = useCloudClients(auth.orgId);
  const loadedClientsForUser = React.useRef<string | null>(null);
  // Gates the sync effect below until the initial cloud load actually resolves. Without
  // this, both effects fire as soon as auth.orgId is set, and if the load (a real
  // network round-trip) takes longer than the sync's 600ms debounce, the sync effect wins
  // the race and upserts whatever `leads` happened to be first — on a fresh browser, the
  // INITIAL_LEADS sample data, or leftover localStorage from a previous session — into
  // this org's real Supabase row before the authoritative fetch ever lands.
  const cloudClientsReadyRef = React.useRef(false);
  useEffect(() => {
    const userId = auth.orgId;
    if (!userId || loadedClientsForUser.current === userId) return;
    loadedClientsForUser.current = userId;
    cloudClientsReadyRef.current = false;
    // Syncing only starts once the org's real leads have loaded — a failed load (network
    // blip) must never let the sample leads or another session's leftovers be uploaded
    // into this org. It retries instead, backing off up to 30s.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      cloudClients.loadClients().then((loaded) => {
        if (cancelled) return;
        if (loaded === null) {
          timer = setTimeout(() => load(attempt + 1), Math.min(30_000, 2_000 * 2 ** attempt));
          return;
        }
        setLeads(loaded);
        cloudClientsReadyRef.current = true;
      });
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (loadedClientsForUser.current === userId) loadedClientsForUser.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.orgId]);

  useEffect(() => {
    if (!auth.orgId || !cloudClientsReadyRef.current) return;
    const timer = setTimeout(() => {
      cloudClients.syncClients(leads);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, auth.orgId]);

  // Calendar Slots State
  const [calendarSlots, setCalendarSlots] = useState<CalendarSlot[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('omnireach_slots_v1');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {}
      }
    }
    return INITIAL_CALENDAR_SLOTS;
  });

  // Campaign identity/settings & channel credentials — synced to Supabase per
  // organization when signed in (multi-tenant dashboard), else localStorage only.
  const [campaignSettings, setCampaignSettings] = useCloudSettings<CampaignSettings>(
    'org_profile',
    'omnireach_campaign_settings_v1',
    DEFAULT_CAMPAIGN_SETTINGS,
    auth.orgId
  );
  const [channelSettings, setChannelSettings, channelSettingsStatus] = useCloudSettings<ChannelApiSettings>(
    'org_channel_settings',
    'omnireach_channels_v1',
    DEFAULT_CHANNEL_SETTINGS,
    auth.orgId
  );

  // Templates
  const [templates, setTemplates] = useState<MessageTemplate[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('omnireach_templates_v1');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {}
      }
    }
    return DEFAULT_TEMPLATES;
  });

  // Modals State
  const [isExcelModalOpen, setIsExcelModalOpen] = useState(false);
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingCheckedRef = React.useRef(false);
  useEffect(() => {
    if (onboardingCheckedRef.current) return;
    if (auth.configured && channelSettingsStatus.loading) return; // wait for real cloud data first
    onboardingCheckedRef.current = true;
    if (typeof window === 'undefined') return;
    const dismissed = localStorage.getItem('omnireach_onboarding_dismissed_v1');
    const nothingConfiguredYet =
      !campaignSettings.companyName &&
      !campaignSettings.senderName &&
      channelSettings.whatsAppProvider === 'web_direct' &&
      !hasChannelSecret(channelSettings, 'whatsappCloudApiKey');
    if (!dismissed && nothingConfiguredYet) setShowOnboarding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelSettingsStatus.loading]);
  const dismissOnboarding = () => {
    setShowOnboarding(false);
    try {
      localStorage.setItem('omnireach_onboarding_dismissed_v1', '1');
    } catch {}
  };

  // Selected Lead for Simulator
  const [selectedLeadId, setSelectedLeadId] = useState<string>(leads[0]?.id || 'lead-1');

  // Monthly usage limits (lib/usage.ts) — a banner once one is 80% used or reached.
  const usageNotice = usageWarning(useOrgUsage(auth.accessToken));
  const [usageNoticeDismissed, setUsageNoticeDismissed] = useState<string | null>(null);

  // Google/Outlook Calendar OAuth redirect banner
  const [calendarBanner, setCalendarBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleStatus = params.get('google_calendar');
    const outlookStatus = params.get('outlook_calendar');
    const emailStatus = params.get('email_connect');
    const crmStatus = params.get('crm_connect');
    const status = googleStatus || outlookStatus || emailStatus || crmStatus;
    const crmName = { hubspot: 'HubSpot', zoho: 'Zoho CRM', salesforce: 'Salesforce' }[params.get('crm') || ''] || 'Your CRM';
    const providerLabel = crmStatus
      ? crmName
      : emailStatus
      ? params.get('provider') === 'outlook'
        ? 'Outlook'
        : 'Gmail'
      : outlookStatus
        ? 'Outlook Calendar'
        : 'Google Calendar';
    if (status === 'connected') {
      setCalendarBanner({
        type: 'success',
        message: crmStatus
          ? `${providerLabel} connected — leads OmniReach contacts, call summaries and booked meetings will now appear there.`
          : emailStatus
          ? `${providerLabel} connected — campaign emails and AI replies now go out from your own mailbox.`
          : `${providerLabel} connected — the AI booking bot can now schedule real meetings.`,
      });
    } else if (status === 'error') {
      setCalendarBanner({ type: 'error', message: params.get('message') || `Failed to connect ${providerLabel}.` });
    }
    if (status) {
      params.delete('google_calendar');
      params.delete('outlook_calendar');
      params.delete('email_connect');
      params.delete('crm_connect');
      params.delete('crm');
      params.delete('provider');
      params.delete('message');
      const newSearch = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
    }
  }, []);

  // Sync to LocalStorage
  useEffect(() => {
    localStorage.setItem('omnireach_leads_v1', JSON.stringify(leads));
  }, [leads]);

  useEffect(() => {
    localStorage.setItem('omnireach_slots_v1', JSON.stringify(calendarSlots));
  }, [calendarSlots]);

  useEffect(() => {
    localStorage.setItem('omnireach_templates_v1', JSON.stringify(templates));
  }, [templates]);

  // Lead CRUD handlers
  const handleUpdateLead = (updated: Lead) => {
    setLeads((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
  };

  const handleAddLead = (newLead: Lead) => {
    setLeads((prev) => [newLead, ...prev]);
  };

  const handleDeleteLead = (id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    if (selectedLeadId === id && leads.length > 1) {
      setSelectedLeadId(leads.find((l) => l.id !== id)?.id || '');
    }
  };

  const handleResetLeads = () => {
    setLeads(INITIAL_LEADS);
    setCalendarSlots(INITIAL_CALENDAR_SLOTS);
    setSelectedLeadId(INITIAL_LEADS[0].id);
  };

  const handleResetAllLeadsToPending = () => {
    setLeads((prev) =>
      prev.map((l) => ({
        ...l,
        status: 'Pending',
        whatsAppStatus: 'Pending',
        emailStatus: 'Pending',
        voiceCallStatus: 'Pending',
      }))
    );
  };

  const handleImportLeads = (importedLeads: Lead[], appendMode: boolean) => {
    if (appendMode) {
      // Re-uploading the master sheet to add a handful of new leads is a natural workflow —
      // without dedup, every existing lead got a duplicate row with a fresh id, and the next
      // campaign run would silently double-message the same phone/email.
      setLeads((prev) => {
        const existingPhones = new Set(prev.map((l) => l.phone.replace(/\D/g, '')).filter(Boolean));
        const existingEmails = new Set(prev.map((l) => l.email.trim().toLowerCase()).filter(Boolean));
        const deduped = importedLeads.filter((l) => {
          const phoneDigits = l.phone.replace(/\D/g, '');
          const emailLower = l.email.trim().toLowerCase();
          const isDup = (phoneDigits && existingPhones.has(phoneDigits)) || (emailLower && existingEmails.has(emailLower));
          return !isDup;
        });
        return [...prev, ...deduped];
      });
    } else {
      setLeads(importedLeads);
    }
    if (importedLeads.length > 0) {
      setSelectedLeadId(importedLeads[0].id);
    }
    setActiveTab('campaign');
  };

  // Calendar Handlers
  const handleBookCalendarSlot = (slotId: string, lead: Lead, notes: string) => {
    setCalendarSlots((prev) =>
      prev.map((slot) =>
        slot.id === slotId
          ? {
              ...slot,
              available: false,
              bookedBy: lead.name,
              leadEmail: lead.email,
              leadPhone: lead.phone,
              title: `${lead.company || lead.name} Discovery Call with ${campaignSettings.senderName}`,
              meetLink: `https://meet.google.com/${Math.random().toString(36).substring(2, 5)}-${Math.random().toString(36).substring(2, 6)}-${Math.random().toString(36).substring(2, 5)}`,
            }
          : slot
      )
    );
  };

  const handleAddCalendarSlot = (date: string, time: string) => {
    const newSlot: CalendarSlot = {
      id: `slot-${Date.now()}`,
      date,
      time,
      dateTimeIso: `${date}T${time.includes('PM') ? '15:00:00Z' : '10:00:00Z'}`,
      available: true,
    };
    setCalendarSlots((prev) => [...prev, newSlot]);
  };

  const handleCancelCalendarSlot = (id: string) => {
    setCalendarSlots((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              available: true,
              bookedBy: undefined,
              leadEmail: undefined,
              leadPhone: undefined,
              title: undefined,
              meetLink: undefined,
            }
          : s
      )
    );
  };

  const handleOpenLeadInSimulator = (leadId: string) => {
    setSelectedLeadId(leadId);
    setActiveTab('simulator');
  };

  const handleStartCampaignWithSelected = (selectedIds: string[]) => {
    const selected = leads.filter((l) => selectedIds.includes(l.id));
    const unselected = leads.filter((l) => !selectedIds.includes(l.id));
    setLeads([...selected, ...unselected]);
    setActiveTab('campaign');
  };

  const pendingCount = leads.filter((l) => l.status === 'Pending').length;
  const scheduledCount = leads.filter((l) => l.status === 'Meeting Scheduled').length;

  if (orgAccessStatus === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-border-strong border-t-brand-strong rounded-full animate-spin" />
      </div>
    );
  }

  if (orgAccessStatus === 'locked' && !isAdmin) {
    return <AccessLockedScreen userEmail={auth.user?.email} onSignOut={auth.configured ? auth.signOut : undefined} />;
  }

  return (
    <div className="relative min-h-screen text-ink-secondary flex flex-col lg:flex-row font-sans">
      {/* Global Modals */}
      <ExcelUploadModal
        isOpen={isExcelModalOpen}
        onClose={() => setIsExcelModalOpen(false)}
        onImportLeads={handleImportLeads}
        defaultCountryCode={campaignSettings.defaultCountryCode || '+91'}
      />

      <ChannelConfigModal
        isOpen={isChannelModalOpen}
        onClose={() => setIsChannelModalOpen(false)}
        settings={channelSettings}
        onSaveSettings={setChannelSettings}
        campaignSettings={campaignSettings}
        availableSlots={calendarSlots}
        userId={auth.orgId}
        accessToken={auth.accessToken}
        onImportLeads={(imported) => handleImportLeads(imported, true)}
      />

      <OnboardingWizard
        isOpen={showOnboarding}
        onClose={dismissOnboarding}
        onHide={() => setShowOnboarding(false)}
        campaignSettings={campaignSettings}
        onUpdateSettings={setCampaignSettings}
        onOpenChannelConfig={() => setIsChannelModalOpen(true)}
        onOpenExcelUpload={() => setIsExcelModalOpen(true)}
      />

      {/* Sidebar Navigation */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        pendingCount={pendingCount}
        scheduledCount={scheduledCount}
        userId={auth.orgId}
        userEmail={auth.configured ? auth.user?.email ?? null : null}
        isAdmin={isAdmin}
        onSignOut={auth.configured ? auth.signOut : undefined}
        onOpenExcelUpload={() => setIsExcelModalOpen(true)}
        onOpenChannelConfig={() => setIsChannelModalOpen(true)}
      />

      <div className="flex-1 flex flex-col lg:pl-72 min-w-0">
      <AnimatePresence>
        {channelSettingsStatus.saveError && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 sm:px-6 lg:px-8 py-2 text-xs flex items-center justify-between bg-rose-500/10 text-rose-400">
              <span>
                Channel Setup couldn't save to the cloud ({channelSettingsStatus.saveError}) — your changes only exist in
                this browser right now. The AI bot reads settings from the cloud, so replies may keep using old
                credentials until this succeeds. Try saving again, or check you're still signed in.
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {calendarBanner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div
              className={`px-4 sm:px-6 lg:px-8 py-2 text-xs flex items-center justify-between ${
                calendarBanner.type === 'success' ? 'bg-[#128C7E]/15 text-emerald-300' : 'bg-rose-500/10 text-rose-400'
              }`}
            >
              <span>{calendarBanner.message}</span>
              <button onClick={() => setCalendarBanner(null)} className="opacity-70 hover:opacity-100">
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {usageNotice && usageNoticeDismissed !== usageNotice.message && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div
              className={`px-4 sm:px-6 lg:px-8 py-2 text-xs flex items-center justify-between gap-3 ${
                usageNotice.level === 'full' ? 'bg-rose-500/10 text-rose-400' : 'bg-amber-500/10 text-amber-300'
              }`}
            >
              <span>{usageNotice.message}</span>
              <button onClick={() => setUsageNoticeDismissed(usageNotice.message)} className="opacity-70 hover:opacity-100 shrink-0">
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main View Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <AnimatePresence mode="wait">
      <motion.div
        key={activeTab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {activeTab === 'dashboard' && (
          <DashboardView
            leads={leads}
            userId={auth.orgId}
            accessToken={auth.accessToken}
            onOpenExcelUpload={() => setIsExcelModalOpen(true)}
          />
        )}

        {activeTab === 'campaign' && (
          <BatchCampaignRunner
            leads={leads}
            availableSlots={calendarSlots}
            campaignSettings={campaignSettings}
            channelSettings={channelSettings}
            templates={templates}
            accessToken={auth.accessToken}
            userId={auth.orgId}
            onUpdateLead={handleUpdateLead}
            onUpdateSettings={setCampaignSettings}
            onResetAllLeadsToPending={handleResetAllLeadsToPending}
            onBookCalendarSlot={handleBookCalendarSlot}
            onOpenChannelConfig={() => setIsChannelModalOpen(true)}
            onOpenExcelUpload={() => setIsExcelModalOpen(true)}
            onSelectLeadForSimulator={handleOpenLeadInSimulator}
          />
        )}

        {activeTab === 'sheets' && (
          <SheetsView
            leads={leads}
            onAddLead={handleAddLead}
            onUpdateLead={handleUpdateLead}
            onDeleteLead={handleDeleteLead}
            // Demo mode only: in a real workspace this would replace (and delete) the org's leads.
            onResetLeads={auth.orgId ? undefined : handleResetLeads}
            onSelectLeadForSimulator={handleOpenLeadInSimulator}
            onOpenExcelUpload={() => setIsExcelModalOpen(true)}
            onStartCampaignWithSelected={handleStartCampaignWithSelected}
            defaultCountryCode={campaignSettings.defaultCountryCode}
          />
        )}

        {activeTab === 'simulator' && (
          <MessageSimulator
            leads={leads}
            selectedLeadId={selectedLeadId}
            onSelectLead={setSelectedLeadId}
            availableSlots={calendarSlots}
            campaignSettings={campaignSettings}
            channelSettings={channelSettings}
            templates={templates}
            accessToken={auth.accessToken}
            onUpdateLead={handleUpdateLead}
            onUpdateSettings={setCampaignSettings}
            onBookCalendarSlot={handleBookCalendarSlot}
          />
        )}

        {activeTab === 'templates' && (
          <TemplateManagerView
            templates={templates}
            onUpdateTemplates={setTemplates}
            campaignSettings={campaignSettings}
            onUpdateSettings={setCampaignSettings}
            leads={leads}
            availableSlots={calendarSlots}
            accessToken={auth.accessToken}
          />
        )}

        {activeTab === 'calendar' && (
          <CalendarView
            slots={calendarSlots}
            onAddSlot={handleAddCalendarSlot}
            onCancelSlot={handleCancelCalendarSlot}
          />
        )}

        {activeTab === 'inbox' && (
          <ConversationsView leads={leads} onUpdateLead={handleUpdateLead} accessToken={auth.accessToken} />
        )}

        {activeTab === 'learning' && (
          <AiLearningView
            accessToken={auth.accessToken}
            campaignSettings={campaignSettings}
            onUpdateSettings={setCampaignSettings}
          />
        )}

        {activeTab === 'reports' && <ReportsView accessToken={auth.accessToken} />}

        {activeTab === 'team' && <TeamView accessToken={auth.accessToken} />}

        {activeTab === 'admin' && isAdmin && <AdminDashboard accessToken={auth.accessToken} />}
      </motion.div>
      </AnimatePresence>
      </main>

      </div>
    </div>
  );
}
