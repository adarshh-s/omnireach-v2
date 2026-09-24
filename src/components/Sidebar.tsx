import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Send,
  Table,
  Calendar,
  Settings2,
  BarChart3,
  Upload,
  MessageSquare,
  Zap,
  Bot,
  LayoutDashboard,
  Menu,
  X,
} from 'lucide-react';
import { NotificationBell } from './NotificationBell';

export type ActiveTab =
  | 'dashboard'
  | 'campaign'
  | 'sheets'
  | 'simulator'
  | 'templates'
  | 'calendar'
  | 'inbox'
  | 'analytics';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  pendingCount: number;
  scheduledCount: number;
  inboxCount?: number;
  userId?: string | null;
  onOpenExcelUpload: () => void;
  onOpenChannelConfig: () => void;
}

interface NavItem {
  id: ActiveTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  isSpecial?: boolean;
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
  onOpenExcelUpload,
  onOpenChannelConfig,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const groups: NavGroup[] = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'analytics', label: 'Analytics', icon: BarChart3 },
      ],
    },
    {
      label: 'Outreach',
      items: [
        {
          id: 'campaign',
          label: 'Batch Outreach',
          icon: Send,
          badge: pendingCount > 0 ? `${pendingCount} Ready` : undefined,
          isSpecial: true,
        },
        { id: 'sheets', label: 'Spreadsheet & Leads', icon: Table },
        { id: 'templates', label: 'AI Copy & Templates', icon: Settings2 },
      ],
    },
    {
      label: 'Conversations',
      items: [
        {
          id: 'inbox',
          label: 'AI Inbox',
          icon: Bot,
          badge: inboxCount && inboxCount > 0 ? `${inboxCount} Live` : undefined,
        },
        { id: 'simulator', label: 'Chat & Email Preview', icon: MessageSquare },
        {
          id: 'calendar',
          label: 'Google Calendar',
          icon: Calendar,
          badge: scheduledCount > 0 ? `${scheduledCount} Booked` : undefined,
        },
      ],
    },
  ];

  const navButtonClass = (item: NavItem) => {
    const isActive = activeTab === item.id;
    if (!isActive) {
      return 'text-ink-muted hover:text-ink hover:bg-surface-hover';
    }
    return item.isSpecial
      ? 'bg-brand/10 text-emerald-300 font-semibold border border-brand/30'
      : 'bg-brand-strong text-white';
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
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-brand/10 text-emerald-300 border border-brand/30 inline-flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#25D366] animate-pulse"></span>
            WhatsApp + Email
          </span>
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
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${navButtonClass(item)}`}
                >
                  <Icon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? (item.isSpecial ? 'text-[#128C7E]' : 'text-white') : 'text-ink-muted'
                    }`}
                  />
                  <span className="flex-1 text-left truncate">{item.label}</span>
                  {item.badge && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-medium shrink-0 ${
                        isActive
                          ? item.isSpecial
                            ? 'bg-[#25D366] text-white'
                            : 'bg-surface/20 text-white'
                          : 'bg-border-strong text-ink-secondary'
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
      <button
        id="header-channel-config-btn"
        onClick={() => {
          onOpenChannelConfig();
          onNavigate?.();
        }}
        className="w-full inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-ink-secondary bg-surface-hover/50 backdrop-blur-xl hover:bg-surface-hover border border-border transition-colors"
        title="Configure WhatsApp & Email API keys"
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
        <span>Import Excel / CSV</span>
      </button>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 flex-col border-r border-border bg-surface/25 backdrop-blur-3xl backdrop-saturate-150 z-40">
        <div className="h-16 flex items-center justify-between px-4 border-b border-border shrink-0">
          <Logo />
          <NotificationBell userId={userId} onOpenInbox={() => setActiveTab('inbox')} align="left" />
        </div>
        <NavList />
        <QuickActions />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 h-14 flex items-center justify-between px-4 border-b border-white/5 bg-surface/25 backdrop-blur-3xl backdrop-saturate-150">
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
              className="h-full w-72 max-w-[80vw] bg-surface/50 backdrop-blur-3xl border-r border-white/10 shadow-modal flex flex-col"
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
