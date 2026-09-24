import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Zap, ArrowRight, MessageSquare, Mail, Calendar, Upload, CheckCircle2, X } from 'lucide-react';
import { CampaignSettings } from '../types';

interface OnboardingWizardProps {
  isOpen: boolean;
  /** Permanently dismisses the wizard (won't resurface on future loads) — the X button,
   * "Skip for now", and finishing the flow. */
  onClose: () => void;
  /** Just hides the wizard for this navigation, without marking it permanently dismissed —
   * used by the mid-flow CTAs ("Open Channel Setup"/"Import Excel") so someone who only
   * peeked at Settings without actually configuring anything still gets the nudge again
   * next time, instead of it vanishing forever the moment they glanced at a sub-screen. */
  onHide: () => void;
  campaignSettings: CampaignSettings;
  onUpdateSettings: (settings: CampaignSettings) => void;
  onOpenChannelConfig: () => void;
  onOpenExcelUpload: () => void;
}

type Step = 'welcome' | 'profile' | 'channels' | 'leads' | 'done';
const STEPS: Step[] = ['welcome', 'profile', 'channels', 'leads', 'done'];

/**
 * First-run guided setup, shown once to a brand-new org with nothing configured yet.
 * Deliberately a thin, sequential wrapper around the real surfaces (Channel Setup, Excel
 * import) rather than a re-implementation of their forms — "Open Channel Setup" / "Import
 * Leads" hand off to the actual modals so there's exactly one place each piece of setup
 * logic lives.
 */
export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  isOpen,
  onClose,
  onHide,
  campaignSettings,
  onUpdateSettings,
  onOpenChannelConfig,
  onOpenExcelUpload,
}) => {
  const [step, setStep] = useState<Step>('welcome');
  const stepIndex = STEPS.indexOf(step);
  const goNext = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#18181B]/40 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="bg-surface/65 backdrop-blur-3xl border border-white/10 ring-1 ring-white/5 rounded-3xl max-w-lg w-full shadow-modal overflow-hidden flex flex-col"
          >
            {/* Progress dots */}
            <div className="px-6 pt-5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {STEPS.map((s, i) => (
                  <span
                    key={s}
                    className={`h-1.5 rounded-full transition-all ${
                      i === stepIndex ? 'w-6 bg-[#128C7E]' : i < stepIndex ? 'w-1.5 bg-[#128C7E]/50' : 'w-1.5 bg-border-strong'
                    }`}
                  />
                ))}
              </div>
              <button onClick={onClose} className="p-1.5 rounded-full text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 pt-4 space-y-5">
              {step === 'welcome' && (
                <div className="text-center space-y-3 py-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-[#25D366] via-[#128C7E] to-[#4285F4] flex items-center justify-center text-white shadow-sm mx-auto">
                    <Zap className="w-7 h-7 fill-white" />
                  </div>
                  <h2 className="text-lg font-bold text-ink">Welcome to OmniReach AI</h2>
                  <p className="text-sm text-ink-secondary max-w-sm mx-auto">
                    Let's get your workspace set up — connecting WhatsApp, Email, and Calendar takes about 2 minutes.
                  </p>
                </div>
              )}

              {step === 'profile' && (
                <div className="space-y-3">
                  <h2 className="text-base font-bold text-ink">Tell us about your business</h2>
                  <p className="text-xs text-ink-muted">This shapes every AI-generated message you send.</p>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">Company Name</label>
                    <input
                      type="text"
                      value={campaignSettings.companyName}
                      onChange={(e) => onUpdateSettings({ ...campaignSettings, companyName: e.target.value })}
                      placeholder="Acme Inc."
                      className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-sm text-ink"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">Your Full Name</label>
                    <input
                      type="text"
                      value={campaignSettings.senderName}
                      onChange={(e) => onUpdateSettings({ ...campaignSettings, senderName: e.target.value })}
                      placeholder="Jane Doe"
                      className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-sm text-ink"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">Your Email</label>
                    <input
                      type="email"
                      value={campaignSettings.senderEmail}
                      onChange={(e) => onUpdateSettings({ ...campaignSettings, senderEmail: e.target.value })}
                      placeholder="jane@acme.com"
                      className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-sm text-ink"
                    />
                  </div>
                </div>
              )}

              {step === 'channels' && (
                <div className="space-y-3">
                  <h2 className="text-base font-bold text-ink">Connect your channels</h2>
                  <p className="text-xs text-ink-muted">
                    WhatsApp, Email, and Google Calendar credentials live in Channel Setup — open it now, or skip and
                    do it later.
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-canvas border border-border text-xs text-ink-secondary">
                      <MessageSquare className="w-4 h-4 text-[#25D366] shrink-0" />
                      <span>WhatsApp Cloud API — for cold outreach & AI replies</span>
                    </div>
                    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-canvas border border-border text-xs text-ink-secondary">
                      <Mail className="w-4 h-4 text-[#4285F4] shrink-0" />
                      <span>Email — works out of the box, no setup required</span>
                    </div>
                    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-canvas border border-border text-xs text-ink-secondary">
                      <Calendar className="w-4 h-4 text-[#4285F4] shrink-0" />
                      <span>Google Calendar — so booked meetings show up automatically</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChannelConfig();
                      onHide();
                    }}
                    className="w-full py-2.5 rounded-xl bg-brand-strong hover:bg-[#0d6e62] text-white text-sm font-medium shadow-sm transition-all"
                  >
                    Open Channel Setup
                  </button>
                </div>
              )}

              {step === 'leads' && (
                <div className="space-y-3">
                  <h2 className="text-base font-bold text-ink">Import your first leads</h2>
                  <p className="text-xs text-ink-muted">
                    Upload an Excel or CSV file with names, phone numbers, and emails — we'll auto-detect the columns.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenExcelUpload();
                      onHide();
                    }}
                    className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-brand-strong hover:bg-[#0d6e62] text-white text-sm font-medium shadow-sm transition-all"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Import Excel / CSV</span>
                  </button>
                </div>
              )}

              {step === 'done' && (
                <div className="text-center space-y-3 py-4">
                  <div className="w-14 h-14 rounded-full bg-[#128C7E]/10 border border-[#128C7E]/30 flex items-center justify-center mx-auto text-emerald-300">
                    <CheckCircle2 className="w-7 h-7 text-[#25D366]" />
                  </div>
                  <h2 className="text-lg font-bold text-ink">You're all set!</h2>
                  <p className="text-sm text-ink-secondary max-w-sm mx-auto">
                    Head to Batch Outreach when you're ready to launch your first campaign. You can always revisit
                    Channel Setup from the sidebar.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                {step !== 'welcome' && step !== 'done' ? (
                  <button
                    type="button"
                    onClick={onClose}
                    className="text-xs text-ink-muted hover:text-ink font-medium"
                  >
                    Skip for now
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={step === 'done' ? onClose : goNext}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg text-white bg-[#128C7E] hover:bg-[#0E6D62] shadow-sm transition-all active:scale-[0.98]"
                >
                  <span>{step === 'welcome' ? "Let's go" : step === 'done' ? 'Get Started' : 'Continue'}</span>
                  {step !== 'done' && <ArrowRight className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
