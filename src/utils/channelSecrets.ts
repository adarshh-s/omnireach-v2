import type { ChannelApiSettings, ChannelSecretKey } from '../types';

/** True if the secret was typed in this session or is already saved server-side — saved
 * secrets never come back to the browser, only the fact that they exist (savedSecrets). */
export function hasChannelSecret(settings: ChannelApiSettings, key: ChannelSecretKey): boolean {
  const typed = settings[key];
  return (typeof typed === 'string' && typed.trim() !== '') || !!settings.savedSecrets?.[key];
}
