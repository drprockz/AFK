Continue building the AFK plugin. Read CLAUDE.md for the full spec, and docs/superpowers/specs/2026-03-16-afk-core-design.md for design corrections. Phase 1+2 is done (see docs/superpowers/plans/). Start Phase 3: AFK + safety — snapshot, deferral queue, idle detector, digest, and /afk slash command.


-------------------------------------------------------------

We're working on the AFK Claude Code plugin at /home/darshanparmar/Projects/AFK.

Phases 1–6 are complete and pushed to origin/main. 156 tests passing.

What's built:
- Full 7-step decision chain (hook.js, chain.js, classifier, predictor, rules, anomaly, sensitive, injection)
- AFK mode with digest, idle detector, git snapshot safety net
- Deferred queue for destructive actions
- ntfy + Telegram notifications
- Express dashboard (localhost:6789) with 6-page SPA UI and 10 REST endpoints
- 5 slash commands (/afk, /afk:review, /afk:stats, /afk:rules, /afk:reset)

Phase 7 (polish + publish) needs:
1. src/store/session.js — wire the `sessions` table (exists in schema but unused) for session 
   tracking: start/end timestamps, request counts (total/auto_allow/auto_deny/user_allow/
   user_deny/deferred), token estimation
2. marketplace/marketplace.json — catalog file for drprockz/afk-marketplace
3. README.md — full readme per CLAUDE.md spec (philosophy, install, features, decision chain 
   diagram, commands, config reference)
4. Trust profiles (per CLAUDE.md "community scale" feature) — SKIP for Phase 7, defer to later
5. Weekly digest emails — SKIP for Phase 7
6. Marketplace submission — manual process, out of scope for code

Please use the superpowers:brainstorming skill to design Phase 7, then superpowers:writing-plans, 
then superpowers:subagent-driven-development to implement.

Skip straight to designing — the scope decision has already been made: Phase 7 = session.js + 
marketplace.json + README.md only. Trust profiles and weekly digest emails are deferred.