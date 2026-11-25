# Parked plan: decline logging (AMI)

Deferred on 2026-11-14. The plan is decision-complete except the two open
questions at the bottom.

## The idea

No MicroSIP change. A decline is already visible to asterisk: the client
answers the INVITE with 486 Busy (or 603 → cause 21), which shows up on the
AMI as a Hangup of the agent channel with cause 17/21 **before any answer**.
The middleware is already connected to the AMI (user cc_middleware), it only
does not listen to call events yet. The cdr table is empty (mysql cdr off)
and there is no queue_log table on this box, so the AMI is the right source.

## Steps

1. `manager_custom.conf`: `read = agent` → `read = agent,call`, then
   `asterisk -rx "manager reload"`.
2. `cc_agent_logs`:
   `MODIFY event_type ENUM('login','logout','pause','unpause','decline')`
   and `ADD COLUMN caller VARCHAR(80) NULL` (the caller number).
   The same two changes go into `installer/bootstrap.sh`.
3. `ami.js`: on Hangup of a channel of a known agent extension with
   cause 17/21 and no answer before it → insert a `decline` row with the
   caller number. A hangup after an answer is cause 16, never logged.
   Extension→agent lookup from cc_agents, small cached map.
   `db.logEvent` gains the caller parameter. No supervisor WS broadcast.
4. Reports (`public/index.html` + `db.js` + `server.js`):
   - `decline` in the event filter list, red badge, new **Caller** column
   - `agent_summary` gains a `declines` count, shown under Total Logins
     ("N declined"), no extra card
5. Deploy: backup, tar `server.js db.js ami.js public/`, the two ALTERs,
   the manager edit + reload, restart `cc-middleware`.

## Verification (needs the user)

- The user calls the MicroSIP extension and presses Decline → a `decline`
  row appears in the Agent Log with the caller number.
- One timeout call → must NOT be logged as a decline.

## Open questions

- Placement: rows in the existing Agent Log (as written above) or a separate
  "Declined Calls" menu page.
- Scope: declines only, or also missed calls (caller hangup / queue timeout
  before answer, separate `missed` event, grey badge).
