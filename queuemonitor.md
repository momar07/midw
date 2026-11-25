# Parked plan: Queue Monitor + agent Call column + supervisor force logout

Deferred on 2026-11-14 (original plan). **Partially realized since then** in different forms (queue/KPI live state, AMI event-driven updates, richer agent/queue UI) — treat remaining items below as historical/reference, not a current TODO. Verify against current `server.js`/`public/index.html` before implementing anything from here.

## What it does

Inside the existing **Live Monitor** page (`cc_monitor`), two stacked tables:

    [ Queue table (new, on top) ]
    [ Agent table (existing, + Call column + Logout button) ]

No new Issabel menu entry, no DB changes, no MicroSIP change, no AMI
permission change.

## Research facts (verified on the box)

- The AMI action `QueueStatus` needs **no manager privileges** (`<none>`,
  checked with `manager show command QueueStatus`), so the current
  `read/write = agent` grant is enough.
- One `QueueStatus` action returns everything:
  - `QueueParams`: waiting calls count, holdtime, service level
  - `QueueEntry`: each waiting caller (CallerIDNum, wait time)
  - `QueueMember`: per member the device `Status` field
    (1=NOT_INUSE free, 2=INUSE in call, 3=BUSY, 5=UNAVAILABLE,
     6=RINGING, 7=RINGINUSE, 8=ONHOLD) — this is the per-agent
     "live call / ringing call" state for the new column.
- Member interfaces are `SIP/<ext>` (the middleware already resolves them
  via the sip table dial field, `amiInterface()` in server.js) and the
  parser in `onAmiEvent` already extracts the extension from them.
- The supervisor force logout already exists as a function:
  `dropSession(entry, why)` in server.js:654 — it removes the agent from
  every queue (QueueRemove), logs a `logout` event, closes the agent WS and
  broadcasts the supervisor board. The endpoint only has to call it.
- Queues 800 "testqueu" and 802 "testqueue2" exist; agents are dynamic
  members added at login (amiQueueAdd).
- The Ami client (ami.js) already emits all events of an action; events of
  `QueueStatus` carry the ActionID, so snapshots can be grouped per action.

## Steps

### Backend (`server.js`, `config.js`)

1. **Queue poller**: every poll seconds send `QueueStatus`, collect its
   events per ActionID into a snapshot
       [{ queue, waiting, longestWait,
          entries: [{ caller, wait }],
          members: { ext: { status } } }]
   On poll completion swap the snapshot. The **existing
   `supervisor_update` broadcast gains a `queues: [...]` field**, so one WS
   event carries the whole board (agents + queues): pushed immediately on
   any agent change, refreshed every poll from the snapshot. New supervisor
   connections get the full snapshot right away (same as agents today).
   Start the interval on the AMI `login` hook (same place as the queue
   re-add). Poll seconds from env `QUEUE_POLL_SECONDS` (default 5) in
   config.js.
2. **`liveAgents()` gains `call`** per agent, derived from the member
   statuses of that extension in the snapshot:
   2/3/8 → `'in-call'`, 6/7 → `'ringing'`, else `null`.
3. **`POST /api/admin/force_logout {extension}`** behind the admin token:
   find the session by extension, call `dropSession(entry, 'forced by the
   supervisor')`. Unknown extension → JSON error. The agent's MicroSIP
   shows disconnected and can log in again (no rebuild needed).

### Frontend (`public/index.html`, the `#monitor` view)

4. **Queue table on top** (new section above the agents table):
   Queue | Waiting | Longest Wait | In Call | Free/Total — badge styled
   counts, and under each queue with waiting calls a caller list:
   Queue | Caller | Waiting s. Live via the queues field of
   supervisor_update.
5. **Agent table below, as it is, plus**:
   - new **Call** column after Status: badge `In Call` (red), `Ringing`
     (yellow), `—` (none)
   - new last **Action** column: **Logout** button (btn-outline-danger,
     btn-sm, native `confirm()`) → POST force_logout → the board
     refreshes on the broadcast.

### Deploy

6. Backup, tar `server.js config.js public/index.html`, restart
   `cc-middleware`, README updated. Nothing else on the box.

## Verification

- Browser QA: both tables live on one page.
- Originate a test call into queue 800 **while the agent stays paused**
  (a paused member is skipped, the phone does not ring): the waiting call
  appears in the queue table with a growing timer and vanishes on hangup.
- Originate to the agent extension: the Call column shows `Ringing`
  (yellows), answered → `In Call` (red).
- Force logout on a throwaway session, never on the live agent 1005.
- curl the new endpoint without the token (401) and with it.

## Open questions

- Force logout scope confirmed? (remove from queues + drop session,
  the agent can log back in — assumed yes)
- Poll rate: 5s or 3s for the queue table? (the agent table stays
  event-driven and instant either way)

## Notes

- If the parked `PLAN-ext-queues-menu.md` (FreePBX deep links) is applied
  later, its order numbers 18/19 in the menu are free — this plan registers
  nothing.
- The plan needs no change from the parked decline logging plan, but if
  both land, both benefit from the same `QUEUE_POLL_SECONDS` snapshot and
  nothing conflicts.
