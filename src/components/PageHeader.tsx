import React from 'react';

interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

/** The one header every page uses: title, a single line of what the page is for, and the
 * page's main actions on the right — so each page starts the same way. */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 pb-1">
    <div className="min-w-0">
      <h1 className="text-xl font-bold text-ink tracking-tight">{title}</h1>
      {description && <p className="text-xs sm:text-sm text-ink-muted mt-1 max-w-2xl">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
  </div>
);

export const headerPrimaryButton =
  'inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand-strong hover:bg-[#0d6e62] text-white text-xs font-semibold shadow-sm transition-all disabled:opacity-50';
export const headerSecondaryButton =
  'inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-surface-hover hover:bg-border-strong border border-border-strong text-ink text-xs font-semibold transition-all disabled:opacity-50';
