# Mazevo
Trading journal + AI agent platform. Migrating from FlowJournal (single-file HTML). Data stays in Supabase, untouched.

## Stack
Vanilla JS + Vite. Supabase (auth, Postgres, Edge Functions). Deployed to GitHub Pages via Actions.

## Structure
- src/journal/ — trade logging, stats, screenshots
- src/agents/<name>/ — one folder per agent, each exports the agent contract from index.js
- src/domain/ — trading logic (SPM, regime router, vol), agent-agnostic, no UI
- src/lib/ — supabase client, auth
- supabase/functions/ — Edge Functions

## Agents
- DOM — post-trade analyst, two-layer deterministic + LLM
- Gnosis — RAG over CLAUDDY Obsidian vault, Supabase full-text search
- Finski — pre-market brief, model-risk rules, economic calendar

## Rules
- Never modify the Supabase schema without asking. Existing trade data is production.
- Verify each migration step in the browser before moving on.
- Domain logic lives in src/domain/, not inside agent prompt strings.
