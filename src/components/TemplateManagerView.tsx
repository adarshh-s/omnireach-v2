import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Settings2,
  Sparkles,
  MessageSquare,
  Mail,
  Plus,
  Trash2,
  Check,
  Copy,
  Layers,
  HelpCircle,
  Eye,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { MessageTemplate, CampaignSettings, Lead, CalendarSlot } from '../types';
import { interpolateTemplate } from '../utils/outreachEngine';
import { AdvancedSection } from './AdvancedSection';

interface TemplateManagerViewProps {
  templates: MessageTemplate[];
  onUpdateTemplates: (templates: MessageTemplate[]) => void;
  campaignSettings: CampaignSettings;
  onUpdateSettings: (settings: CampaignSettings) => void;
  leads: Lead[];
  availableSlots: CalendarSlot[];
  accessToken?: string | null;
}

export const TemplateManagerView: React.FC<TemplateManagerViewProps> = ({
  templates,
  onUpdateTemplates,
  campaignSettings,
  onUpdateSettings,
  leads,
  availableSlots,
  accessToken,
}) => {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    templates[0]?.id || 'tpl-1'
  );
  const [isGeneratingWithAi, setIsGeneratingWithAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [copiedVar, setCopiedVar] = useState<string | null>(null);

  const activeTemplate =
    templates.find((t) => t.id === selectedTemplateId) || templates[0];
  const sampleLead = leads[0] || {
    id: 'sample',
    name: 'Jane Doe',
    company: 'Sample Company LLC',
    phone: '+971501234567',
    email: 'jane.doe@example.com',
    status: 'Pending',
    whatsAppStatus: 'Pending',
    emailStatus: 'Pending',
    isValidPhone: true,
    isValidEmail: true,
  };

  const variables = [
    { tag: '{{name}}', label: 'Full Name' },
    { tag: '{{first_name}}', label: 'First Name' },
    { tag: '{{company}}', label: 'Client Company' },
    { tag: '{{email}}', label: 'Client Email' },
    { tag: '{{phone}}', label: 'Client Phone' },
    { tag: '{{company_name}}', label: 'Your Company' },
    { tag: '{{sender_name}}', label: 'Your Name' },
  ];

  const handleUpdateActiveTemplate = (field: keyof MessageTemplate, value: string) => {
    if (!activeTemplate) return;
    const updated = templates.map((t) =>
      t.id === activeTemplate.id ? { ...t, [field]: value } : t
    );
    onUpdateTemplates(updated);
  };

  const handleAddNewTemplate = () => {
    const newTpl: MessageTemplate = {
      id: `tpl-${Date.now()}`,
      name: 'New Custom Sequence',
      category: 'custom',
      channel: 'omnichannel',
      whatsAppContent: `Hi {{first_name}} 👋! Reaching out from {{company_name}} regarding {{company}}. Would you have 5 mins for a quick chat? Just reply with a day/time that works for you!`,
      emailSubject: `Quick idea for {{company}}'s team`,
      emailBody: `Hi {{first_name}},\n\nI hope you're having a great week.\n\nI'm reaching out from {{company_name}}. We'd love to show you how we help teams at {{company}} streamline their operations.\n\nJust reply with a day/time that works for you and I'll get it on the calendar.\n\nBest,\n{{sender_name}}`,
    };

    onUpdateTemplates([...templates, newTpl]);
    setSelectedTemplateId(newTpl.id);
  };

  const handleDeleteTemplate = (id: string) => {
    if (templates.length <= 1) return;
    const filtered = templates.filter((t) => t.id !== id);
    onUpdateTemplates(filtered);
    setSelectedTemplateId(filtered[0].id);
  };

  const handleGenerateWithAi = async () => {
    setIsGeneratingWithAi(true);
    setAiError(null);
    try {
      const res = await fetch('/api/outreach/generate-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          lead: sampleLead,
          settings: campaignSettings,
          availableSlots,
          template: activeTemplate,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        if (data.whatsApp && data.emailSubject && data.emailBody && activeTemplate) {
          const updated = templates.map((t) =>
            t.id === activeTemplate.id
              ? {
                  ...t,
                  whatsAppContent: data.whatsApp,
                  emailSubject: data.emailSubject,
                  emailBody: data.emailBody,
                }
              : t
          );
          onUpdateTemplates(updated);
        } else {
          setAiError('The AI response was missing a message or email — nothing was changed.');
        }
      } else {
        setAiError(
          res.status === 401
            ? 'You need to be signed in to use AI rewrite.'
            : data?.error || 'AI rewrite failed — please try again.'
        );
      }
    } catch (e: any) {
      setAiError(e?.message || 'Could not reach the server to generate a rewrite.');
    } finally {
      setIsGeneratingWithAi(false);
    }
  };

  const handleCopyVar = (tag: string) => {
    navigator.clipboard.writeText(tag);
    setCopiedVar(tag);
    setTimeout(() => setCopiedVar(null), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Settings Header */}
      <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-ink">
                AI Copywriter & Outreach Sequence Studio
              </h1>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#25D366]/15 text-[#128C7E]">
                Gemini 3.7 Powered
              </span>
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              Customize WhatsApp message copies and Cold Outreach emails with dynamic spreadsheet placeholder variables.
            </p>
          </div>

          <button
            id="tpl-ai-generate-btn"
            onClick={handleGenerateWithAi}
            disabled={isGeneratingWithAi}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl text-white bg-gradient-to-r from-[#128C7E] to-[#25D366] hover:opacity-95 shadow-xs transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <Sparkles className={`w-3.5 h-3.5 ${isGeneratingWithAi ? 'animate-spin' : ''}`} />
            <span>{isGeneratingWithAi ? 'AI Generating Copy...' : 'AI Rewrite Active Template'}</span>
          </button>
        </div>

        {aiError && (
          <p className="mt-2 text-xs font-medium text-rose-400">{aiError}</p>
        )}

        <AdvancedSection label="Sender details & AI tone" className="mt-4 pt-4 border-t border-border">
          {/* Sender & Company Settings Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Your Company Name
              </label>
              <input
                type="text"
                value={campaignSettings.companyName}
                onChange={(e) =>
                  onUpdateSettings({ ...campaignSettings, companyName: e.target.value })
                }
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Sender Full Name
              </label>
              <input
                type="text"
                value={campaignSettings.senderName}
                onChange={(e) =>
                  onUpdateSettings({ ...campaignSettings, senderName: e.target.value })
                }
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Sender Email Address
              </label>
              <input
                type="email"
                value={campaignSettings.senderEmail}
                onChange={(e) =>
                  onUpdateSettings({ ...campaignSettings, senderEmail: e.target.value })
                }
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Value Proposition / Pitch Notes
              </label>
              <input
                type="text"
                value={campaignSettings.serviceDescription}
                onChange={(e) =>
                  onUpdateSettings({ ...campaignSettings, serviceDescription: e.target.value })
                }
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink-muted mb-1">
              AI Tone & Focus Instructions
            </label>
            <textarea
              rows={2}
              value={campaignSettings.customInstructions || ''}
              onChange={(e) => onUpdateSettings({ ...campaignSettings, customInstructions: e.target.value })}
              placeholder="e.g. Keep messages conversational, clear, friendly, and focused on booking a quick call."
              className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink resize-none"
            />
            <p className="text-[10px] text-ink-muted mt-1">
              Guides the tone and priorities of AI-generated messages — e.g. "keep it casual," "lead with pricing," or
              "focus on the free trial."
            </p>
          </div>
        </AdvancedSection>
      </div>

      {/* Main Studio Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Template Selector Sidebar */}
        <div className="lg:col-span-4 space-y-3">
          <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-4 shadow-card">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                Saved Templates ({templates.length})
              </h2>
              <button
                onClick={handleAddNewTemplate}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#128C7E] hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New</span>
              </button>
            </div>

            <div className="mt-3 space-y-1.5">
              {templates.map((tpl, i) => (
                <motion.button
                  key={tpl.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03, ease: 'easeOut' }}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setSelectedTemplateId(tpl.id)}
                  className={`w-full text-left p-3 rounded-xl text-xs transition-colors flex items-center justify-between ${
                    tpl.id === activeTemplate?.id
                      ? 'bg-[#25D366]/10 border border-[#25D366]/30 text-emerald-300 font-semibold'
                      : 'bg-canvas hover:bg-surface-hover border border-transparent text-ink-secondary'
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="font-semibold">{tpl.name}</div>
                    <div className="text-[10px] text-ink-muted capitalize mt-0.5">
                      {tpl.category} • {tpl.channel}
                    </div>
                  </div>
                  {templates.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTemplate(tpl.id);
                      }}
                      className="p-1 text-ink-muted hover:text-red-400 transition-colors"
                      title="Delete template"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </motion.button>
              ))}
            </div>

            {/* Variable Insertion Pills */}
            <div className="mt-5 pt-4 border-t border-border">
              <div className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
                Click to Copy Spreadsheet Variables
              </div>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <button
                    key={v.tag}
                    onClick={() => handleCopyVar(v.tag)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-canvas hover:bg-[#128C7E]/10 border border-border-strong text-[11px] font-mono text-ink transition-colors"
                    title={`Click to copy ${v.label}`}
                  >
                    <span>{v.tag}</span>
                    {copiedVar === v.tag && <Check className="w-2.5 h-2.5 text-[#25D366]" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Active Template Editor & Live Lead Preview */}
        <div className="lg:col-span-8 space-y-4">
          {activeTemplate && (
            <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card space-y-5">
              {/* Template Name */}
              <div>
                <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                  Template Title
                </label>
                <input
                  type="text"
                  value={activeTemplate.name}
                  onChange={(e) => handleUpdateActiveTemplate('name', e.target.value)}
                  className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs font-semibold text-ink"
                />
              </div>

              {/* WhatsApp Content Editor */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#128C7E] flex items-center gap-1.5">
                    <MessageSquare className="w-4 h-4 text-[#25D366]" />
                    <span>WhatsApp Message Template</span>
                  </label>
                  <span className="text-[11px] text-ink-muted">Supports *bold*, emojis, variables</span>
                </div>
                <textarea
                  rows={5}
                  value={activeTemplate.whatsAppContent}
                  onChange={(e) => handleUpdateActiveTemplate('whatsAppContent', e.target.value)}
                  className="w-full bg-canvas border border-border-strong rounded-xl p-3 text-xs text-ink focus:ring-1 focus:ring-[#25D366] font-sans leading-relaxed"
                />
              </div>

              {/* Email Subject & Body Editor */}
              <div className="space-y-3 pt-3 border-t border-border">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#1967D2] flex items-center gap-1.5">
                    <Mail className="w-4 h-4 text-[#4285F4]" />
                    <span>Email Outreach Template</span>
                  </label>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                    Email Subject Line
                  </label>
                  <input
                    type="text"
                    value={activeTemplate.emailSubject}
                    onChange={(e) => handleUpdateActiveTemplate('emailSubject', e.target.value)}
                    className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink font-semibold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                    Email Body
                  </label>
                  <textarea
                    rows={7}
                    value={activeTemplate.emailBody}
                    onChange={(e) => handleUpdateActiveTemplate('emailBody', e.target.value)}
                    className="w-full bg-canvas border border-border-strong rounded-xl p-3 text-xs text-ink focus:ring-1 focus:ring-[#4285F4] font-sans leading-relaxed"
                  />
                </div>
              </div>

              {/* Live Render Preview on Sample Lead */}
              <div className="pt-4 border-t border-border space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-ink">
                  <Eye className="w-3.5 h-3.5 text-ink-muted" />
                  <span>Live Render Preview (Sample Contact: {sampleLead.name})</span>
                </div>
                <div className="p-3.5 bg-canvas rounded-xl border border-border text-xs text-ink-secondary whitespace-pre-line font-sans">
                  {interpolateTemplate(
                    activeTemplate.whatsAppContent,
                    sampleLead,
                    campaignSettings,
                    availableSlots
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
