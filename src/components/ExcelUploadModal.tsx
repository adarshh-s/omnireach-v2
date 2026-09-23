import React, { useState, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  X,
  Sparkles,
  Download,
  Globe,
  HelpCircle,
} from 'lucide-react';
import {
  parseSpreadsheetFile,
  convertRowsToLeads,
  sanitizePhoneNumber,
} from '../utils/excelParser';
import { Lead, ColumnMapping } from '../types';

interface ExcelUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportLeads: (leads: Lead[], appendMode: boolean) => void;
  defaultCountryCode: string;
}

const COMMON_COUNTRY_CODES = [
  { code: '+91', name: 'India (+91)' },
  { code: '+1', name: 'United States / Canada (+1)' },
  { code: '+44', name: 'United Kingdom (+44)' },
  { code: '+971', name: 'United Arab Emirates (+971)' },
  { code: '+61', name: 'Australia (+61)' },
  { code: '+65', name: 'Singapore (+65)' },
  { code: '+49', name: 'Germany (+49)' },
  { code: '+33', name: 'France (+33)' },
  { code: '+966', name: 'Saudi Arabia (+966)' },
];

export const ExcelUploadModal: React.FC<ExcelUploadModalProps> = ({
  isOpen,
  onClose,
  onImportLeads,
  defaultCountryCode,
}) => {
  const [step, setStep] = useState<'upload' | 'mapping' | 'preview'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, any>[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    name: '',
    phone: '',
    company: '',
    email: '',
    notes: '',
    country: '',
  });
  const [selectedCountryCode, setSelectedCountryCode] = useState(defaultCountryCode || '+91');
  const [appendMode, setAppendMode] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (selectedFile: File) => {
    setErrorMsg('');
    setIsProcessing(true);
    try {
      const parsed = await parseSpreadsheetFile(selectedFile);
      setFile(selectedFile);
      setFileName(parsed.fileName);
      setHeaders(parsed.headers);
      setRawRows(parsed.rows);
      setMapping(parsed.detectedMapping);
      setStep('mapping');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to read file. Please ensure it is a valid .xlsx, .xls, or .csv');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleConfirmImport = () => {
    if (!mapping.phone) {
      setErrorMsg('Please map the Phone Number column before importing.');
      return;
    }

    const { leads } = convertRowsToLeads(rawRows, mapping, selectedCountryCode);
    onImportLeads(leads, appendMode);
    onClose();
    resetState();
  };

  const resetState = () => {
    setStep('upload');
    setFile(null);
    setFileName('');
    setHeaders([]);
    setRawRows([]);
    setErrorMsg('');
  };

  // Preview generated leads from current mapping
  const previewLeads = rawRows.slice(0, 5).map((row, idx) => {
    const rawPhone = row[mapping.phone];
    const { formatted, isValid } = sanitizePhoneNumber(rawPhone, selectedCountryCode);
    return {
      name: row[mapping.name] || `Row #${idx + 1}`,
      rawPhone: String(rawPhone || ''),
      formattedPhone: formatted,
      isValid,
      company: row[mapping.company] || '—',
      email: row[mapping.email] || '—',
    };
  });

  const downloadSampleExcel = () => {
    const csvContent =
      'Name,Company,Phone,Email,Country,Notes\n' +
      'Alex Morgan,Acme AI Solutions,9876543211,alex.morgan@acmesolutions.example,United Arab Emirates,Interested in automated WhatsApp & Email outreach\n' +
      'John Doe,Global Logistics,+15551234567,john@globallogistics.com,United States,Follow-up demo for Q3 calendar invite\n' +
      'Sarah Connor,Cyberdyne Systems,+447911123456,sarah@cyberdyne.org,United Kingdom,Requested pricing overview\n' +
      'Rajesh Kumar,TechCorp India,9876543210,rajesh@techcorp.in,India,Wants WhatsApp demo link\n';

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'sample_leads_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

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
            className="bg-white/90 backdrop-blur-2xl border border-white/60 ring-1 ring-black/5 rounded-3xl max-w-2xl w-full shadow-[0_20px_25px_-5px_rgb(0_0_0/0.1),0_8px_10px_-6px_rgb(0_0_0/0.1),inset_0_1px_0_0_rgba(255,255,255,0.8)] overflow-hidden flex flex-col max-h-[90vh]"
          >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#E4E4E7] flex items-center justify-between bg-[#FAFAFA]">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-[#25D366]/15 border border-[#25D366]/30 flex items-center justify-center text-[#128C7E]">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-[#18181B] text-base">
                Import Client Spreadsheet (Excel / CSV)
              </h3>
              <p className="text-xs text-[#71717A]">
                Auto-sanitize phone numbers for WhatsApp, validate emails, and prepare automated outreach
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              onClose();
              resetState();
            }}
            className="p-2 rounded-full text-[#71717A] hover:text-[#18181B] hover:bg-[#E4E4E7]/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {errorMsg && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-800">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* STEP 1: UPLOAD */}
          {step === 'upload' && (
            <div className="space-y-4">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-[#128C7E]/40 hover:border-[#128C7E] bg-[#FAFAFA] hover:bg-[#F4F4F5] rounded-3xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center space-y-3"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])}
                  accept=".xlsx, .xls, .csv"
                  className="hidden"
                />
                <div className="w-14 h-14 rounded-full bg-white shadow-sm border border-[#E4E4E7] flex items-center justify-center text-[#128C7E]">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#18181B]">
                    Click to upload or drag & drop your spreadsheet
                  </p>
                  <p className="text-xs text-[#71717A] mt-1">
                    Supports Microsoft Excel (<strong className="text-[#3F3F46]">.xlsx, .xls</strong>) and CSV (<strong className="text-[#3F3F46]">.csv</strong>)
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-[#E4E4E7] text-[11px] text-[#3F3F46] font-medium">
                  <Sparkles className="w-3.5 h-3.5 text-[#128C7E]" />
                  Auto-detects Name, Phone & Company columns
                </div>
              </div>

              {/* Sample Template & Help */}
              <div className="flex items-center justify-between pt-2 text-xs text-[#71717A]">
                <button
                  type="button"
                  onClick={downloadSampleExcel}
                  className="flex items-center gap-1.5 text-[#128C7E] hover:text-[#128C7E] font-medium transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Sample Template (.csv)</span>
                </button>
                <span className="flex items-center gap-1 text-[#71717A]">
                  <Globe className="w-3.5 h-3.5" />
                  Auto-formats Indian (+91) & Global numbers
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: COLUMN MAPPING & COUNTRY CODE */}
          {step === 'mapping' && (
            <div className="space-y-5">
              <div className="p-4 rounded-2xl bg-[#FAFAFA] border border-[#E4E4E7] flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <FileSpreadsheet className="w-5 h-5 text-[#128C7E]" />
                  <div>
                    <p className="text-xs font-bold text-[#18181B]">{fileName}</p>
                    <p className="text-[11px] text-[#71717A]">
                      {rawRows.length} rows found • {headers.length} columns detected
                    </p>
                  </div>
                </div>
                <button
                  onClick={resetState}
                  className="text-xs text-[#71717A] hover:text-[#18181B] underline"
                >
                  Change File
                </button>
              </div>

              {/* Default Country Selector */}
              <div>
                <label className="block text-xs font-bold text-[#18181B] mb-1.5 flex items-center gap-1.5">
                  <Globe className="w-4 h-4 text-[#128C7E]" />
                  Default Country Code (for 10-digit numbers without prefix)
                </label>
                <select
                  value={selectedCountryCode}
                  onChange={(e) => setSelectedCountryCode(e.target.value)}
                  className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-2xl px-4 py-2.5 text-xs text-[#18181B] font-medium focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30"
                >
                  {COMMON_COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-[#71717A] mt-1">
                  Example: If phone in Excel is <code className="text-[#128C7E] font-mono">9061584951</code>, it will automatically become <code className="text-[#128C7E] font-mono">+919061584951</code> in E.164.
                </p>
              </div>

              {/* Column Mapping Selectors */}
              <div className="space-y-3 pt-2 border-t border-[#E4E4E7]">
                <h4 className="text-xs font-bold text-[#18181B] uppercase tracking-wider">
                  Map Spreadsheet Columns
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {/* Phone (Required) */}
                  <div className="p-3 rounded-2xl bg-white border-2 border-[#128C7E]/50 shadow-card">
                    <label className="block text-xs font-bold text-[#18181B] mb-1 flex items-center justify-between">
                      <span>Phone Number *</span>
                      <span className="text-[10px] text-[#128C7E] bg-[#128C7E]/15 px-2 py-0.5 rounded-full font-bold">REQUIRED</span>
                    </label>
                    <select
                      value={mapping.phone}
                      onChange={(e) => setMapping({ ...mapping, phone: e.target.value })}
                      className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl px-3 py-2 text-xs font-semibold text-[#18181B] focus:outline-none"
                    >
                      <option value="">-- Select Phone Column --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Name */}
                  <div className="p-3 rounded-2xl bg-white border border-[#E4E4E7]">
                    <label className="block text-xs font-semibold text-[#18181B] mb-1">
                      Full Name
                    </label>
                    <select
                      value={mapping.name}
                      onChange={(e) => setMapping({ ...mapping, name: e.target.value })}
                      className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl px-3 py-2 text-xs text-[#18181B] focus:outline-none"
                    >
                      <option value="">-- Select Name Column --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Company */}
                  <div className="p-3 rounded-2xl bg-white border border-[#E4E4E7]">
                    <label className="block text-xs font-semibold text-[#18181B] mb-1">
                      Company / Organization
                    </label>
                    <select
                      value={mapping.company}
                      onChange={(e) => setMapping({ ...mapping, company: e.target.value })}
                      className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl px-3 py-2 text-xs text-[#18181B] focus:outline-none"
                    >
                      <option value="">-- Optional: Select Company --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Email */}
                  <div className="p-3 rounded-2xl bg-white border border-[#E4E4E7]">
                    <label className="block text-xs font-semibold text-[#18181B] mb-1">
                      Email Address
                    </label>
                    <select
                      value={mapping.email}
                      onChange={(e) => setMapping({ ...mapping, email: e.target.value })}
                      className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl px-3 py-2 text-xs text-[#18181B] focus:outline-none"
                    >
                      <option value="">-- Optional: Select Email --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Country */}
                  <div className="p-3 rounded-2xl bg-white border border-[#E4E4E7]">
                    <label className="block text-xs font-semibold text-[#18181B] mb-1">
                      Country
                    </label>
                    <select
                      value={mapping.country}
                      onChange={(e) => setMapping({ ...mapping, country: e.target.value })}
                      className="w-full bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl px-3 py-2 text-xs text-[#18181B] focus:outline-none"
                    >
                      <option value="">-- Optional: Select Country --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-[#71717A] mt-1">Used for peak-local-time campaign scheduling</p>
                  </div>
                </div>
              </div>

              {/* Live Data Preview Table */}
              <div className="pt-2 border-t border-[#E4E4E7]">
                <h4 className="text-xs font-bold text-[#18181B] mb-2 flex items-center justify-between">
                  <span>Sanitization & E.164 Preview (First 5 Rows)</span>
                  <span className="text-[11px] text-[#128C7E] font-medium">
                    {previewLeads.filter((p) => p.isValid).length} of {previewLeads.length} valid
                  </span>
                </h4>

                <div className="bg-[#FAFAFA] border border-[#E4E4E7] rounded-2xl overflow-hidden">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-[#F4F4F5] border-b border-[#E4E4E7] text-[#71717A] font-semibold">
                      <tr>
                        <th className="p-2.5">Name</th>
                        <th className="p-2.5">Raw Excel Phone</th>
                        <th className="p-2.5">Sanitized E.164</th>
                        <th className="p-2.5">Company</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E4E4E7]">
                      {previewLeads.map((item, idx) => (
                        <tr key={idx}>
                          <td className="p-2.5 font-medium text-[#18181B]">{item.name}</td>
                          <td className="p-2.5 font-mono text-[#71717A]">{item.rawPhone || '—'}</td>
                          <td className="p-2.5 font-mono">
                            {item.isValid ? (
                              <span className="inline-flex items-center gap-1 text-[#128C7E] font-bold">
                                <CheckCircle2 className="w-3 h-3 text-[#128C7E]" />
                                {item.formattedPhone}
                              </span>
                            ) : (
                              <span className="text-rose-600 font-bold">Invalid Format</span>
                            )}
                          </td>
                          <td className="p-2.5 text-[#3F3F46]">{item.company}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Import Options (Replace vs Append) */}
              <div className="p-3.5 rounded-2xl bg-[#F4F4F5] border border-[#E4E4E7] flex items-center justify-between">
                <div className="text-xs">
                  <p className="font-bold text-[#18181B]">Import Mode</p>
                  <p className="text-[11px] text-[#71717A]">
                    {appendMode ? 'Add new leads to existing sheet rows' : 'Replace all current sheet rows with this file'}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={appendMode}
                    onChange={(e) => setAppendMode(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-[#E4E4E7] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-[#E4E4E7] after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#128C7E]"></div>
                  <span className="ml-2 text-xs font-semibold text-[#18181B]">
                    {appendMode ? 'Append' : 'Replace'}
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-[#E4E4E7] bg-[#FAFAFA] flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              onClose();
              resetState();
            }}
            className="px-4 py-2 rounded-full border border-[#E4E4E7] bg-white text-xs font-semibold text-[#3F3F46] hover:bg-[#F4F4F5] transition-all"
          >
            Cancel
          </button>

          {step === 'mapping' && (
            <button
              type="button"
              id="btn-confirm-import-excel"
              onClick={handleConfirmImport}
              disabled={!mapping.phone}
              className="flex items-center space-x-2 px-6 py-2.5 rounded-full bg-[#128C7E] hover:bg-[#128C7E] text-white text-xs font-bold shadow-sm transition-all disabled:opacity-50"
            >
              <span>Load {rawRows.length} Leads into Campaign</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
