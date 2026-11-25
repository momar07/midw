# Call center middleware

The server side of the MicroSIP call center agent: it answers the login of
the agent and holds the websocket session of every agent that is logged in.
All the data comes from the Issabel database, the middleware only reads it.

```
MicroSIP agent toolbar
   |  POST /api/login                ->  {sip_extension, sip_password, sip_server_ip,
   |                                       sip_server_port, assigned_queues,
   |                                       pause_reasons, token, timestamp}
   |  WS   /ws  (Bearer <token>)      ->  {"event":"ping"}        every 30 s
   |                                    {"event":"state_update"} on a change
   |  <- {"event":"pong"}
   |  <- {"event":"status_change"}    ->  {"event":"state_update"} (the echo)
```

The vocabulary is fixed and it is the one of the client: **`available`** and
**`pause`**, nothing else. The echo of a status change carries exactly what the
agent sent, so the agent does not take its own change for a new one (its status
timer would restart).

## Install on the Issabel box

A fresh Issabel box gets everything with the bootstrap (node, the middleware,
the database with its tables and user, the ami user, the service, the proxy
and the sidebar of Issabel):

```bash
tar czf middleware.tgz -C /home/momar/apps middleware --exclude=.env
scp middleware.tgz root@<new-issabel>:/tmp/
ssh root@<new-issabel> 'cd /tmp && tar xzf middleware.tgz && bash /tmp/middleware/installer/bootstrap.sh'
```

It prints the admin token at the end. The options of the bootstrap are at the
top of `installer/bootstrap.sh` (`--sip-ip`, `--db-pass`, `--ami-secret`,
`--db-root-pass`), every step is idempotent. The manual steps, one by one:

```bash
# 1. node (portable, the same runtime as on the development box)
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p /opt/node && tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm  /usr/local/bin/npm

# 2. the middleware
mkdir -p /opt/middleware
cd /opt/middleware && npm install --omit=dev

# 3. the database user
mysql -uroot -p -e "
CREATE USER IF NOT EXISTS 'cc_middleware'@'localhost' IDENTIFIED BY '<password>';
GRANT SELECT ON asterisk.cc_agents TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.cc_agent_queues TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.cc_pause_reasons TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.sip TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.queues_config TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT ON asterisk.cc_agent_logs TO 'cc_middleware'@'localhost';"

# 4. the service (see cc-middleware.service below)
systemctl daemon-reload && systemctl enable --now cc-middleware
```

## The configuration (`.env`)

| Key | Default | |
|---|---|---|
| `PORT` | 8080 | the port of the middleware |
| `DB_HOST` / `DB_USER` / `DB_PASS` / `DB_NAME` | localhost / cc_middleware / - / asterisk | the Issabel database |
| `SIP_SERVER_IP` / `SIP_SERVER_PORT` | 192.168.2.22 / 5060 | the sip server the agent registers to |
| `AMI_HOST` / `AMI_PORT` | 127.0.0.1 / 5038 | the asterisk manager interface |
| `AMI_USER` / `AMI_SECRET` | - / - | the ami user, without it there is no ami and the queues are not touched |
| `TOKEN_SECRET` | - | the key of the signed tokens |
| `ADMIN_TOKEN` | - | the token of the admin hook, empty means the hook is off |
| `TOKEN_TTL` | 43200 | the life of a token in seconds |
| `PING_SECONDS` / `MISSED_PONGS` | 30 / 2 | the keepalive |

The file belongs to the service user only: `chown asterisk:asterisk .env` and
`chmod 640 .env`.

## The service

```ini
[Unit]
Description=Call center middleware of the MicroSIP agent
After=network.target mysqld.service mariadb.service
Wants=network.target

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/middleware
EnvironmentFile=/opt/middleware/.env
ExecStart=/usr/local/bin/node /opt/middleware/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## The admin hook

`POST /simulate/state` is how the remote admin (the acceptance tests, the
supervisor) changes the state of an agent:

```bash
curl -X POST http://192.168.2.22:8080/simulate/state \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"extension":"1000","status":"pause","reason":"AdminBreak"}'
```

Without the token the hook answers **401**, and when `ADMIN_TOKEN` is empty the
hook is off (404).

## The sip secret

The middleware reads the sip secret of the extension from the `sip` table of
Issabel, it never writes it:

```sql
SELECT data AS sip_password FROM sip WHERE id = <extension> AND keyword = 'secret';
```

**The extension has to exist in Issabel** (PBX Configuration -> Extensions),
otherwise the agent can log in but it will not register (the middleware warns
about it in its log).

## The second login of an agent

An agent that is killed (end task, the window is closed) leaves its session
behind: the socket is never closed, the middleware still holds it and asterisk
still has the agent in its queues. The keepalive cleans it up after two missed
pongs, but that takes a minute.

`POST /api/login` heals it: when the extension is already logged in, the old
session is dropped **before** the new one is created.

```
the session of the extension 1000 is superseded by a new login
the agent 1000 leaves the queues (superseded by new login)
QueueRemove 800 PJSIP/1000
login ok for agent1 (extension 1000)
QueueAdd 800 PJSIP/1000
```

`dropSession()` does the whole cleanup: the `QueueRemove` for every queue of
the agent, the `logout` in `cc_agent_logs`, the close of the old socket and the
`supervisor_update` for the dashboard. The `QueueRemove` goes out before the
answer of the login, so the `QueueAdd` of the new session comes after it and the
agent ends up in its queues.

## The tests

```bash
node test_db.js                     # the database and the data of the agents

# the 15 point contract suite of the client against this middleware
CC_TEST_URL=http://192.168.2.22:8080 CC_TEST_ADMIN_TOKEN=<token> \
    node /home/momar/apps/MicroSIP-3.22.16-src/tests/contract_test.js

# the second login of an agent: the old session is dropped
CC_TEST_URL=http://192.168.2.22:8080 CC_TEST_ADMIN_TOKEN=<token> \
    node /home/momar/apps/MicroSIP-3.22.16-src/tests/duplicate_login_test.js
```

With `CC_TEST_URL` the suite does not start the mock and skips the three
checks that read the log of the mock (the missed pongs and the logout event).

## The log of the agent

Every login, logout, pause and unpause is written to `cc_agent_logs`:

```sql
INSERT INTO cc_agent_logs (agent_id, event_type, pause_reason_id) VALUES (?, ?, ?);
```

`event_type` is one of `login`, `logout`, `pause`, `unpause` (the enum of the
table). The reason of a pause is resolved from `cc_pause_reasons`.

## The dashboard of the supervisor

`http://<the box>:8080/` serves a small single page application
(`public/index.html`, vanilla javascript and a vendored bootstrap 5 ✓, nothing
is fetched from the internet ✓).

* the token goes into the field at the top, it is kept in the browser
  (localStorage) ✓ and it can also be given in the link
  (`?token=…`) ✓,
* the **Live Monitor** table shows every agent: the ones that are logged in
  are green (available) or yellow (paused), the ones that are known but not
  connected are grey (offline) ✓,
* the **AdminBreak** button pauses the agent through the middleware, the pause
  goes to asterisk over the ami ✓,
* the dashboard connects to `/ws?token=…` (a browser cannot send headers on a
  websocket ✓) and gets a `supervisor_update` on every change ✓.

The api behind it:

| | |
|---|---|
| `GET /api/admin/live_state` | the agents that are logged in (`agents`) and the ones the middleware knows (`known`) ✓ |
| `WS /ws?token=<admin token>` | `{"event":"supervisor_update","agents":[…]}` on every change ✓ |

Both need the admin token (`Authorization: Bearer …` for the api, the query for
the websocket ✓).

```bash
node /home/momar/apps/MicroSIP-3.22.16-src/tests/supervisor_client.js <admin token>
```

prints the updates on the console, it is the manual test of the dashboard.

## The supervisor dashboard, the agents and Issabel

### The api of the agents

| | |
|---|---|
| `GET /api/admin/agents` | every agent with its queues (`agents`) and the queues of the call center (`queues`) ✓ |
| `POST /api/admin/agents` | a new agent (`username`, `password`, `sip_extension`, `queues`) ✓ |
| `PUT /api/admin/agents/:id` | the changes of an agent, `is_active` enables it again ✓ |
| `DELETE /api/admin/agents/:id` | the agent is disabled (`is_active = 0`), the row stays (the log of the agent points at it) ✓ |

All of them need the admin token ✓. The database user of the middleware needs
write access on the two tables:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.cc_agents TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.cc_agent_queues TO 'cc_middleware'@'localhost';
```

`GET /api/admin/agents` also answers with the lists of Issabel, so the
supervisor does not have to type the extensions and the queues:

```json
{ "agents": [],
  "extensions": ["1000"], "configured_queues": ["800"] }
```

### The pause reasons and the reports

| | |
|---|---|
| `GET /api/admin/pause_reasons` | every reason, the inactive ones too (`reasons`) ✓ |
| `POST /api/admin/pause_reasons` | a new reason (`reason_code`, `description`, `is_active`), a taken code is a 409 ✓ |
| `PUT /api/admin/pause_reasons/:id` | the changes of a reason, `is_active` enables it again ✓ |
| `DELETE /api/admin/pause_reasons/:id` | a reason that is in the log of the agents is deactivated instead of removed (`{"deactivated":true}`) ✓ |
| `GET /api/admin/reports/filters` | agents/queues lists for report filters ✓ |
| `GET /api/admin/reports/agent_logs` | the lines of the log of the agents, newest first (`from`/`to`, `agent_id`, `event`, `page`, `per_page`); row durations/end times are resolved in DB ✓ |
| `GET /api/admin/reports/agent_summary` | legacy summary cards data: `logins`, `breaks`, `pause_seconds`, `work_seconds` ✓ |
| `GET /api/admin/reports/pause_summary` | breaks per reason: `breaks`, `total_seconds` ✓ |
| `GET /api/admin/reports/agent_performance` | per-agent summary over range: taken/made (from daily stats), total/avg talk (from queue_log), pause time, timeout/declined/total abuse (from requeue logs) ✓ |
| `GET /api/admin/reports/requeue_abuse` | detailed requeue/abuse rows from `queue_requeue_logs` with filters (`agent`, `queue`, `reason` TIMEOUT/DECLINED), pagination or `all=1` for export ✓ |
| `GET /api/admin/reports/queue_summary_sla` | per-queue summary from `/var/log/asterisk/queue_log`: total/completed/abandoned/abandon %, avg QSA, avg talk, SLA % ✓ |
| `GET /api/admin/reports/hourly_traffic` | hour-by-hour traffic (00:00–23:00) from queue_log ✓ |
| `GET /api/admin/reports/queue_calls_detail` | individual queue call records from queue_log (paged / `all=1`) ✓ |
| `GET /api/admin/reports/outbound_calls` | outbound calls by agent extensions from `asteriskcdrdb.cdr` (paged / `all=1`) ✓ |

The dashboard has views for them; the installer registers `Pause Reasons` (cc_pauses) and `Reports` (cc_reports) in the sidebar of Issabel. Reports SPA (`#reports`) provides categorized tabs (Agents/Queues/Calls), dynamic filters, scrollable/sticky-header table with pagination/entries selector, and CSV/Excel export of all filtered rows.

Reports data sources/notes:
- `cc_agent_logs`, `cc_pause_reasons`, `cc_daily_agent_stats`, `queue_requeue_logs` (app DB tables)
- `/var/log/asterisk/queue_log` file parsing for queue summary/hourly/call detail and talk-time enrichment (some installs have no `asterisk.queue_log` DB table)
- `asteriskcdrdb.cdr` for outbound calls

DB grants needed by middleware (in addition to base agent/sip/queue reads and `cc_agent_logs` insert):

```sql
GRANT INSERT, UPDATE, DELETE ON asterisk.cc_pause_reasons TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT ON asterisk.queue_requeue_logs TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT, UPDATE ON asterisk.cc_daily_kpis TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT, UPDATE ON asterisk.cc_daily_agent_stats TO 'cc_middleware'@'localhost';
GRANT SELECT ON asteriskcdrdb.cdr TO 'cc_middleware'@'localhost';
```

* `extensions`: the extensions of Issabel (`sip` with the keyword `account`),
* `configured_queues`: the queues of Issabel (`queues_config`).

Only the queues that **exist** in Issabel are in the list. A queue that an
agent still has but that was deleted in Issabel is not one of them (it does not
exist in asterisk either, so the agent was never really a member of it). When
the supervisor edits that agent, the modal says that the queue goes away with
the save.

The modal has **no free text** for the extension and the queues: the two lists
are the only source. The api refuses a queue that does not exist in Issabel,
so a queue that asterisk would not know cannot be written:

```json
{ "error": "the queue 999 does not exist in issabel" }
```

### The sidebar of Issabel

`installer/issabel-cc-dashboard.sh` adds the dashboard to Issabel:

* the two modules `/var/www/html/modules/cc_monitor` and
  `/var/www/html/modules/cc_agents_mgr` (the folder of a module must have the
  same name as the menu entry, the framework does
  `file_exists("modules/$selectedMenu/index.php")`), each one an iframe of the
  dashboard ✓,
* the category **Call Center** with the two entries **Live Monitor** and
  **Manage Agents** in `menu.db` ✓,
* the permissions of the administrator in `acl.db` ✓.

The menu of Issabel 4 is:

```sql
menu (id, IdParent, Link, Name, Type, order_no)
```

and the framework joins it with the acl (`paloSantoMenu.class.php`):

```sql
FROM menu, (...) AS aclu WHERE acl_resource_name = id
```

so the name of the `acl_resource` must be the id of the menu entry ✓ and the
permission needs an action (`1` is *access*) and a group (`1` is the
administrator) ✓.

The modules read the admin token from `/opt/middleware/.env` at every page
load, so a new token is picked up without touching them. For that the apache
user has to be in the asterisk group (the script does it) ✓.

The script is idempotent, it can run again after a change ✓.

### Three things Issabel needs

**1. The content of a module is returned, not printed.** The framework puts
the value of `_moduleContent` in the content box of the page
(`$smarty->assign("CONTENT", $sModuleContent)`). A module that `echo`es its
markup writes it to the output buffer *before* the template is rendered, so the
dashboard appears **above** the frame of Issabel instead of inside it:

```php
function _moduleContent(&$smarty, $module_name)
{
    return '<iframe src="..."></iframe>';   // not echo
}
```

**2. The dashboard is proxied by the web server.** Issabel is served over
https, a https page can not show a http iframe (mixed content, the frame stays
white). `/etc/httpd/conf.d/cc-dashboard.conf`:

```apache
ProxyPass /cc/ws ws://127.0.0.1:8080/ws
ProxyPass /cc/ http://127.0.0.1:8080/
ProxyPassReverse /cc/ http://127.0.0.1:8080/
```

The dashboard uses relative urls (the api and the websocket follow the page) ✓,
so it works at the root of the middleware (`http://192.168.2.22:8080/`) and
behind the proxy (`https://192.168.2.22/cc/`) ✓.

**Every call of the api goes through `apiUrl()`** (`basePath() + path` ✓). A
hard coded `/api/admin/agents` works at the root of the middleware and is a
**404 behind the proxy** (`/cc/api/admin/agents` ✓) → the button that opened it
does nothing ✓.

**3. The order of the menu.** Issabel drops a parent that is read *after* its
children (`paloSantoMenu.class.php`: the entry is removed from the array and
only added back when a child that is not authorized finds it). So the category
has to come **before** its modules:

| id | order_no |
|---|---|
| `cc_parent` | 13 |
| `cc_monitor` | 14 |
| `cc_agents_mgr` | 15 |

Every other category of Issabel is ordered the same way ✓.

## The asterisk manager interface

The middleware talks to asterisk over the AMI (`ami.js`, the modules of node
only ✓):

| Moment | Action |
|---|---|
| the agent logs in | `QueueAdd` for every queue of `cc_agent_queues` → the agent is a member |
| the agent logs out, or two pongs are missed | `QueueRemove` for every queue → no stale member is left behind |
| the agent takes a break | `QueuePause` with `Paused: true` and the reason → the reason lands in the queue log |
| the agent comes back | `QueuePause` with `Paused: false` |

The **interface** of the member is not guessed: Issabel keeps it in the `dial`
field of the `sip` table (`PJSIP/1000` ✓), the middleware reads it there. Asking
asterisk itself would need broader ami rights than the module needs.

The user of the ami on the box (`/etc/asterisk/manager_custom.conf`):

```ini
[cc_middleware]
secret = <the secret of the .env>
permit = 127.0.0.1/255.255.255.255
read = agent,call
write = agent,call
```

`write = agent` is needed for queue member actions (`QueueAdd`, `QueueRemove`, `QueuePause`). `read = agent,call` enables member and queue/call events used for real-time live monitor updates, KPI/queue state, and requeue/abuse tracking (`QueueMember*`, `QueueCaller*`, `Agent*`, `Hangup`, etc.). Asterisk 20 does not support the `Subscribe` action here; events flow from manager read classes on the session. A periodic `QueueStatus` poll (fallback/reconciliation) may also run.

Relevant runtime behavior (current):
- Live supervisor state is broadcast via websocket/HTTP with agent/queue/KPI data.
- Daily KPIs and per-agent daily stats are persisted (`cc_daily_kpis`, `cc_daily_agent_stats`) and reloaded on startup/midnight rollover logic.
- Queue requeue/abuse events are logged to `queue_requeue_logs` (TIMEOUT/DECLINED classification from ring/hangup context).

## The manual test

```bash
node /home/momar/apps/MicroSIP-3.22.16-src/tests/hold_agent.js http://192.168.2.22:8080
```

It logs in, it takes a break, it comes back and it logs out. The queue shows
what happened:

```
asterisk -rx 'queue show 800'
   Members:
      PJSIP/1000 (ringinuse enabled) (dynamic) (paused:Break was 6 secs ago) ...
```

and the queue log tells the story:

```
ADDMEMBER  | MANAGER | 800 | PJSIP/1000
PAUSE      | NONE    | 800 | PJSIP/1000 | Break
UNPAUSE    | NONE    | 800 | PJSIP/1000
REMOVEMEMBER| MANAGER| 800 | PJSIP/1000
```
