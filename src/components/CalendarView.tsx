import React, { useState } from 'react';
import {
  Calendar as CalendarIcon,
  Clock,
  Video,
  User,
  Mail,
  CheckCircle2,
  Plus,
  RefreshCw,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import { CalendarSlot } from '../types';

interface CalendarViewProps {
  slots: CalendarSlot[];
  onAddSlot: (date: string, time: string) => void;
  onCancelSlot: (id: string) => void;
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  slots,
  onAddSlot,
  onCancelSlot,
}) => {
  const [newDate, setNewDate] = useState('2026-09-08');
  const [newTime, setNewTime] = useState('11:00 AM');
  const [isAdding, setIsAdding] = useState(false);

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDate || !newTime) return;
    onAddSlot(newDate, newTime);
    setIsAdding(false);
  };

  const bookedSlots = slots.filter((s) => !s.available);
  const openSlots = slots.filter((s) => s.available);

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-1">
            <CalendarIcon className="w-3.5 h-3.5 text-[#128C7E]" />
            <span>Google Calendar Booking Engine</span>
          </div>
          <h2 className="text-xl font-bold text-ink">Meeting Slots & Scheduled Events</h2>
          <p className="text-xs sm:text-sm text-ink-secondary mt-0.5">
            The AI queries open slots in real time, offers 2–3 options, and automatically generates Google Meet appointments.
          </p>
        </div>

        <button
          id="btn-add-calendar-slot"
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-full bg-[#128C7E] hover:bg-[#128C7E] text-white font-medium text-xs shadow-sm transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Open Slot</span>
        </button>
      </div>

      {/* Add Slot Form */}
      {isAdding && (
        <form
          onSubmit={handleAddSubmit}
          className="bg-surface/50 backdrop-blur-3xl border border-[#128C7E]/40 rounded-2xl p-6 shadow-card flex flex-wrap items-end gap-4 animate-in fade-in"
        >
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1">Date</label>
            <input
              type="date"
              required
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="bg-canvas border border-border rounded-xl px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1">Time</label>
            <input
              type="text"
              required
              placeholder="e.g. 2:30 PM"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className="bg-canvas border border-border rounded-xl px-3 py-2 text-xs text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-4 py-2 rounded-full bg-canvas border border-border text-ink-secondary text-xs font-medium hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-full bg-[#128C7E] text-white text-xs font-semibold hover:bg-[#128C7E] shadow-sm"
            >
              Add Slot
            </button>
          </div>
        </form>
      )}

      {/* Grid: Open Slots vs Booked Events */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Booked Meetings (Left) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card">
            <div className="flex items-center justify-between pb-3 border-b border-border mb-4">
              <h3 className="font-semibold text-sm text-ink flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#128C7E]" />
                Booked Meetings ({bookedSlots.length})
              </h3>
              <span className="text-xs text-ink-muted">Google Meet Invites Dispatched</span>
            </div>

            {bookedSlots.length === 0 ? (
              <div className="text-center py-8 text-ink-muted text-xs bg-canvas rounded-2xl p-6">
                No meetings scheduled yet — meetings booked by the AI bot on WhatsApp or Email will appear here.
              </div>
            ) : (
              <div className="space-y-3">
                {bookedSlots.map((slot) => (
                  <div
                    key={slot.id}
                    className="p-4 rounded-2xl bg-canvas border border-border hover:border-[#128C7E]/40 transition-all space-y-2.5"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-semibold text-sm text-ink">{slot.title || 'Discovery Call'}</h4>
                        <div className="flex items-center space-x-3 text-xs text-ink-muted mt-1">
                          <span className="flex items-center gap-1 font-mono text-[#128C7E] font-medium">
                            <Clock className="w-3.5 h-3.5 text-[#128C7E]" />
                            {slot.date} • {slot.time}
                          </span>
                        </div>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#128C7E]/15 text-[#128C7E] border border-[#128C7E]/30">
                        Confirmed
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border text-xs">
                      <div className="flex items-center space-x-3 text-ink-secondary">
                        <span className="flex items-center gap-1">
                          <User className="w-3.5 h-3.5 text-ink-muted" />
                          {slot.bookedBy}
                        </span>
                        {slot.leadEmail && (
                          <span className="flex items-center gap-1 text-ink-muted">
                            <Mail className="w-3.5 h-3.5" />
                            {slot.leadEmail}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <a
                          href={slot.meetLink || '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-surface-hover hover:bg-surface-hover text-ink-secondary border border-border text-[11px] font-medium transition-all"
                        >
                          <Video className="w-3 h-3 text-[#128C7E]" />
                          <span>Google Meet Link</span>
                        </a>

                        <button
                          onClick={() => onCancelSlot(slot.id)}
                          className="px-2.5 py-1 rounded-full text-rose-400 hover:bg-rose-500/10 text-[11px] transition-all font-medium"
                          title="Release slot back to available"
                        >
                          Release
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Available Calendar Slots (Right) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card">
            <div className="flex items-center justify-between pb-3 border-b border-border mb-4">
              <h3 className="font-semibold text-sm text-ink flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#128C7E]" />
                Available Slots Pool ({openSlots.length})
              </h3>
              <span className="text-xs text-ink-muted">Offered by AI Booking Bot</span>
            </div>

            <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
              {openSlots.map((slot) => (
                <div
                  key={slot.id}
                  className="p-3.5 rounded-2xl bg-canvas border border-border flex items-center justify-between hover:bg-surface-hover transition-all text-xs"
                >
                  <div className="flex items-center space-x-2.5">
                    <span className="w-2 h-2 rounded-full bg-[#128C7E] animate-pulse"></span>
                    <span className="font-semibold text-ink">{slot.date}</span>
                    <span className="text-[#128C7E] font-mono">{slot.time}</span>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-[#128C7E] bg-[#128C7E]/15 border border-[#128C7E]/30 px-2.5 py-0.5 rounded-full">
                    Open
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
