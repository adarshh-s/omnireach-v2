import React from 'react';
import { CheckCircle2 } from 'lucide-react';

interface SecretInputProps {
  value: string | null | undefined;
  /** Saved server-side already (the value itself is never sent back to the browser). */
  saved: boolean;
  /** null means "remove the saved secret". */
  onChange: (value: string | null) => void;
  placeholder?: string;
  className?: string;
}

/** A password field for a channel secret. Once saved, the field stays empty with a "Saved"
 * note — typing replaces the secret, Remove deletes it. */
export const SecretInput: React.FC<SecretInputProps> = ({ value, saved, onChange, placeholder, className }) => {
  const showSaved = saved && !value;
  return (
    <>
      <input
        type="password"
        autoComplete="off"
        placeholder={showSaved ? 'Saved — type to replace' : placeholder}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      />
      {showSaved && (
        <p className="text-[10px] text-emerald-300 mt-1 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          <span>Saved securely — hidden from the browser.</span>
          <button type="button" onClick={() => onChange(null)} className="ml-1 text-ink-muted hover:text-rose-400 underline">
            Remove
          </button>
        </p>
      )}
    </>
  );
};
