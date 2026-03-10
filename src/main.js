import { createClient } from '@supabase/supabase-js';

// ──── CONFIG ─────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: true,
    flowType:           'pkce',
  },
});

// ──── CHART INITIALIZATION ───────────────────────────────────────
export function initChart() {
  const ctx = document.getElementById('chart');
  if (!ctx) return null;

  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: [],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: 'rgba(12, 17, 32, 0.95)',
          titleColor: '#e8edf8',
          bodyColor: '#e8edf8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: function(context) {
              const value = context.raw;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((value / total) * 100).toFixed(1);
              return `${formatCurrency(value)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ──── AUTH GUARD ─────────────────────────────────────────────────
export async function checkAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();

    if (!session) {
      // No session → redirect to auth page
      window.location.href = '/auth.html';
      return false;
    }

    return true;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/auth.html';
    return false;
  }
}

// ──── SIGN OUT ───────────────────────────────────────────────────
export async function signOut() {
  try {
    await sb.auth.signOut();
    window.location.href = '/auth.html';
  } catch (error) {
    console.error('Sign out failed:', error);
    // Even if error, try to redirect anyway
    window.location.href = '/auth.html';
  }
}

// ──── FORMATTERS ─────────────────────────────────────────────────
function formatCurrency(val) {
  return '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ──── SIGN OUT HANDLER (for auth page) ───────────────────────────
export function setupSignOutHandler() {
  document.addEventListener('DOMContentLoaded', () => {
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
        await signOut();
      });
    }
  });
}


