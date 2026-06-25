import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../services/api.js';
import useFlyxaStore, { getInitialState } from '../store/flyxaStore.js';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isPasswordRecovery: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, name: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  resetPassword: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Translate raw Supabase error strings to user-friendly messages. */
function friendlyAuthError(message: string | undefined): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid credentials'))
    return 'Incorrect email or password. Please try again.';
  if (m.includes('email not confirmed'))
    return 'Please verify your email address before signing in. Check your inbox for a confirmation link.';
  if (m.includes('user already registered') || m.includes('already registered'))
    return 'An account with this email already exists. Try signing in instead.';
  if (m.includes('password should be at least') || m.includes('password is too short'))
    return 'Password must be at least 6 characters.';
  if (m.includes('unable to validate email') || m.includes('invalid email format'))
    return 'Please enter a valid email address.';
  if (m.includes('email rate limit') || (m.includes('rate limit') && m.includes('email')))
    return 'Too many attempts. Please wait a moment before trying again.';
  if (m.includes('for security purposes, you can only request this'))
    return 'Please wait before requesting another password reset email.';
  if (m.includes('popup closed') || m.includes('user cancelled') || m.includes('access_denied'))
    return 'Sign-in was cancelled. Please try again.';
  if (m.includes('network') || m.includes('fetch'))
    return 'Network error. Please check your connection and try again.';
  return message;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const wasLoggedInRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      wasLoggedInRef.current = !!session;

      // Zustand's async Supabase storage can run before Supabase auth has
      // restored the browser session. In that case the first hydration sees
      // "no user" and returns the empty initial store. Always rehydrate once
      // the actual session is known so hard refreshes reload the user's cloud
      // journal instead of staying on defaults.
      if (session) {
        void useFlyxaStore.persist.rehydrate();
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const wasLoggedIn = wasLoggedInRef.current;
      const isLoggedIn = !!session;
      wasLoggedInRef.current = isLoggedIn;

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true);
      }

      // Rehydrate on actual sign-in, or on initial session restore if not yet hydrated
      if ((event === 'SIGNED_IN' && !wasLoggedIn) || (event === 'INITIAL_SESSION' && isLoggedIn && !wasLoggedIn)) {
        setIsPasswordRecovery(false);
        void useFlyxaStore.persist.rehydrate();
      }
      if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false);
        // Reset in-memory state first so a subsequent sign-in by a different user
        // doesn't inherit the previous user's entries via the merge safety guard.
        useFlyxaStore.setState(getInitialState());
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: friendlyAuthError(error?.message) };
  };

  const signUp = async (email: string, password: string, name: string): Promise<{ error: string | null }> => {
    const trimmedName = name.trim();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: {
          name: trimmedName,
          full_name: trimmedName,
        },
      },
    });
    return { error: friendlyAuthError(error?.message) };
  };

  const signInWithGoogle = async (): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    return { error: friendlyAuthError(error?.message) };
  };

  const resetPassword = async (email: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    return { error: friendlyAuthError(error?.message) };
  };

  const updatePassword = async (password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.updateUser({ password });
    if (!error) setIsPasswordRecovery(false);
    return { error: friendlyAuthError(error?.message) };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{
      user, session, loading, isPasswordRecovery,
      signIn, signUp, signInWithGoogle, resetPassword, updatePassword, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
