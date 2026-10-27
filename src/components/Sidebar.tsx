import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Send,
  Table,
  Calendar,
  Settings2,
  Upload,
  MessageSquare,
  Zap,
  Bot,
  LayoutDashboard,
  Menu,
  X,
  LogOut,
  ShieldCheck,
  Sparkles,
  Mic,
  Users,
  BarChart3,
} from 'lucide-react';
import { NotificationBell } from './NotificationBell';

export type ActiveTab =
  | 'dashboard'
  | 'reports'
  | 'campaign'
  | 'sheets'
  | 'simulator'
  | 'templates'
  | 'calendar'
  | 'inbox'
  | 'learning'
  | 'voicetest'
  | 'team'
  | 'admin';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  pendingCount: number;
  scheduledCount: number;
  inboxCount?: number;
  userId?: string | null;
  userEmail?: string | null;
  isAdmin?: boolean;
  onSignOut?: () => void | Promise<void>;
  onOpenExcelUpload: () => void;
  onOpenChannelConfig: () => void;
}

interface NavItem {
  id: ActiveTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  pendingCount,
  scheduledCount,
  inboxCount,
  userId,
  userEmail,
  isAdmin,
  onSignOut,
  onOpenExcelUpload,
  onOpenChannelConfig,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const groups: NavGroup[] = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'reports', label: 'Reports', icon: BarChart3 },
      ],
    },
    {
      label: 'Outreach',
      items: [
        {
          id: 'campaign',
          label: 'Campaigns',
          icon: Send,
          badge: pendingCount > 0 ? `${pendingCount} ready` : undefined,
        },
        { id: 'sheets', label: 'Leads', icon: Table },
        { id: 'templates', label: 'Templates', icon: Settings2 },
      ],
    },
    {
      label: 'Conversations',
      items: [
        {
          id: 'inbox',
          label: 'AI Inbox',
          icon: Bot,
          badge: inboxCount && inboxCount > 0 ? `${inboxCount} live` : undefined,
        },
        { id: 'learning', label: 'AI Learning', icon: Sparkles },
        { id: 'voicetest', label: 'Test Voice Agent', icon: Mic },
        { id: 'simulator', label: 'Message Preview', icon: MessageSquare },
        {
          id: 'calendar',
          label: 'Meetings',
          icon: Calendar,
          badge: scheduledCount > 0 ? `${scheduledCount} booked` : undefined,
        },
      ],
    },
    ...(userId
      ? [
          {
            label: 'Workspace',
            items: [{ id: 'team' as const, label: 'Team', icon: Users }],
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            label: 'Platform',
            items: [{ id: 'admin' as const, label: 'Admin', icon: ShieldCheck }],
          },
        ]
      : []),
  ];

  const navButtonClass = (item: NavItem) => {
    const isActive = activeTab === item.id;
    return isActive ? 'bg-brand-strong text-white' : 'text-ink-muted hover:text-ink hover:bg-surface-hover';
  };

  const Logo = ({ compact }: { compact?: boolean }) => (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#25D366] via-[#128C7E] to-[#4285F4] flex items-center justify-center text-white shadow-sm ring-2 ring-[#25D366]/20 shrink-0">
        <Zap className="w-4.5 h-4.5 fill-white" />
      </div>
      {!compact && (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-base text-ink tracking-tight">OmniReach AI</span>
          </div>
          <span className="block text-[10px] text-ink-muted mt-0.5">AI outreach & booking</span>
        </div>
      )}
    </div>
  );

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  id={`nav-tab-${item.id}`}
                  onClick={() => {
                    setActiveTab(item.id);
                    onNavigate?.();
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${navButtonClass(item)}`}
                >
                  <Icon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? 'text-white' : 'text-ink-muted'
                    }`}
                  />
                  <span className="flex-1 text-left truncate">{item.label}</span>
                  {item.badge && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-medium shrink-0 ${
                        isActive ? 'bg-surface/20 text-white' : 'bg-border-strong text-ink-secondary'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const QuickActions = ({ onNavigate }: { onNavigate?: () => void }) => (
    <div className="p-3 border-t border-border space-y-1.5">
      {userEmail && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-hover/50 backdrop-blur-xl border border-border mb-1.5">
          <span className="text-[11px] text-ink-muted truncate" title={userEmail}>
            {userEmail}
          </span>
          {onSignOut && (
            <button
              onClick={() => onSignOut()}
              className="p-1 rounded-md text-ink-muted hover:text-ink shrink-0 transition-colors"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      <button
        id="header-channel-config-btn"
        onClick={() => {
          onOpenChannelConfig();
          onNavigate?.();
        }}
        className="w-full inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-ink-secondary bg-surface-hover/50 backdrop-blur-xl hover:bg-surface-hover border border-border transition-colors"
        title="Connect WhatsApp, Email, Voice and Calendar"
      >
        <Settings2 className="w-3.5 h-3.5 text-ink-muted" />
        <span>Channel Setup</span>
      </button>
      <button
        id="header-import-excel-btn"
        onClick={() => {
          onOpenExcelUpload();
          onNavigate?.();
        }}
        className="w-full inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98]"
      >
        <Upload className="w-3.5 h-3.5" />
        <span>Import Leads</span>
      </button>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-3 left-3 w-64 flex-col rounded-2xl border border-border bg-surface/10 backdrop-blur-3xl backdrop-saturate-200 shadow-elevated z-40">
        <div className="h-16 flex items-center justify-between px-4 border-b border-border shrink-0">
          <Logo />
          <NotificationBell userId={userId} onOpenInbox={() => setActiveTab('inbox')} align="left" />
        </div>
        <NavList />
        <QuickActions />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 h-14 flex items-center justify-between px-4 border-b border-white/5 bg-surface/10 backdrop-blur-3xl backdrop-saturate-200">
        <Logo compact />
        <div className="flex items-center gap-1">
          <NotificationBell userId={userId} onOpenInbox={() => setActiveTab('inbox')} />
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-ink-muted hover:bg-surface-hover"
            aria-label="Open navigation menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="lg:hidden fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          >
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="h-full w-72 max-w-[80vw] bg-surface/30 backdrop-blur-3xl backdrop-saturate-200 border-r border-white/10 shadow-modal flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-16 flex items-center justify-between px-4 border-b border-border shrink-0">
                <Logo />
                <button
                  onClick={() => setMobileOpen(false)}
                  className="p-2 rounded-lg text-ink-muted hover:bg-surface-hover"
                  aria-label="Close navigation menu"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
              <NavList onNavigate={() => setMobileOpen(false)} />
              <QuickActions onNavigate={() => setMobileOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
