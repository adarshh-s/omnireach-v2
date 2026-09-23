import { useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

/**
 * Persists a settings object either to Supabase (scoped to the signed-in org, via RLS)
 * when authenticated, or to localStorage otherwise — same shape either way, so callers
 * (App.tsx) don't need to know which backend is active. This is what lets the Settings
 * dashboard be per-organization once multi-tenant auth is configured, while still working
 * standalone (single workspace, browser-only) when it isn't.
 */
export function useCloudSettings<T>(
  table: 'org_profile' | 'org_channel_settings',
  localStorageKey: string,
  defaultValue: T,
  userId: string | null | undefined
): [T, (value: T) => void, { loading: boolean; saveError: string | null }] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(localStorageKey);
      if (saved) {
        try {
          return { ...defaultValue, ...JSON.parse(saved) };
        } catch {}
      }
    }
    return defaultValue;
  });
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loadedForUser = useRef<string | null>(null);

  // Load from Supabase whenever a signed-in org becomes available.
  useEffect(() => {
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return;
    if (loadedForUser.current === userId) return;
    loadedForUser.current = userId;

    setLoading(true);
    supabase
      .from(table)
      .select('settings')
      .eq('org_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.settings) {
          setValue({ ...defaultValue, ...data.settings });
        }
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, table]);

  // Mirror to localStorage always (instant reload / offline fallback / pre-auth cache).
  useEffect(() => {
    try {
      localStorage.setItem(localStorageKey, JSON.stringify(value));
    } catch {}
  }, [value, localStorageKey]);

  // Persist to Supabase (debounced) whenever signed in.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // supabase-js's query builder rejects (rather than resolving with `{error}`) on
      // network-level failures — an expired/unrefreshed session, offline, CORS — so this
      // is wrapped in a real try/catch rather than just `.then()`, which would silently
      // swallow that case as an unhandled rejection and leave the UI showing "Saved" with
      // no indication the write never happened.
      (async () => {
        try {
          const { error } = await supabase!
            .from(table)
            .upsert({ org_id: userId, settings: value, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
          if (error) {
            console.error(`[useCloudSettings] Failed to save ${table}:`, error);
            setSaveError(error.message || 'Failed to save settings to the cloud.');
          } else {
            setSaveError(null);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to save settings to the cloud.';
          console.error(`[useCloudSettings] Failed to save ${table} (network/auth error):`, err);
          setSaveError(message);
        }
      })();
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, userId, table]);

  return [value, setValue, { loading, saveError }];
}
