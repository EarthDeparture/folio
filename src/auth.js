import { createClient } from '@supabase/supabase-js';

// ── CONFIG ─────────────────────────────────────────────────────
const SUPABASE_URL = 'https://qpkvbgeqmrnvhpgqqbmg.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: true,
    flowType:           'pkce',
  },
});

// ──── AUTH STATE OBSERVER ───────────────────────────────────────
export function setupAuthObserver() {
  sb.auth.onAuthStateChange((event, session) => {
    const signOutBtn = document.getElementById('sign-out-btn');

    // Show sign-out button if user is logged in
    if (session && signOutBtn) {
      signOutBtn.style.display = 'inline-block';
    } else {
      signOutBtn.style.display = 'none';
    }
  });
}

// ── DOM REFS ───────────────────────────────────────────────────
const titleEl         = () => document.getElementById('auth-title');
const subtitleEl      = () => document.getElementById('auth-subtitle');
const errorEl         = () => document.getElementById('auth-error');
const errorTitleEl    = () => document.getElementById('error-title');
const errorMessageEl  = () => document.getElementById('error-message');
const loadingEl       = () => document.getElementById('auth-loading');
const loadingTextEl   = () => document.getElementById('loading-text');
const formEl          = () => document.getElementById('auth-form');
const submitBtn       = () => document.getElementById('auth-submit');
const emailInput      = () => document.getElementById('email');
const passwordInput   = () => document.getElementById('password');

// ── HELPERS ────────────────────────────────────────────────────
export function showError(title, message) {
  errorTitleEl().textContent   = title;
  errorMessageEl().textContent = message;
  errorEl().classList.add('show');
}

export function hideError() {
  errorEl().classList.remove('show');
}

export function showLoading(text = 'Loading...') {
  loadingTextEl().textContent = text;
  loadingEl().classList.add('show');
  formEl().style.display = 'none';
  hideError();
}

export function hideLoading() {
  loadingEl().classList.remove('show');
  formEl().style.display = 'block';
}

export function resetForm() {
  emailInput()?.classList.remove('error');
  passwordInput()?.classList.remove('error');
  hideError();
}

// ── AUTH ACTIONS ───────────────────────────────────────────────
export async function signIn(email, password) {
  showLoading('Signing in...');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    window.location.href = '/dashboard.html';
  } catch(err) {
    hideLoading();
    showError('Sign In Failed', err.message || 'Invalid email or password.');
  }
}

export async function signUp(email, password) {
  showLoading('Creating your account...');
  try {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;

    if (data.session) {
      // Auto-confirmed — go straight to dashboard
      window.location.href = '/dashboard.html';
    } else {
      hideLoading();
      titleEl().textContent    = 'Account Created!';
      subtitleEl().textContent = 'You can now sign in with your credentials.';
      submitBtn().textContent  = 'Sign In';
      // Switch to sign-in mode
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-tab="signin"]')?.classList.add('active');
    }
  } catch(err) {
    hideLoading();
    showError('Sign Up Failed', err.message || 'Could not create account.');
  }
}
