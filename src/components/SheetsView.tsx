import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Table,
  Plus,
  Send,
  MessageSquare,
  Mail,
  Download,
  RotateCcw,
  Search,
  Filter,
  CheckCircle2,
  Calendar,
  Sparkles,
  ExternalLink,
  Edit2,
  Trash2,
  FileSpreadsheet,
  Upload,
  AlertTriangle,
  Layers,
  CheckSquare,
  Square,
  Clock,
} from 'lucide-react';
import { Lead, LeadStatus, ChannelDeliveryStatus } from '../types';
import { exportLeadsToExcel, sanitizePhoneNumber } from '../utils/excelParser';
import { AdvancedSection } from './AdvancedSection';

interface SheetsViewProps {
  leads: Lead[];
  onAddLead: (lead: Lead) => void;
  onUpdateLead: (lead: Lead) => void;
  onDeleteLead: (id: string) => void;
  onResetLeads: () => void;
  onSelectLeadForSimulator: (leadId: string) => void;
  onOpenExcelUpload: () => void;
  onStartCampaignWithSelected?: (selectedIds: string[]) => void;
  /** Falls back to +91 (matching excelParser's own default) when not provided. */
  defaultCountryCode?: string;
}

export const SheetsView: React.FC<SheetsViewProps> = ({
  leads,
  onAddLead,
  onUpdateLead,
  onDeleteLead,
  onResetLeads,
  onSelectLeadForSimulator,
  onOpenExcelUpload,
  onStartCampaignWithSelected,
  defaultCountryCode,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterChannel, setFilterChannel] = useState<string>('ALL');
  const [isAddingLead, setIsAddingLead] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);

  // New Lead Form State
  const [newLead, setNewLead] = useState({
    name: '',
    company: '',
    phone: '',
    email: '',
    country: '',
    notes: '',
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.name) return;

    // Previously hardcoded +91 whenever the typed number had no leading "+" — a lead
    // manually added with Country set to e.g. "United States" and a bare 10-digit number
    // silently got saved as an Indian number, and any WhatsApp send went to a real, wrong
    // number. Reuses the same country-aware sanitizer the Excel import path already uses.
    const { formatted, isValid: isPhoneValid } = sanitizePhoneNumber(newLead.phone, defaultCountryCode || '+91');
    const lead: Lead = {
      id: `lead-${Date.now()}`,
      name: newLead.name,
      company: newLead.company || 'Prospective Client',
      phone: formatted || newLead.phone,
      rawPhone: newLead.phone,
      email: newLead.email,
      country: newLead.country || undefined,
      status: 'Pending',
      whatsAppStatus: 'Pending',
      emailStatus: 'Pending',
      notes: newLead.notes || '',
      lastContacted: '',
      isValidPhone: isPhoneValid,
      isValidEmail: Boolean(newLead.email && newLead.email.includes('@') && newLead.email.includes('.')),
    };

    onAddLead(lead);
    setNewLead({ name: '', company: '', phone: '', email: '', country: '', notes: '' });
    setIsAddingLead(false);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLead) return;
    // Re-derive validity from whatever phone/email the user just typed — these flags are
    // what the batch outreach engine checks before sending, so a lead edited to add an
    // email/phone that was previously missing must be re-validated here, not left stuck
    // on the isValidPhone/isValidEmail computed back when the lead was first imported.
    const { formatted, isValid: isPhoneValid } = sanitizePhoneNumber(editingLead.phone, defaultCountryCode || '+91');
    onUpdateLead({
      ...editingLead,
      phone: formatted || editingLead.phone,
      isValidPhone: isPhoneValid,
      isValidEmail: Boolean(editingLead.email && editingLead.email.includes('@') && editingLead.email.includes('.')),
    });
    setEditingLead(null);
  };

  // Deleting a selected lead (or replacing the whole list via import) used to leave its id
  // in selectedIds forever — the "N leads selected" bar kept counting leads that no longer
  // exist, and a bulk action would silently include stale ids. Prune on every leads change.
  useEffect(() => {
    setSelectedIds((prev) => {
      const liveIds = new Set(leads.map((l) => l.id));
      const next = prev.filter((id) => liveIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [leads]);

  const toggleSelectAll = () => {
    // Comparing lengths alone was wrong once the filter changes: switching to a different
    // subset that happens to be the same size showed the header checkbox as "all selected"
    // even though none of the currently-visible rows were actually selected. Compare the
    // actual id sets instead.
    const filteredIds = filteredLeads.map((l) => l.id);
    const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.includes(id));
    if (allFilteredSelected) {
      setSelectedIds((prev) => prev.filter((id) => !filteredIds.includes(id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...filteredIds])]);
    }
  };

  const toggleSelectLead = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const filteredLeads = leads.filter((l) => {
    const matchesSearch =
      l.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.company.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.phone.includes(searchTerm) ||
      l.email.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      filterStatus === 'ALL' ||
      (filterStatus === 'PENDING' && l.status === 'Pending') ||
      (filterStatus === 'CONTACTED' && (l.status === 'Contacted' || l.status === 'Interested')) ||
      (filterStatus === 'BOOKED' && l.status === 'Meeting Scheduled');

    const matchesChannel =
      filterChannel === 'ALL' ||
      (filterChannel === 'WA_SENT' && l.whatsAppStatus !== 'Pending') ||
      (filterChannel === 'EMAIL_SENT' && l.emailStatus !== 'Pending') ||
      (filterChannel === 'REPLIED' && (l.whatsAppStatus === 'Replied' || l.emailStatus === 'Replied'));

    return matchesSearch && matchesStatus && matchesChannel;
  });

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="bg-surface/70 backdrop-blur-2xl rounded-2xl border border-border p-4 sm:p-5 shadow-card">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-ink">
                Client Outreach Spreadsheet & Lead Records
              </h2>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-canvas border border-border-strong text-ink-muted">
                {leads.length} Total Rows
              </span>
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              Live two-way synced contact records. Ingest Excel sheets, monitor WhatsApp & Email delivery status, and launch targeted sequences.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              id="sheet-add-lead-btn"
              onClick={() => setIsAddingLead(!isAddingLead)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-canvas hover:bg-surface-hover border border-border-strong text-ink transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Lead</span>
            </button>

            <button
              id="sheet-import-excel-btn"
              onClick={onOpenExcelUpload}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-canvas hover:bg-surface-hover border border-border-strong text-ink transition-colors"
            >
              <Upload className="w-3.5 h-3.5 text-ink-muted" />
              <span>Import Sheet</span>
            </button>

            <button
              id="sheet-export-excel-btn"
              onClick={() => exportLeadsToExcel(leads)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-canvas hover:bg-surface-hover border border-border-strong text-ink transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-ink-muted" />
              <span>Export Excel</span>
            </button>

            <button
              id="sheet-reset-btn"
              onClick={onResetLeads}
              className="p-2 text-xs font-semibold rounded-lg text-ink-muted hover:text-ink hover:bg-surface-hover border border-border-strong transition-colors"
              title="Reset to initial sample leads"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="mt-4 pt-4 border-t border-border space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-ink-muted absolute left-3 top-2.5" />
            <input
              id="sheet-search-input"
              type="text"
              placeholder="Search by name, company, phone, or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-canvas border border-border-strong rounded-lg pl-9 pr-3 py-2 text-xs text-ink placeholder-ink-muted focus:ring-1 focus:ring-[#25D366] focus:border-[#25D366]"
            />
          </div>

          <AdvancedSection
            label={filterStatus !== 'ALL' || filterChannel !== 'ALL' ? 'Filters (active)' : 'Filters'}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Status Filter */}
              <select
                id="sheet-status-filter"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-xs text-ink"
              >
                <option value="ALL">All Lead Statuses</option>
                <option value="PENDING">Pending Outreach</option>
                <option value="CONTACTED">Contacted / Interested</option>
                <option value="BOOKED">Meeting Booked</option>
              </select>

              {/* Channel Status Filter */}
              <select
                id="sheet-channel-filter"
                value={filterChannel}
                onChange={(e) => setFilterChannel(e.target.value)}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-xs text-ink"
              >
                <option value="ALL">All Delivery Statuses</option>
                <option value="WA_SENT">WhatsApp Delivered</option>
                <option value="EMAIL_SENT">Email Sent</option>
                <option value="REPLIED">Client Replied</option>
              </select>
            </div>
          </AdvancedSection>
        </div>

        {/* Batch Selected Actions Bar */}
        {selectedIds.length > 0 && (
          <div className="mt-3 p-2.5 bg-[#128C7E]/10 border border-[#128C7E]/30 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-[#128C7E]">
              {selectedIds.length} leads selected
            </span>
            <div className="flex items-center gap-2">
              {onStartCampaignWithSelected && (
                <button
                  onClick={() => onStartCampaignWithSelected(selectedIds)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#25D366] text-white font-semibold text-xs shadow-xs hover:bg-[#25D366]"
                >
                  <Send className="w-3 h-3" />
                  <span>Launch Sequence for Selected</span>
                </button>
              )}
              <button
                onClick={() => setSelectedIds([])}
                className="px-2.5 py-1.5 rounded-lg bg-surface text-ink-secondary font-medium text-xs hover:bg-surface-hover border border-[#128C7E]/30"
              >
                Clear Selection
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Inline Add Lead Form */}
      {isAddingLead && (
        <form
          onSubmit={handleAddSubmit}
          className="bg-surface/70 backdrop-blur-2xl rounded-2xl border border-[#25D366]/40 p-5 shadow-card space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-ink">Add New Client Contact</h3>
            <button
              type="button"
              onClick={() => setIsAddingLead(false)}
              className="text-xs text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Full Name *
              </label>
              <input
                required
                type="text"
                placeholder="e.g. John Doe"
                value={newLead.name}
                onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Company Name
              </label>
              <input
                type="text"
                placeholder="e.g. Acme Corp"
                value={newLead.company}
                onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                WhatsApp Phone (E.164) *
              </label>
              <input
                required
                type="text"
                placeholder="e.g. +919876543210"
                value={newLead.phone}
                onChange={(e) => setNewLead({ ...newLead, phone: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Email Address
              </label>
              <input
                type="email"
                placeholder="e.g. john@acme.com"
                value={newLead.email}
                onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                Country
              </label>
              <input
                type="text"
                placeholder="e.g. United Arab Emirates"
                value={newLead.country}
                onChange={(e) => setNewLead({ ...newLead, country: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsAddingLead(false)}
              className="px-3 py-1.5 text-xs text-ink-muted hover:bg-canvas rounded-lg border border-border-strong"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-semibold text-white bg-[#25D366] hover:bg-[#25D366] rounded-lg shadow-xs"
            >
              Save Contact
            </button>
          </div>
        </form>
      )}

      {/* Edit Lead Modal / Form */}
      {editingLead && (
        <form
          onSubmit={handleEditSubmit}
          className="bg-surface/70 backdrop-blur-2xl rounded-2xl border border-[#4285F4]/40 p-5 shadow-card space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-ink">Edit Lead: {editingLead.name}</h3>
            <button
              type="button"
              onClick={() => setEditingLead(null)}
              className="text-xs text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Name</label>
              <input
                type="text"
                value={editingLead.name}
                onChange={(e) => setEditingLead({ ...editingLead, name: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Company</label>
              <input
                type="text"
                value={editingLead.company}
                onChange={(e) => setEditingLead({ ...editingLead, company: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Phone</label>
              <input
                type="text"
                value={editingLead.phone}
                onChange={(e) => setEditingLead({ ...editingLead, phone: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Email</label>
              <input
                type="email"
                value={editingLead.email}
                onChange={(e) => setEditingLead({ ...editingLead, email: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Country</label>
              <input
                type="text"
                value={editingLead.country || ''}
                onChange={(e) => setEditingLead({ ...editingLead, country: e.target.value })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink-muted mb-1">Notes / Remarks</label>
            <input
              type="text"
              value={editingLead.notes || ''}
              onChange={(e) => setEditingLead({ ...editingLead, notes: e.target.value })}
              className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Tags (comma-separated)</label>
              <input
                type="text"
                value={(editingLead.tags || []).join(', ')}
                onChange={(e) =>
                  setEditingLead({
                    ...editingLead,
                    tags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="hot lead, enterprise"
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-muted mb-1">Follow-up Date</label>
              <input
                type="date"
                value={editingLead.followUpDate || ''}
                onChange={(e) => setEditingLead({ ...editingLead, followUpDate: e.target.value || undefined })}
                className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingLead(null)}
              className="px-3 py-1.5 text-xs text-ink-muted hover:bg-canvas rounded-lg border border-border-strong"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-semibold text-white bg-brand-strong hover:bg-[#0d6e62] rounded-lg shadow-xs"
            >
              Update Lead
            </button>
          </div>
        </form>
      )}

      {/* Main Leads Table */}
      <div className="bg-surface/70 backdrop-blur-2xl rounded-2xl border border-border shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-canvas border-b border-border text-ink-muted font-semibold">
                <th className="py-3 px-3.5 w-10 text-center">
                  <button
                    onClick={toggleSelectAll}
                    className="text-ink-muted hover:text-ink"
                    title="Select All"
                  >
                    {filteredLeads.length > 0 && filteredLeads.every((l) => selectedIds.includes(l.id)) ? (
                      <CheckSquare className="w-4 h-4 text-[#25D366]" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="py-3 px-3">Contact & Company</th>
                <th className="py-3 px-3">WhatsApp Number</th>
                <th className="py-3 px-3">Email Address</th>
                <th className="py-3 px-3">WhatsApp Status</th>
                <th className="py-3 px-3">Email Status</th>
                <th className="py-3 px-3">Lead Status</th>
                <th className="py-3 px-3">Last Contacted</th>
                <th className="py-3 px-3 text-right">Quick Dispatch & Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-hover">
              {filteredLeads.length > 0 ? (
                filteredLeads.map((lead) => {
                  const isSelected = selectedIds.includes(lead.id);

                  return (
                    <motion.tr
                      key={lead.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2 }}
                      className={`hover:bg-canvas transition-colors ${
                        isSelected ? 'bg-[#25D366]/5' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-3.5 text-center">
                        <button
                          onClick={() => toggleSelectLead(lead.id)}
                          className="text-ink-muted hover:text-ink"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-[#25D366]" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>

                      {/* Name & Company */}
                      <td className="py-3 px-3">
                        <div className="font-semibold text-ink">{lead.name}</div>
                        <div className="text-[11px] text-ink-muted">
                          {lead.company}
                          {lead.country && <span className="text-ink-muted"> · {lead.country}</span>}
                        </div>
                        {(lead.tags?.length || lead.followUpDate) && (
                          <div className="flex flex-wrap items-center gap-1 mt-1">
                            {lead.tags?.map((tag) => (
                              <span
                                key={tag}
                                className="px-1.5 py-0.5 rounded-full bg-[#4285F4]/10 text-[#1967D2] text-[10px] font-medium"
                              >
                                {tag}
                              </span>
                            ))}
                            {lead.followUpDate && (
                              <span
                                className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                                  new Date(lead.followUpDate) <= new Date()
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : 'bg-surface-hover text-ink-muted'
                                }`}
                              >
                                Follow up {lead.followUpDate}
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Phone */}
                      <td className="py-3 px-3">
                        <div className="font-mono text-ink flex items-center gap-1">
                          <span>{lead.phone}</span>
                          {lead.isValidPhone ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-[#25D366]" title="Valid E.164"></span>
                          ) : (
                            <span className="text-[10px] text-red-400">Invalid</span>
                          )}
                        </div>
                      </td>

                      {/* Email */}
                      <td className="py-3 px-3">
                        <div className="text-ink-secondary truncate max-w-[180px]">{lead.email}</div>
                      </td>

                      {/* WhatsApp Status */}
                      <td className="py-3 px-3">
                        {lead.whatsAppStatus === 'Pending' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-hover text-ink-muted border border-border-strong">
                            <Clock className="w-2.5 h-2.5" /> Pending
                          </span>
                        )}
                        {lead.whatsAppStatus === 'Queued' && (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20"
                            title={lead.scheduledFor ? `Scheduled for ${new Date(lead.scheduledFor).toLocaleString()}` : undefined}
                          >
                            <Clock className="w-2.5 h-2.5" /> Scheduled
                          </span>
                        )}
                        {lead.whatsAppStatus === 'Sending' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            <Send className="w-2.5 h-2.5" /> Sending
                          </span>
                        )}
                        {lead.whatsAppStatus === 'Sent' && (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20"
                            title="Accepted by WhatsApp — will flip to Delivered once confirmed"
                          >
                            <Send className="w-2.5 h-2.5" /> Sent
                          </span>
                        )}
                        {(lead.whatsAppStatus === 'Delivered' || lead.whatsAppStatus === 'Read') && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#128C7E]/10 text-[#128C7E] border border-[#128C7E]/30">
                            <CheckCircle2 className="w-2.5 h-2.5 text-[#25D366]" /> {lead.whatsAppStatus === 'Read' ? 'Read' : 'Delivered'}
                          </span>
                        )}
                        {lead.whatsAppStatus === 'Replied' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                            <MessageSquare className="w-2.5 h-2.5" /> Replied
                          </span>
                        )}
                        {lead.whatsAppStatus === 'Failed' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                            <AlertTriangle className="w-2.5 h-2.5" /> Failed
                          </span>
                        )}
                      </td>

                      {/* Email Status */}
                      <td className="py-3 px-3">
                        {lead.emailStatus === 'Pending' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-hover text-ink-muted border border-border-strong">
                            <Clock className="w-2.5 h-2.5" /> Pending
                          </span>
                        )}
                        {lead.emailStatus === 'Queued' && (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20"
                            title={lead.scheduledFor ? `Scheduled for ${new Date(lead.scheduledFor).toLocaleString()}` : undefined}
                          >
                            <Clock className="w-2.5 h-2.5" /> Scheduled
                          </span>
                        )}
                        {(lead.emailStatus === 'Sent' || lead.emailStatus === 'Delivered') && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#4285F4]/10 text-[#1967D2] border border-[#4285F4]/10">
                            <Mail className="w-2.5 h-2.5 text-[#4285F4]" /> Sent
                          </span>
                        )}
                        {(lead.emailStatus === 'Opened' || lead.emailStatus === 'Clicked') && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <Sparkles className="w-2.5 h-2.5" /> {lead.emailStatus}
                          </span>
                        )}
                        {lead.emailStatus === 'Failed' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                            <AlertTriangle className="w-2.5 h-2.5" /> Failed
                          </span>
                        )}
                      </td>

                      {/* Lead Status */}
                      <td className="py-3 px-3">
                        {lead.status === 'Meeting Scheduled' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <Calendar className="w-2.5 h-2.5" /> {lead.meetingTime || 'Booked'}
                          </span>
                        ) : lead.status === 'Contacted' ? (
                          <span className="text-[11px] font-medium text-[#128C7E]">Contacted</span>
                        ) : (
                          <span className="text-[11px] text-ink-muted">{lead.status}</span>
                        )}
                      </td>

                      {/* Last Contacted */}
                      <td className="py-3 px-3 text-ink-muted text-[11px]">
                        {lead.lastContacted || '—'}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          {/* Send — routes through the real AI-personalized, tracked dispatch path */}
                          <button
                            id={`sim-${lead.id}`}
                            onClick={() => onSelectLeadForSimulator(lead.id)}
                            className="p-1.5 text-[#128C7E] hover:bg-[#128C7E]/10 rounded-md transition-colors"
                            title="Send Message"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>

                          {/* Edit */}
                          <button
                            onClick={() => setEditingLead(lead)}
                            className="p-1.5 text-ink-muted hover:text-ink hover:bg-canvas rounded-md transition-colors"
                            title="Edit Contact"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>

                          {/* Delete */}
                          <button
                            onClick={() => onDeleteLead(lead.id)}
                            className="p-1.5 text-ink-muted hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                            title="Delete Contact"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-xs text-ink-muted">
                    No contacts found matching the search filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
