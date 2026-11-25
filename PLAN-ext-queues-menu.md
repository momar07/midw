# Parked plan: Extensions and Queues under the Call Center menu

Deferred on 2026-11-14. Nothing was changed on the server.

## The idea

No code is copied. The Extensions and Queues pages are embedded FreePBX
pages, reached today through PBX → PBX Configuration:

    Extensions → /admin/config.php?display=extensions   (module core)
    Queues     → /admin/config.php?display=queues       (module queues)

Both modules exist in /var/www/html/admin/modules/. Issabel has a native
menu type `framed` that renders a Link in the content iframe — the same
mechanism the "PBX Configuration" entry (pbxadmin, framed, /admin/) uses.

## Steps

1. `installer/issabel-cc-dashboard.sh`, the menu block (after cc_reports):
       ('cc_ext',     'cc_parent', '/admin/config.php?display=extensions', 'Extensions', 'framed', 18),
       ('cc_queues',  'cc_parent', '/admin/config.php?display=queues',     'Queues',     'framed', 19);
   add both ids to the DELETE list as well.
2. The acl block: resources cc_ext and cc_queues with descriptions, and the
   two `acl_group_permission` rows (action 1, group 1) — same pattern as the
   existing four. Update the two result listings at the bottom of the script.
3. `bootstrap.sh` needs no change (it runs the dashboard installer).
4. Run the installer on the box (idempotent DELETE-then-INSERT of the named
   ids; the existing six entries stay untouched).

## Verification

- The sidebar shows Extensions and Queues under Call Center.
- Click each: the FreePBX page renders in the frame (this proves the
  Issabel→FreePBX session bridge works for deep links — the one assumption
  to verify).
- Regression: the four dashboard modules still open normally.

## Notes / expectations

- The pages look like PBX Configuration (FreePBX dark theme), not the
  dashboard style.
- They are read-write: the supervisor can actually edit extensions/queues,
  same as in PBX Configuration. View-only for supervisors would be a
  FreePBX ACL topic, separate from this task.
