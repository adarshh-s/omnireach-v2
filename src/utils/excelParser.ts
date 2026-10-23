import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { Lead, ColumnMapping } from '../types';

/**
 * Normalizes and sanitizes any raw phone string into a standard E.164 format.
 * Fixes Excel formula errors (e.g. `='+91...`), removes quotes, dashes, spaces, and
 * prepends default country code (e.g., +91 for India or +1 for US) if missing.
 */
export function sanitizePhoneNumber(
  raw: string | number | undefined | null,
  defaultCountryCode: string = '+91'
): { formatted: string; isValid: boolean } {
  if (raw === undefined || raw === null) {
    return { formatted: '', isValid: false };
  }

  let str = String(raw).trim();

  // Strip formula artifacts or quotes: e.g., `='9061584951`, `='+9190...`, `"9061..."`
  str = str.replace(/^['"=]+/, '').replace(/['"]+$/, '').trim();

  // Keep only digits and the plus sign
  let cleaned = str.replace(/[^\d+]/g, '');

  // Strip any accidental multiple leading pluses
  cleaned = cleaned.replace(/^\++/, '+');

  const normalizedCode = defaultCountryCode.startsWith('+')
    ? defaultCountryCode
    : `+${defaultCountryCode}`;

  const cleanCountryDigits = normalizedCode.replace(/\D/g, '');

  if (cleaned.startsWith('+')) {
    const digitsOnly = cleaned.replace(/\D/g, '');
    const isValid = digitsOnly.length >= 10 && digitsOnly.length <= 15;
    return { formatted: cleaned, isValid };
  }

  // Pure digits without leading plus
  if (/^\d+$/.test(cleaned)) {
    // If it starts with the country digits (e.g., 919061584951 where country code is 91)
    if (cleaned.startsWith(cleanCountryDigits) && cleaned.length >= 11) {
      return { formatted: `+${cleaned}`, isValid: true };
    }

    // 10 digits (Standard Indian or US mobile number without country prefix)
    if (cleaned.length === 10) {
      return { formatted: `${normalizedCode}${cleaned}`, isValid: true };
    }

    // 11-15 digits -> treat as international without plus
    if (cleaned.length > 10 && cleaned.length <= 15) {
      return { formatted: `+${cleaned}`, isValid: true };
    }
  }

  return { formatted: cleaned ? `+${cleaned.replace(/\D/g, '')}` : '', isValid: false };
}

/**
 * Auto-detects column names from header row
 */
export function autoDetectColumns(headers: string[]): ColumnMapping {
  const normalized = headers.map((h) => ({
    original: h,
    lower: h.toLowerCase().trim().replace(/[_\-\s]+/g, ''),
  }));

  const findMatch = (candidates: string[]): string => {
    for (const cand of candidates) {
      const match = normalized.find((h) => h.lower.includes(cand));
      if (match) return match.original;
    }
    return '';
  };

  const nameCol =
    findMatch(['fullname', 'clientname', 'contactname', 'leadname', 'customername', 'name', 'person']) ||
    headers[0] ||
    '';

  const phoneCol =
    findMatch(['phone', 'mobile', 'cell', 'tel', 'contactno', 'phonenumber', 'mobilenumber', 'telephone']) ||
    headers.find((h) => h.toLowerCase().includes('phone') || h.toLowerCase().includes('mobile')) ||
    headers[1] ||
    '';

  const companyCol =
    findMatch(['company', 'organization', 'org', 'business', 'client', 'firm', 'agency']) ||
    headers[2] ||
    '';

  const emailCol =
    findMatch(['email', 'mail', 'emailaddress', 'contactemail']) ||
    headers[3] ||
    '';

  const notesCol =
    findMatch(['notes', 'note', 'message', 'comment', 'description', 'context', 'remarks']) ||
    '';

  const countryCol = findMatch(['country', 'nation', 'countryname']) || '';
  const consentCol = findMatch(['consent', 'callconsent', 'optin', 'optedin', 'permission', 'tcpaconsent']) || '';

  return {
    name: nameCol,
    phone: phoneCol,
    company: companyCol,
    email: emailCol,
    notes: notesCol,
    country: countryCol,
    consent: consentCol,
  };
}

/**
 * Parses an uploaded Excel (.xlsx, .xls) or CSV file into raw rows and column list.
 */
export async function parseSpreadsheetFile(file: File): Promise<{
  headers: string[];
  rows: Record<string, any>[];
  detectedMapping: ColumnMapping;
  fileName: string;
}> {
  const isCSV = file.name.endsWith('.csv');

  if (isCSV) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const headers = results.meta.fields || [];
          const rows = results.data as Record<string, any>[];
          const detectedMapping = autoDetectColumns(headers);
          resolve({ headers, rows, detectedMapping, fileName: file.name });
        },
        error: (err) => reject(err),
      });
    });
  }

  // Handle .xlsx / .xls using XLSX library
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

  if (jsonData.length === 0) {
    throw new Error('Spreadsheet appears to be empty.');
  }

  const rawHeaders = (jsonData[0] || []).map((h) => String(h || '').trim()).filter(Boolean);
  const rows: Record<string, any>[] = [];

  for (let i = 1; i < jsonData.length; i++) {
    const rowArray = jsonData[i];
    if (!rowArray || rowArray.length === 0) continue;
    const rowObj: Record<string, any> = {};
    let hasData = false;

    rawHeaders.forEach((header, idx) => {
      const val = rowArray[idx];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        rowObj[header] = val;
        hasData = true;
      }
    });

    if (hasData) {
      rows.push(rowObj);
    }
  }

  const detectedMapping = autoDetectColumns(rawHeaders);
  return { headers: rawHeaders, rows, detectedMapping, fileName: file.name };
}

/**
 * Converts parsed spreadsheet rows to sanitized Leads array using column mapping.
 */
export function convertRowsToLeads(
  rows: Record<string, any>[],
  mapping: ColumnMapping,
  defaultCountryCode: string = '+91'
): { leads: Lead[]; validCount: number; invalidCount: number } {
  const leads: Lead[] = [];
  let validCount = 0;
  let invalidCount = 0;

  rows.forEach((row, idx) => {
    const rawName = String(row[mapping.name] || `Contact #${idx + 1}`).trim();
    const rawPhone = row[mapping.phone];
    const rawCompany = String(row[mapping.company] || '').trim();
    const rawEmail = String(row[mapping.email] || '').trim();
    const rawNotes = String(row[mapping.notes] || '').trim();
    const rawCountry = String(row[mapping.country] || '').trim();
    // Anything that reads as "yes" counts as recorded consent to calls (needed for US numbers).
    const hasConsent = mapping.consent ? /^(y|yes|true|1|written|express|opted ?in|agreed)\b/i.test(String(row[mapping.consent] || '').trim()) : false;

    const { formatted, isValid: isPhoneValid } = sanitizePhoneNumber(rawPhone, defaultCountryCode);
    const isEmailValid = Boolean(rawEmail && rawEmail.includes('@') && rawEmail.includes('.'));

    if (isPhoneValid || isEmailValid) {
      validCount++;
    } else {
      invalidCount++;
    }

    leads.push({
      id: `lead-feed-${Date.now()}-${idx}`,
      name: rawName,
      company: rawCompany || 'Prospective Client',
      phone: formatted || String(rawPhone || ''),
      rawPhone: String(rawPhone || ''),
      email: rawEmail,
      country: rawCountry,
      status: 'Pending',
      whatsAppStatus: 'Pending',
      emailStatus: 'Pending',
      meetingDate: '',
      meetingTime: '',
      notes: rawNotes,
      lastContacted: '',
      isValidPhone: isPhoneValid,
      isValidEmail: isEmailValid,
      ...(hasConsent ? { callConsent: true } : {}),
    });
  });

  return { leads, validCount, invalidCount };
}

/**
 * Exports leads list to an Excel (.xlsx) file.
 */
export function exportLeadsToExcel(leads: Lead[], filename: string = 'OmniReach_WhatsApp_Email_Results.xlsx') {
  const exportData = leads.map((l) => ({
    'Contact Name': l.name,
    'Company': l.company,
    'WhatsApp Phone (E.164)': l.phone,
    'Email Address': l.email,
    'Lead Status': l.status,
    'WhatsApp Status': l.whatsAppStatus,
    'Email Status': l.emailStatus,
    'Channel Used': l.channelUsed || 'None',
    'Meeting Date': l.meetingDate || 'N/A',
    'Meeting Time': l.meetingTime || 'N/A',
    'Notes / Remarks': l.notes || '',
    'Consent to calls': l.callConsent ? 'Yes' : '',
    'Last Contacted At': l.lastContacted || 'Not yet contacted',
    'Original Phone': l.rawPhone || l.phone,
  }));

  const worksheet = XLSX.utils.json_to_sheet(exportData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Outreach Results');

  // Auto-size columns
  const colWidths = Object.keys(exportData[0] || {}).map((key) => ({
    wch: Math.max(key.length, 18),
  }));
  worksheet['!cols'] = colWidths;

  XLSX.writeFile(workbook, filename);
}
