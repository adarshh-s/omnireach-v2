import React from 'react';
import { Lock, Mail, LogOut } from 'lucide-react';

interface AccessLockedScreenProps {
  userEmail?: string | null;
  onSignOut?: () => void;
}

const CONTACT_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || undefined;

/** Shown instead of the whole app when an org's access status is 'locked' — no self-serve
 * subscription checkout exists, so every new signup starts here until the platform owner
 * manually activates them (Admin dashboard) after a direct conversation and payment. */
export const AccessLockedScreen: React.FC<AccessLockedScreenProps> = ({ userEmail, onSignOut }) => {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-8 shadow-elevated text-center">
        <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto mb-4 text-amber-400">
          <Lock className="w-5 h-5" />
        </div>
        <h1 className="text-lg font-bold text-ink">Your workspace isn't active yet</h1>
        <p className="text-sm text-ink-secondary mt-2 leading-relaxed">
          Access here is set up individually rather than through self-serve billing. Get in
          touch to go over what you need and get your workspace switched on.
        </p>

        {CONTACT_EMAIL && (
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Activate my OmniReach AI workspace')}`}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-brand-strong hover:bg-[#0d6e62] text-white text-sm font-semibold shadow-sm transition-all"
          >
            <Mail className="w-4 h-4" />
            <span>Contact us to get started</span>
          </a>
        )}

        {userEmail && (
          <p className="text-xs text-ink-muted mt-4">Signed in as {userEmail}</p>
        )}

        {onSignOut && (
          <button
            onClick={onSignOut}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        )}
      </div>
    </div>
  );
};
