/**
 * Languages the AI Voice Agent can hold a call in. Picking one changes three things together
 * on every call (lib/voiceCalls.ts) and in the browser demo (VoiceDemoWidget): how the caller
 * is heard (transcriber), the voice it speaks with, and an instruction to reply in that
 * language. Each org picks its own in Channel Setup → Voice.
 *
 * Transcribers: Deepgram (Vapi's default, lowest latency) where it supports the language,
 * Azure Speech for the rest — mostly Indian regional languages. Voices: Azure neural voices,
 * which exist natively for every language here. Shared by the server and the dashboard.
 */

export type VoiceGender = 'female' | 'male';

export interface VoiceLanguage {
  /** BCP-47 locale, also the stored setting (ChannelApiSettings.vapiLanguage). */
  code: string;
  label: string;
  region: 'Auto' | 'Americas' | 'Europe' | 'India' | 'Middle East & Asia';
  /** Deepgram language code when Deepgram supports it, else Azure Speech is used. */
  deepgram?: string;
  /** Azure neural voices: [female, male]. */
  voices: [string, string];
  /** The language's own name, for the "always speak X" instruction. */
  promptName: string;
}

/** Hears and speaks many languages, switching to whatever the caller speaks. */
export const AUTO_LANGUAGE = 'auto';

export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { code: AUTO_LANGUAGE, label: 'Auto-detect (replies in the caller’s language)', region: 'Auto', deepgram: 'multi', voices: ['en-US-AvaMultilingualNeural', 'en-US-AndrewMultilingualNeural'], promptName: '' },

  { code: 'en-US', label: 'English (US)', region: 'Americas', deepgram: 'en-US', voices: ['en-US-JennyNeural', 'en-US-GuyNeural'], promptName: 'English' },
  { code: 'es-MX', label: 'Spanish (Latin America / US)', region: 'Americas', deepgram: 'es-419', voices: ['es-MX-DaliaNeural', 'es-MX-JorgeNeural'], promptName: 'Spanish' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', region: 'Americas', deepgram: 'pt-BR', voices: ['pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural'], promptName: 'Brazilian Portuguese' },
  { code: 'fr-CA', label: 'French (Canada)', region: 'Americas', deepgram: 'fr-CA', voices: ['fr-CA-SylvieNeural', 'fr-CA-JeanNeural'], promptName: 'Canadian French' },

  { code: 'en-GB', label: 'English (UK)', region: 'Europe', deepgram: 'en-GB', voices: ['en-GB-SoniaNeural', 'en-GB-RyanNeural'], promptName: 'British English' },
  { code: 'en-IE', label: 'English (Ireland)', region: 'Europe', deepgram: 'en', voices: ['en-IE-EmilyNeural', 'en-IE-ConnorNeural'], promptName: 'English' },
  { code: 'de-DE', label: 'German', region: 'Europe', deepgram: 'de', voices: ['de-DE-KatjaNeural', 'de-DE-ConradNeural'], promptName: 'German' },
  { code: 'de-CH', label: 'German (Switzerland)', region: 'Europe', deepgram: 'de-CH', voices: ['de-CH-LeniNeural', 'de-CH-JanNeural'], promptName: 'Swiss German (written as standard German)' },
  { code: 'fr-FR', label: 'French', region: 'Europe', deepgram: 'fr', voices: ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural'], promptName: 'French' },
  { code: 'es-ES', label: 'Spanish (Spain)', region: 'Europe', deepgram: 'es', voices: ['es-ES-ElviraNeural', 'es-ES-AlvaroNeural'], promptName: 'Spanish' },
  { code: 'it-IT', label: 'Italian', region: 'Europe', deepgram: 'it', voices: ['it-IT-ElsaNeural', 'it-IT-DiegoNeural'], promptName: 'Italian' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', region: 'Europe', deepgram: 'pt', voices: ['pt-PT-RaquelNeural', 'pt-PT-DuarteNeural'], promptName: 'European Portuguese' },
  { code: 'nl-NL', label: 'Dutch', region: 'Europe', deepgram: 'nl', voices: ['nl-NL-ColetteNeural', 'nl-NL-MaartenNeural'], promptName: 'Dutch' },
  { code: 'nl-BE', label: 'Dutch (Belgium / Flemish)', region: 'Europe', deepgram: 'nl-BE', voices: ['nl-BE-DenaNeural', 'nl-BE-ArnaudNeural'], promptName: 'Flemish Dutch' },
  { code: 'sv-SE', label: 'Swedish', region: 'Europe', deepgram: 'sv', voices: ['sv-SE-SofieNeural', 'sv-SE-MattiasNeural'], promptName: 'Swedish' },
  { code: 'da-DK', label: 'Danish', region: 'Europe', deepgram: 'da', voices: ['da-DK-ChristelNeural', 'da-DK-JeppeNeural'], promptName: 'Danish' },
  { code: 'nb-NO', label: 'Norwegian', region: 'Europe', deepgram: 'no', voices: ['nb-NO-PernilleNeural', 'nb-NO-FinnNeural'], promptName: 'Norwegian (Bokmål)' },
  { code: 'fi-FI', label: 'Finnish', region: 'Europe', deepgram: 'fi', voices: ['fi-FI-NooraNeural', 'fi-FI-HarriNeural'], promptName: 'Finnish' },
  { code: 'pl-PL', label: 'Polish', region: 'Europe', deepgram: 'pl', voices: ['pl-PL-AgnieszkaNeural', 'pl-PL-MarekNeural'], promptName: 'Polish' },
  { code: 'cs-CZ', label: 'Czech', region: 'Europe', deepgram: 'cs', voices: ['cs-CZ-VlastaNeural', 'cs-CZ-AntoninNeural'], promptName: 'Czech' },
  { code: 'sk-SK', label: 'Slovak', region: 'Europe', deepgram: 'sk', voices: ['sk-SK-ViktoriaNeural', 'sk-SK-LukasNeural'], promptName: 'Slovak' },
  { code: 'hu-HU', label: 'Hungarian', region: 'Europe', deepgram: 'hu', voices: ['hu-HU-NoemiNeural', 'hu-HU-TamasNeural'], promptName: 'Hungarian' },
  { code: 'ro-RO', label: 'Romanian', region: 'Europe', deepgram: 'ro', voices: ['ro-RO-AlinaNeural', 'ro-RO-EmilNeural'], promptName: 'Romanian' },
  { code: 'bg-BG', label: 'Bulgarian', region: 'Europe', deepgram: 'bg', voices: ['bg-BG-KalinaNeural', 'bg-BG-BorislavNeural'], promptName: 'Bulgarian' },
  { code: 'el-GR', label: 'Greek', region: 'Europe', deepgram: 'el', voices: ['el-GR-AthinaNeural', 'el-GR-NestorasNeural'], promptName: 'Greek' },
  { code: 'hr-HR', label: 'Croatian', region: 'Europe', voices: ['hr-HR-GabrijelaNeural', 'hr-HR-SreckoNeural'], promptName: 'Croatian' },
  { code: 'sr-RS', label: 'Serbian', region: 'Europe', voices: ['sr-RS-SophieNeural', 'sr-RS-NicholasNeural'], promptName: 'Serbian' },
  { code: 'sl-SI', label: 'Slovenian', region: 'Europe', voices: ['sl-SI-PetraNeural', 'sl-SI-RokNeural'], promptName: 'Slovenian' },
  { code: 'et-EE', label: 'Estonian', region: 'Europe', deepgram: 'et', voices: ['et-EE-AnuNeural', 'et-EE-KertNeural'], promptName: 'Estonian' },
  { code: 'lv-LV', label: 'Latvian', region: 'Europe', deepgram: 'lv', voices: ['lv-LV-EveritaNeural', 'lv-LV-NilsNeural'], promptName: 'Latvian' },
  { code: 'lt-LT', label: 'Lithuanian', region: 'Europe', deepgram: 'lt', voices: ['lt-LT-OnaNeural', 'lt-LT-LeonasNeural'], promptName: 'Lithuanian' },
  { code: 'uk-UA', label: 'Ukrainian', region: 'Europe', deepgram: 'uk', voices: ['uk-UA-PolinaNeural', 'uk-UA-OstapNeural'], promptName: 'Ukrainian' },
  { code: 'ru-RU', label: 'Russian', region: 'Europe', deepgram: 'ru', voices: ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'], promptName: 'Russian' },
  { code: 'tr-TR', label: 'Turkish', region: 'Europe', deepgram: 'tr', voices: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'], promptName: 'Turkish' },
  { code: 'ca-ES', label: 'Catalan', region: 'Europe', deepgram: 'ca', voices: ['ca-ES-JoanaNeural', 'ca-ES-EnricNeural'], promptName: 'Catalan' },
  { code: 'ga-IE', label: 'Irish', region: 'Europe', voices: ['ga-IE-OrlaNeural', 'ga-IE-ColmNeural'], promptName: 'Irish (Gaeilge)' },

  { code: 'en-IN', label: 'English (India)', region: 'India', deepgram: 'en-IN', voices: ['en-IN-NeerjaNeural', 'en-IN-PrabhatNeural'], promptName: 'Indian English' },
  { code: 'hi-IN', label: 'Hindi', region: 'India', deepgram: 'hi', voices: ['hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'], promptName: 'Hindi' },
  { code: 'bn-IN', label: 'Bengali', region: 'India', voices: ['bn-IN-TanishaaNeural', 'bn-IN-BashkarNeural'], promptName: 'Bengali' },
  { code: 'ta-IN', label: 'Tamil', region: 'India', voices: ['ta-IN-PallaviNeural', 'ta-IN-ValluvarNeural'], promptName: 'Tamil' },
  { code: 'te-IN', label: 'Telugu', region: 'India', voices: ['te-IN-ShrutiNeural', 'te-IN-MohanNeural'], promptName: 'Telugu' },
  { code: 'mr-IN', label: 'Marathi', region: 'India', voices: ['mr-IN-AarohiNeural', 'mr-IN-ManoharNeural'], promptName: 'Marathi' },
  { code: 'gu-IN', label: 'Gujarati', region: 'India', voices: ['gu-IN-DhwaniNeural', 'gu-IN-NiranjanNeural'], promptName: 'Gujarati' },
  { code: 'kn-IN', label: 'Kannada', region: 'India', voices: ['kn-IN-SapnaNeural', 'kn-IN-GaganNeural'], promptName: 'Kannada' },
  { code: 'ml-IN', label: 'Malayalam', region: 'India', voices: ['ml-IN-SobhanaNeural', 'ml-IN-MidhunNeural'], promptName: 'Malayalam' },
  { code: 'pa-IN', label: 'Punjabi', region: 'India', voices: ['pa-IN-VaaniNeural', 'pa-IN-OjasNeural'], promptName: 'Punjabi' },
  { code: 'ur-IN', label: 'Urdu', region: 'India', voices: ['ur-IN-GulNeural', 'ur-IN-SalmanNeural'], promptName: 'Urdu' },
  { code: 'or-IN', label: 'Odia', region: 'India', voices: ['or-IN-SubhasiniNeural', 'or-IN-SukantNeural'], promptName: 'Odia' },

  { code: 'ar-AE', label: 'Arabic (Gulf)', region: 'Middle East & Asia', voices: ['ar-AE-FatimaNeural', 'ar-AE-HamdanNeural'], promptName: 'Arabic' },
  { code: 'zh-CN', label: 'Chinese (Mandarin)', region: 'Middle East & Asia', deepgram: 'zh-CN', voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'], promptName: 'Mandarin Chinese' },
  { code: 'ja-JP', label: 'Japanese', region: 'Middle East & Asia', deepgram: 'ja', voices: ['ja-JP-NanamiNeural', 'ja-JP-KeitaNeural'], promptName: 'Japanese' },
  { code: 'ko-KR', label: 'Korean', region: 'Middle East & Asia', deepgram: 'ko', voices: ['ko-KR-SunHiNeural', 'ko-KR-InJoonNeural'], promptName: 'Korean' },
  { code: 'vi-VN', label: 'Vietnamese', region: 'Middle East & Asia', deepgram: 'vi', voices: ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'], promptName: 'Vietnamese' },
  { code: 'fil-PH', label: 'Filipino (Tagalog)', region: 'Middle East & Asia', voices: ['fil-PH-BlessicaNeural', 'fil-PH-AngeloNeural'], promptName: 'Filipino' },
];

export function findVoiceLanguage(code: string | undefined | null): VoiceLanguage | null {
  if (!code) return null;
  return VOICE_LANGUAGES.find((l) => l.code === code) || null;
}

export interface VoiceLanguageOverrides {
  transcriber: Record<string, unknown>;
  voice: Record<string, unknown>;
  /** One system-prompt line telling the model which language to speak. */
  instruction: string;
  language: VoiceLanguage;
}

/** The Vapi assistantOverrides for a language, or null to keep the assistant's own (the
 * default — whatever voice/transcriber it was created with). */
export function voiceLanguageOverrides(code: string | undefined | null, gender: VoiceGender = 'female'): VoiceLanguageOverrides | null {
  const language = findVoiceLanguage(code);
  if (!language) return null;

  const transcriber = language.deepgram
    ? { provider: 'deepgram', model: language.deepgram === 'multi' ? 'nova-3' : 'nova-2', language: language.deepgram }
    : { provider: 'azure', language: language.code };
  const voice = { provider: 'azure', voiceId: language.voices[gender === 'male' ? 1 : 0] };
  const instruction =
    language.code === AUTO_LANGUAGE
      ? "- LANGUAGE: reply in whatever language the caller speaks, and switch if they switch. Open in the language of your first message."
      : `- LANGUAGE: speak only ${language.promptName} on this call — every reply, including dates, times and the booking confirmation — even though these instructions are in English. Only switch if the caller clearly can't understand and asks for another language.`;

  return { transcriber, voice, instruction, language };
}

const LANGUAGE_BLOCK_START = '### CALL LANGUAGE (set by OmniReach from Channel Setup → Voice; edits inside this block are overwritten)';
const LANGUAGE_BLOCK_END = '### END CALL LANGUAGE';

/** Puts the language instruction into the assistant's saved prompt (replacing any earlier
 * one), so it applies wherever the assistant runs — including the browser demo, which starts
 * the assistant as saved rather than with per-call overrides. null removes the block. */
export function applyLanguageBlock(prompt: string, instruction: string | null): string {
  let base = prompt;
  const start = base.indexOf(LANGUAGE_BLOCK_START);
  if (start !== -1) {
    const end = base.indexOf(LANGUAGE_BLOCK_END, start);
    const after = end === -1 ? '' : base.slice(end + LANGUAGE_BLOCK_END.length);
    base = `${base.slice(0, start).trimEnd()}${after.trim() ? `\n\n${after.trim()}` : ''}`;
  }
  return instruction ? `${base.trimEnd()}\n\n${LANGUAGE_BLOCK_START}\n${instruction}\n${LANGUAGE_BLOCK_END}` : base;
}
