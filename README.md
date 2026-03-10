# FOLIO — Multi-Portfolio Stock Tracker

Free, open-source portfolio tracking tool with real-time quotes, beautiful charts, and dividend tracking.

## Features

- **Multi-Portfolio Management** — Track multiple portfolios (RRSP, TFSA, trading accounts)
- **Real-Time Quotes** — Live market data from Alpha Vantage
- **Portfolio Charts** — Visualize value over time with interactive charts
- **Allocation Breakdown** — See how your portfolio is distributed
- **Dividend Tracking** — Monitor dividend yield for each position
- **Private by Design** — Row-level security at the database level
- **Free Forever** — No subscription, no credit card

## Tech Stack

- **Framework:** Vite 7 (fast builds, modern DX)
- **Language:** Vanilla JavaScript (no build step overhead)
- **Database:** Supabase (PostgreSQL + auth + RLS)
- **Charting:** Chart.js 4
- **Data Source:** Alpha Vantage (real-time quotes)
- **Deployment:** Vercel (global edge network)

## Prerequisites

- Node.js 18+ installed
- Supabase account (free tier)
- Alpha Vantage API key (free tier: 25 req/min)

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/EarthDeparture/folio.git
cd folio
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
VITE_AV_KEY=your_alpha_vantage_key_here
```

**How to get your Supabase Anon Key:**
1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project (earthdeparture-hub)
3. Navigate to Settings → API
4. Copy the "anon public" key

**How to get your Alpha Vantage Key:**
1. Sign up at [alphavantage.co](https://www.alphavantage.co/support/#api-key)
2. Generate a free API key
3. Use it in your `.env` file

### 4. Set Up Supabase Database

Run the following SQL in your Supabase project's SQL Editor:

**Project:** `earthdeparture-hub` (https://supabase.com/dashboard/project/qpkvbgeqmrnvhpgqqbmg)

1. Navigate to **SQL Editor**
2. Create a new query
3. Run the entire `setup.sql` file (included in this repo)
4. After running, go to **Settings → API → Extra search path** and add: `folio`

### 5. Run Locally

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

### 6. Build for Production

```bash
npm run build
```

Build output will be in the `dist/` directory.

### 7. Deploy to Vercel

**Option A: Vercel CLI**
```bash
npm install -g vercel
vercel
```

**Option B: Deploy via GitHub**
1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com/new)
3. Import your repository
4. Set environment variables (same as step 3 above)
5. Deploy!

**Important:** Make sure your Vercel environment variables match your `.env` file:
- `VITE_SUPABASE_ANON_KEY`
- `VITE_AV_KEY`

## Project Structure

```
folio/
├── src/
│   ├── index.html       # Landing page (sales funnel)
│   ├── auth.html        # Sign in / Sign up page
│   ├── dashboard.html   # Portfolio dashboard
│   ├── main.js          # Dashboard entry point + auth guard
│   └── auth.js          # Auth utilities
├── dist/                # Build output (generated)
├── .env                 # Local environment variables (gitignored)
├── .env.example         # Template for .env
├── package.json         # Dependencies & scripts
├── vite.config.js       # Vite configuration
└── setup.sql            # Supabase schema
```

## Database Schema

### Tables

- **folios** — User portfolios (name, owner, timestamps)
- **positions** — Holdings within each portfolio (symbol, shares, avg_cost)
- **quotes** — Stock quote cache (symbol, price, change, etc.)

### Row-Level Security

All tables use RLS policies:
- **folios**: Authenticated users can only access their own portfolios
- **positions**: Only positions belonging to user's portfolios are visible
- **quotes**: Public read access (updated by server-side job)

### Helper Functions

- `public.current_user_id()` — Returns the authenticated user's UUID
- `folio.is_portfolio_owned_by_current_user(p_folio_id)` — Portfolio ownership check

## Authentication

- Email/password only (MVP)
- No email verification required (disabled for convenience)
- PKCE flow for secure auth
- Session persisted in localStorage
- Sign-out button in dashboard header

## Feature Roadmap

- [ ] Price alerts & notifications
- [ ] Custom watchlists
- [ ] Tax lot tracking
- [ ] Performance benchmarking
- [ ] API access for third-party apps
- [ ] Custom domain support
- [ ] Import/Export Excel files
- [ ] Mobile app (React Native)

## Support

- **GitHub:** https://github.com/EarthDeparture/folio/issues
- **Email:** support@earthdeparture.com (coming soon)
- **Documentation:** See this README + project wiki

## License

ISC

## Credits

Built with ❤️ by EarthDeparture.

Data powered by Alpha Vantage.
Database managed by Supabase.
Hosted on Vercel.
