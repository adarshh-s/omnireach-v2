import React, { useState } from 'react';
import { Zap, Mail, Lock, LogOut, Loader2 } from 'lucide-react';
import { useAuth, AuthState } from '../hooks/useAuth';

interface AuthGateProps {
  children: (auth: AuthState) => React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const auth = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Not configured: run as a single, standalone workspace (unchanged behavior).
  if (!auth.configured) {
    return <>{children(auth)}</>;
  }

  if (auth.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFAFA]">
        <Loader2 className="w-6 h-6 text-[#128C7E] animate-spin" />
      </div>
    );
  }

  if (!auth.user) {
    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setInfo(null);
      setSubmitting(true);
      const result = mode === 'signup' ? await auth.signUp(email, password) : await auth.signIn(email, password);
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
      } else if (mode === 'signup') {
        setInfo('Account created! Check your email to confirm, then sign in.');
      }
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFAFA] px-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center gap-2 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#25D366] via-[#128C7E] to-[#4285F4] flex items-center justify-center text-white shadow-sm">
              <Zap className="w-5 h-5 fill-white" />
            </div>
            <span className="font-semibold text-lg text-[#18181B] tracking-tight">OmniReach AI</span>
          </div>

          <div className="bg-white border border-[#E4E4E7] rounded-2xl p-7 shadow-card">
            <h2 className="text-lg font-bold text-[#18181B] mb-1">
              {mode === 'signin' ? 'Sign in to your workspace' : 'Create your workspace'}
            </h2>
            <p className="text-xs text-[#71717A] mb-5">
              {mode === 'signin' ? 'Each organization has its own isolated workspace.' : 'One account per organization — you can configure your own WhatsApp, Email, and Calendar afterward.'}
            </p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#3F3F46] mb-1">Work Email</label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full pl-9 pr-3 py-2.5 bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl text-sm text-[#18181B] placeholder-[#71717A] focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#3F3F46] mb-1">Password</label>
                <div className="relative">
                  <Lock className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2.5 bg-[#FAFAFA] border border-[#E4E4E7] rounded-xl text-sm text-[#18181B] placeholder-[#71717A] focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30"
                  />
                </div>
              </div>

              {error && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</p>}
              {info && <p className="text-xs text-[#128C7E] bg-[#128C7E]/10 border border-[#128C7E]/30 rounded-lg px-3 py-2">{info}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-xl bg-[#18181B] hover:bg-[#09090B] text-white text-sm font-medium shadow-sm transition-all disabled:opacity-60"
              >
                {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Workspace'}
              </button>
            </form>

            <button
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
                setInfo(null);
              }}
              className="w-full text-center text-xs text-[#71717A] hover:text-[#3F3F46] mt-4"
            >
              {mode === 'signin' ? "Don't have a workspace? Create one" : 'Already have a workspace? Sign in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-[#18181B] text-white text-xs px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between">
        <span className="text-[#A1A1AA]">Signed in as {auth.user.email}</span>
        <button onClick={() => auth.signOut()} className="flex items-center gap-1 text-[#A1A1AA] hover:text-white transition-colors">
          <LogOut className="w-3 h-3" />
          Sign out
        </button>
      </div>
      {children(auth)}
    </>
  );
};
