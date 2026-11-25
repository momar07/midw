# Live Monitor (XCally/Issabel-style) — Implementation Plan

Status: **partially implemented / evolving** (core monitor, AMI event-driven updates, queue polling, KPIs/cards, agents/queues views, and later Reports redesign have been implemented incrementally; some items below may be superseded or still open).  
Scope: build the Live Monitor dashboard UI in the existing Issabel Call Center middleware SPA (`public/index.html` + JS) and wire it to middleware/AMI data, matching the requested XCally-style layout.

> Note: This document started as a pre-implementation plan. Refer to current code (`server.js`, `db.js`, `ami.js`, `public/index.html`) and README for the authoritative behavior.

Related parked docs: `queuemonitor.md` (queue snapshot/call column/force-logout concept), `PLAN-decline-logging.md`, `PLAN-ext-queues-menu.md`.

## 1. Current state (verified)

- **Monitor UI**: `public/index.html` is a single SPA. `#view-monitor` renders one agent table: `Agent | Extension | Status | Reason | In status | Action (AdminBreak)`. JS keeps an `agents` map with `applyState/applyKnown/render` and a 1s timer for `In status`; WS connects to `ws(s)://<host><basePath>ws?token=` and expects `{event:"supervisor_update", agents}` (`index.html` ~345-447, 1015-1063).
- **Backend**: `server.js` broadcasts `supervisor_update` with `liveAgents()` only on agent changes/connect (`~163-194, 676, 703, 733, 776, 598, 661`); `/api/admin/live_state` returns `{agents, known, time}` (`~562-570`). No queue polling/snapshot, no force-logout endpoint. `config.js` has no poll interval.
- **AMI**: `ami.js` emits every event (`~124-126`) and `action()` resolves/rejects on the first `Response` for an `ActionID` (`~142-156, 188-206`) — it does not collect the multi-event `QueueStatus` stream into one result. AMI `QueueStatus` needs no extra manager privileges beyond existing `read/write=agent` (per `queuemonitor.md`).
- **Data**: `db.js`/MySQL store agent/session logs and summaries but **no queue stats** (completed/abandoned/taken/made/SLA/AVG QSA/QTT). README/plans confirm AMI is the live source; `queuemonitor.md` proposes a `QueueStatus`-based snapshot + `call` column + `POST /api/admin/force_logout`.
- **Docs alignment**: parked plans note menu ids 18/19 remain free, suggest shared `QUEUE_POLL_SECONDS`, and this work stays inside existing Live Monitor (no new menu/DB/MicroSIP by default).

## 2. Target UI (requested spec)

### 2.1 Top KPI summary cards (responsive grid)
Each card: distinct solid background, white icon (left/top), bold number (right). **Omit any "Browsers Connected" card.**

| Card | Color | Icon | Label | Value |
|---|---|---|---|---|
| Waiting QC | `#f39c12` (yellow/orange) | Clock | Waiting QC | live waiting calls count |
| Active QC | `#e74c3c` (red) | Phone | Active QC | live active queue calls count |
| Completed QC | `#2ecc71` (green) | Smiley | Completed QC | live completed calls count |
| Abandoned QC | dark yellow/muted | Sad | Abandoned QC | live abandoned calls count |
| Agents Logged | `#27ae60` (green) | Users/Group | Agents Logged | total logged-in agents |
| Agents Paused | `#8e44ad` (purple) | Coffee/Cup | Agents Paused | total paused agents |
| Total QC | `#3498db` (blue) | Target/Bullseye | Total QC | total queue calls count |
| AVG QSA | purple | Speedometer | AVG QSA | avg speed of answer (e.g. `5.6 s`) |
| AVG QTT | blue | Flag | AVG QTT | avg queue talk time (e.g. `97.7 s`) |

**Global Service Level**: dedicated section with 4 circular progress gauges showing SLA % for thresholds `SL 90% [10s]`, `SL 80% [20s]`, `SL 70% [30s]`, `SL 70%+ [30+s]`.

### 2.2 Middle section: dual tabs (`Agents` default, `Queues`)

#### Tab A — Agents Live View (`#agents-tab`)
- **Filter bar**: entries-per-page selector (e.g. `[10 v]`), `Search Status` dropdown (`[Select v]`), `Search Agent` text input.
- **Table columns**:
  - `Name`: agent username (e.g. `a.salem`, `hady`, `maha`)
  - `Status`: color-coded badge — `READY` green `#27ae60`; `TASK` orange `#d35400` + live elapsed timer (e.g. `00:09:27`); `PAUSE` orange/yellow + live pause timer (e.g. `PAUSE 00:04:29`); `TALKING` red `#c0392b` showing caller ID (e.g. `TALKING (01201405307)`)
  - `Queue`: current queue name or `--` if idle
  - `Time`: duration in current state (e.g. `00:00:28`)
  - `Calls`: two inline badges — blue `#Taken: X`, red `#Made: Y`
  - `Info`: two inline badges — blue `#Queue: A`, red `#Pause: B`
  - `Action`: supervisory actions dropdown (e.g. blue `Pause ALL v`, purple `Resume ALL`, plus per-agent actions as decided)

#### Tab B — Queues Live View (`#queues-tab`)
- **Filter bar**: entries selector (`[10 v]`) and general search input.
- **Table columns**:
  - `Queue`: queue name
  - `Waiting`: callers waiting (yellow/light background cell)
  - `In Call`: active calls
  - `C` (Completed): green cell background
  - `A` (Abandoned): red/light-red cell background
  - `T` (Transferred): transferred calls count
  - `SLA`: light blue cell showing SLA % and threshold (e.g. `0.0% in 0s`)

### 2.3 Technical & UX requirements
- **Real-time**: Agents table via WebSocket push for instant state changes (login/logout/pause/talking). Queues table & KPI cards via lightweight background poller (e.g. `QueueStatus` every 5s) and/or synchronized WS broadcasts.
- **Styling**: consistent with Issabel purple/white theme wrapper, Bootstrap card components, clean table typography, clear status badge colors.

## 3. Gaps / data-source decisions (resolve before or during implementation)

Metrics/fields **not available in current code/data**:
- `Completed QC`, `Abandoned QC`, `Total QC`
- `AVG QSA`, `AVG QTT`
- Per-threshold `Global Service Level` (10s/20s/30s/30+s)
- Agent `Calls #Taken/#Made`
- Queue `C/A/T/SLA`

**Known live source:** AMI `QueueStatus` (read=agent, no extra perms) returns `QueueParams` (waiting/holdtime/servicelevel context), `QueueEntry` (caller, wait), `QueueMember` (status, and often calls taken — Asterisk-version dependent). It does **not** reliably provide historical completed/abandoned/talk-time aggregates.

**Options to decide:**
1. **MVP-live now, placeholders later**: derive what `QueueStatus` + current session state can provide; show `—`/`0` or "N/A" for unavailable aggregates with clear labeling.
2. **Real aggregates**: inspect box for `queue_log`, `QueueSummary`/CLI/AMI actions, or CDR availability and compute/store counters (in-memory since start and/or persisted). Confirm what Asterisk/Issabel exposes here.
3. **Hybrid**: live waiting/active/agent states real-time; completed/abandoned/SLA/averages from best available source with documented accuracy.

**Other decisions:**
- `Action` column: keep existing `AdminBreak`, replace with `Logout` (per `queuemonitor.md`), or provide both in a dropdown alongside `Pause ALL`/`Resume ALL`.
- Poll rate: `5s` (default, lower load) vs `3s` (snappier) via `QUEUE_POLL_SECONDS`.
- Bulk actions semantics: `Pause ALL`/`Resume ALL` scope (all logged-in agents? all in view?) and server endpoints needed.
- `TALKING` caller ID source (channel/caller from queue/member events vs `QueueEntry` correlation).

## 4. Proposed implementation

### 4.1 Data & API contract
- Extend (don’t break existing consumers) WS and HTTP payloads:
  - `supervisor_update { event, agents, queues, kpis, ts }`
  - `GET /api/admin/live_state` → same enriched shape `{ agents, known, queues, kpis, time }`
- `agents[]`: existing fields + `call/state` mapping for `READY|PAUSE|TASK|TALKING`, `queue`, `state_since`/duration basis, `caller` (if known), `calls_taken`, `calls_made`, `queue_count`, `pause_count` (as available).
- `queues[]`: `{ queue, name, waiting, in_call, completed, abandoned, transferred, sla: {percent, threshold_s}, longest_wait, entries:[{caller,wait,position?}] }`.
- `kpis`: `{ waiting_qc, active_qc, completed_qc, abandoned_qc, total_qc, agents_logged, agents_paused, avg_qsa_s, avg_qtt_s, sla: { s10, s20, s30, s30p } }`.

### 4.2 Backend (`config.js`, `ami.js`, `server.js`)

**`config.js`**
- Add `queuePollSeconds` from `QUEUE_POLL_SECONDS` (default `5`).

**`ami.js`**
- Add support to collect a full multi-event action response (e.g. `actionCollect`/ActionID-scoped collector) so `QueueStatus` events (`QueueParams`, `QueueMember`, `QueueEntry`, …, `QueueStatusComplete`) can be assembled into one snapshot; keep existing `action()` behavior unchanged for current callers.

**`server.js`**
- **Queue poller**: on AMI `login` start interval; each tick send `QueueStatus`, collect per ActionID into snapshot `{queues[], kpis}`. Swap snapshot atomically.
- **Broadcasts**: include `queues` and `kpis` in every `supervisor_update` (on agent change/connect and on each poll swap) so dashboards stay in sync; include in initial WS state and `/api/admin/live_state`.
- **Agent enrichment**: extend `liveAgents()` with derived display/call state (`READY/PAUSE/TASK/TALKING`), current queue, caller ID when known, timers/since, and available counters from member/session data.
- **Actions**: add `POST /api/admin/force_logout {extension}` (admin auth) → find session → `dropSession(entry, 'forced by supervisor')` (reuses existing cleanup: QueueRemove, logout log, WS close, broadcast), error on unknown. Add bulk endpoints if required (`/api/admin/pause_all`, `/api/admin/resume_all`) using existing pause/AMI paths.
- **Resolution**: map member interfaces/extensions via existing `sip.dial`/`amiInterface` logic; include queue names where available.

### 4.3 Frontend (`public/index.html`, JS, CSS)

- **Monitor layout**: replace single table in `#view-monitor` with KPI card grid + Global Service Level gauges + tabbed `Agents`/`Queues` section.
- **KPI cards & gauges**: responsive Bootstrap grid, specified colors/icons/labels/values; 4 circular progress gauges (SVG/CSS rings) for SLA thresholds; AVG QTT card; omit Browsers Connected.
- **Agents tab**: filter bar (entries-per-page, status dropdown, agent search) + table/badges/timers per spec; client-side filter + pagination; per-agent and bulk actions wired to admin endpoints with confirmations where destructive.
- **Queues tab**: filter bar (entries selector, search) + table with specified column/cell coloring (Waiting yellow, C green, A red/light-red, SLA light blue) and queue detail as available.
- **State & rendering**: extend store to `{agents, queues, kpis}`; update `applyState/applyKnown/refresh` for enriched payloads; keep 1s tick for live elapsed/pause/talk timers; instant agent updates via WS, queues/KPIs refreshed from poll-driven broadcasts (with optional lightweight fetch fallback).
- **Styling**: preserve Issabel purple/white wrapper and `basePath/apiUrl/wsUrl` behavior; add scoped styles for cards/badges/gauges/tabs without breaking other views.

### 4.4 Verification

- **Browser QA**: KPI grid and SLA gauges render and update; Agents/Queues tabs, filters, search, pagination work; badges/timers/colors match spec.
- **Realtime/functional**: WS agent state changes reflect instantly; queue/KPI values refresh on poll cadence; originate/waiting/ringing/answered scenarios reflect correctly; `AdminBreak`/`Pause ALL`/`Resume ALL`/force-logout (as implemented) behave correctly and refresh board.
- **API**: `/api/admin/live_state` and `supervisor_update` carry `queues`/`kpis`; new endpoints require admin token (401 without), succeed with token, handle unknown targets safely.
- **Regression**: existing Reports/Agents/Pauses views and login/keepalive behavior unaffected.

### 4.5 Deploy notes

- Backup, then package changed files (expected: `server.js`, `config.js`, `ami.js`, `public/index.html`, and docs) and restart `cc-middleware`.
- Update `README.md` (and `.env.example` if adding `QUEUE_POLL_SECONDS` or other vars) to document new endpoints/payload fields/behavior.
- Default: no DB schema, MicroSIP, menu, or AMI permission changes unless a chosen metrics source requires them (document if it does).

## 5. Suggested delivery slices

1. **Decide metrics source/contract** (MVP-live vs real aggregates) and action semantics.
2. **Backend snapshot + enriched payloads** (AMI collect, poller, `queues/kpis`, live_state/WS, force-logout/bulk endpoints).
3. **Frontend monitor rebuild** (KPI cards + gauges + Agents/Queues tabs, filters, timers, actions).
4. **QA, docs, deploy artifacts**.
