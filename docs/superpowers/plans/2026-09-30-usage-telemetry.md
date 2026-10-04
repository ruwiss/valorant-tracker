# Usage Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record overlay installs and Riot PUUIDs in Supabase, show a private admin page, and mark lobby players who use the overlay.

**Architecture:** The desktop app sends fire-and-forget HTTP upserts. It never opens a websocket and never blocks the game loop. The admin page is the only Realtime subscriber. Lobby matching is one compact POST of hyphenless PUUIDs; the server returns only the intersection.

**Tech Stack:** Tauri 2 / Rust reqwest, existing `install.json` UUID, Supabase PostgREST + RLS, one static admin HTML page, React roster badges.

**Spec:** Approved in chat on 2026-09-30. No separate spec file. This plan is the binding spec.

## Global Constraints

- No client websocket. HTTP only.
- Missing Supabase config disables telemetry. The overlay must boot and play exactly as before.
- Network failure, timeout, or non-2xx never surfaces in the UI, never toasts, never panics, never delays the supervisor.
- HTTP timeout is 4 seconds. One in-flight request. If one is running, skip. Do not queue.
- Heartbeat every 300 seconds, plus once at launch, plus when phase, map, or mode changes. Do not send because score or agent lock changed.
- Lobby lookup only when the set of roster PUUIDs changes and is non-empty. Cap 20 ids. Do not send names, scores, or other players' data to be stored.
- Response header `Prefer: return=minimal` on writes.
- Identity: `install.json` id is the install key. Riot PUUID (32 lowercase hex, hyphens stripped) is the user key.
- Do not send other players' names. Do not persist lobby snapshots.
- Author crown and gold name stay. Overlay users get a non-gold mark and no crown. If the player is the author, show only the crown.
- Copy: EN `Uses this overlay` / TR `Bu overlay'i kullanıyor`.
- "Online" means `last_seen` within 360 seconds. "Today" is Europe/Istanbul (UTC+3, no DST).
- Anon role can insert/update telemetry tables and call `match_overlay_users`. Anon cannot select or delete. Full reads require a row in `admins`.
- Do not commit. Do not switch branches. Do not stage `.planning/` deletions.
- No new runtime dependencies. `reqwest`, `flate2`, `uuid`, and `serde` are already in the crate. Do not gzip the body: PostgREST will not inflate it. Compact means hyphenless hex only.
- Config: compile-time `SUPABASE_URL` and `SUPABASE_ANON_KEY` via `option_env!`. If either is missing, read `{app_data_dir}/telemetry.json` with `{ "url", "anonKey" }`. If still missing, disable.

## Review Focus

- A game-state emit that only changes score must not cause an HTTP call.
- An empty or idle roster must not clear already-discovered overlay users in the UI.
- A failed lookup must leave the game UI unchanged.
- `match_overlay_users` must not be usable to dump the user table.
- Telemetry startup must not race a second install id against `usage::report`.

---

### Task 1: Schema and admin page

**Files:**
- Create: `supabase/schema.sql`
- Create: `admin/index.html`
- Create: `admin/config.example.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: tables `users`, `presence`, `sessions`, `admins`; RPC `match_overlay_users(ids text[]) returns text[]`

- [ ] Write `supabase/schema.sql` with the columns, RLS, trigger, and RPC below.
- [ ] Write the static admin page and example config.
- [ ] Ignore `admin/config.js`.

### Task 2: Rust telemetry

**Files:**
- Create: `src-tauri/src/telemetry.rs`
- Modify: `src-tauri/src/usage.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `usage::ensure_install_id`, `AppState.http_client`, `AppState.api`, events `connection_changed` and `game_state_changed`
- Produces: event `overlay_users` payload `{ "puuids": string[] }` hyphenless lowercase. Frontend only adds these; it never clears on an empty payload.

- [ ] Add `ensure_install_id` under the existing report lock.
- [ ] Unit-test normalize, compact, and phase/roster extraction.
- [ ] Spawn telemetry from `setup` without awaiting it.
- [ ] Run `cargo test --lib telemetry -- --test-threads=8` from `src-tauri`.

### Task 3: Overlay user mark

**Files:**
- Create: `src/stores/overlayUsersStore.ts`
- Create: `src/components/OverlayUserMark.tsx`
- Modify: `src/hooks/useGameLoop.ts`
- Modify: `src/components/PlayerCard.tsx`
- Modify: `src/components/PlayerPanel.tsx`
- Modify: `src/components/LastMatchCard.tsx`
- Modify: `src/lib/i18n.ts`

**Interfaces:**
- Consumes: event `overlay_users` `{ puuids: string[] }`
- Produces: `useOverlayUsersStore` with `add(puuids: string[])` and a hyphen-insensitive membership check

- [ ] Listen in `useGameLoop` and add ids. Ignore empty arrays.
- [ ] Render the mark beside the author crown slot. Author wins; no second mark, no gold name.
- [ ] Add both locale strings next to the existing author keys.
