#!/bin/bash
# Adds the supervisor dashboard to the sidebar of Issabel.
#
#   installer/issabel-cc-dashboard.sh
#
# It runs on the Issabel box. It creates the four modules of the dashboard, the
# menu entries and the permissions of the administrator.
#
# The menu of Issabel 4 lives in /var/www/db/menu.db:
#
#   menu (id, IdParent, Link, Name, Type, order_no)
#
# The framework joins the menu with the acl (paloSantoMenu.class.php):
#
#   FROM menu, (...) AS aclu WHERE acl_resource_name = id
#
# so the name of the acl resource must be the id of the menu entry, and the
# folder of a module must have the same name as the menu entry
# (index.php: "file_exists("modules/$selectedMenu/index.php")").

set -euo pipefail

MENU_DB=/var/www/db/menu.db
ACL_DB=/var/www/db/acl.db
MODULES_DIR=/var/www/html/modules
ENV_FILE=/opt/middleware/.env
DASHBOARD_URL=${DASHBOARD_URL:-http://192.168.2.22:8080}

if [ ! -f "$ENV_FILE" ]; then
    echo "FATAL: $ENV_FILE is not there" >&2
    exit 1
fi

ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
if [ -z "$ADMIN_TOKEN" ]; then
    echo "FATAL: there is no ADMIN_TOKEN in $ENV_FILE" >&2
    exit 1
fi

echo "== the token of the dashboard is read from $ENV_FILE"

#-----------------------------------------------------------------------------
# the modules
#-----------------------------------------------------------------------------
# The module reads the token from the .env of the middleware, so a new token
# is picked up without touching the module. The apache user needs to be in the
# asterisk group for that.
if ! id -nG apache | tr ' ' '\n' | grep -qx asterisk; then
    echo "== apache is added to the asterisk group (it needs to read the token)"
    usermod -a -G asterisk apache
fi

create_module() {
    local dir=$1
    local hash=$2
    echo "== the module $dir"
    install -d -o asterisk -g asterisk "$MODULES_DIR/$dir"
    cat > "$MODULES_DIR/$dir/index.php" <<EOF
<?php
/* vim: set expandtab tabstop=4 softtabstop=4 shiftwidth=4:
  Codificación: UTF-8
  +----------------------------------------------------------------------+
  | The supervisor dashboard of the call center, an iframe of the       |
  | middleware that serves it.                                          |
  +----------------------------------------------------------------------+
*/

/**
 * The dashboard of the supervisor is an iframe of the middleware. The token
 * is read from the .env of the middleware, so it is never in the web root.
 */
function _moduleContent(&\$smarty, \$module_name)
{
    \$env = '/opt/middleware/.env';
    \$token = '';
    if (file_exists(\$env) && is_readable(\$env)) {
        foreach (file(\$env) as \$line) {
            if (preg_match('/^ADMIN_TOKEN=(.*)\$/', trim(\$line), \$m)) {
                \$token = trim(\$m[1], " \\"'\\r\\n");
                break;
            }
        }
    }
    if (\$token === '') {
        return '<div class="alert alert-danger">The dashboard has no token, '
            . 'the ADMIN_TOKEN of /opt/middleware/.env is missing.</div>';
    }
    # The dashboard is proxied by the web server of Issabel (/cc/), so the iframe
    # is on the same origin: a https page can not show a http iframe.
    \$https = (!empty(\$_SERVER['HTTPS']) && strtolower(\$_SERVER['HTTPS']) !== 'off');
    \$scheme = \$https ? 'https' : 'http';
    \$host = isset(\$_SERVER['HTTP_HOST']) ? \$_SERVER['HTTP_HOST'] : 'localhost';
    # The content of the module must be returned, not printed: the framework
    # puts it in the frame of the page, a print goes out before the frame.
    # The id myframe is the one of the theme: libs/js/iframe.js measures the
    # real place of the frame and gives it the height that is left.
    return '<iframe id="myframe" src="' . \$scheme . '://' . \$host . '/cc/?token=' . urlencode(\$token) . '#${hash}"'
        . ' style="width:100%;height:calc(100vh - 170px);border:0" scrolling="no"></iframe>';
}
EOF
    chown asterisk:asterisk "$MODULES_DIR/$dir/index.php"
    chmod 644 "$MODULES_DIR/$dir/index.php"
}

create_module cc_monitor monitor
create_module cc_agents_mgr agents
create_module cc_pauses pauses
create_module cc_reports reports

#-----------------------------------------------------------------------------
# the loader race of the theme
#-----------------------------------------------------------------------------
# The theme shows a loading overlay while the frame of a module loads and
# hides it on the load of the frame. But the show and the hide race each
# other (a fast frame — the dashboard is on the same box — is done before the
# handlers are in place), so the loader stayed on the screen until a refresh.
# The loader is off now: the url change shows nothing any more, the hides
# stay (they are no-ops without a loader).
for THEME_JS in /var/www/html/themes/*/js/iframe-show-loader.js; do
    [ -f "$THEME_JS" ] || continue
    if ! grep -q "the loader of the frame is disabled" "$THEME_JS"; then
        cp -a "$THEME_JS" "$THEME_JS.bak"
        cat > "$THEME_JS" <<'LOADER_PATCH'
// Detects if frame source changes to display loader
// and hides the loader on frame onload

// (cc patch) the loader of the frame is disabled: the frame of the dashboard
// is fast (the middleware is on the same box) and the show/hide race left the
// loader on the screen until a refresh. The show is off, the hide stays.
function iframeURLChange(iframe, callback) {
    var unloadHandler = function () {
        // Timeout needed because the URL changes immediately after
        // the `unload` event is dispatched.
        setTimeout(function () {
            callback(iframe.contentWindow.location.href);
        }, 0);
    };

    function attachUnload() {
        // Remove the unloadHandler in case it was already attached.
        // Otherwise, the change will be dispatched twice.
        iframe.contentWindow.removeEventListener("unload", unloadHandler);
        iframe.contentWindow.addEventListener("unload", unloadHandler);
    }

    iframe.addEventListener("load", attachUnload);
    attachUnload();
}

if($('#myframe').length>0) {

    // (cc patch) no loader: the url change shows nothing any more.
    iframeURLChange(document.getElementById("myframe"), function (newURL) {
    });

    $('#myframe').get(0).onload = function() {
      calcHeight();
      $('#neo-contentbox').LoadingOverlay('hide');
    };

    // (cc patch) a frame that finished loading before this script ran never
    // fires the event again: hide the loader here.
    var _ccLoaderTries = 0;
    var _ccLoaderPoll = function () {
        var f = document.getElementById('myframe');
        if (!f) { return; }
        var d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (d && d.readyState === 'complete') {
            calcHeight();
            $('#neo-contentbox').LoadingOverlay('hide');
            return;
        }
        if (++_ccLoaderTries < 50) { setTimeout(_ccLoaderPoll, 100); }
    };
    _ccLoaderPoll();
}
LOADER_PATCH
        echo "== the loader of $THEME_JS is disabled"
    fi
done

#-----------------------------------------------------------------------------
# the menu
#-----------------------------------------------------------------------------
echo "== the menu"
sqlite3 "$MENU_DB" <<SQL
BEGIN;
DELETE FROM menu WHERE id IN ('cc_parent', 'cc_monitor', 'cc_agents_mgr', 'cc_pauses', 'cc_reports');
-- The order matters: Issabel removes a menu entry whose parent is not in the
-- list yet and only adds it back when a child points to it, so the category
-- has to come before its modules (like every other category of Issabel).
INSERT INTO menu (id, IdParent, Link, Name, Type, order_no) VALUES
    ('cc_parent',      '',             '', 'Call Center',   '',     13),
    ('cc_monitor',     'cc_parent',    '', 'Live Monitor',  'module', 14),
    ('cc_agents_mgr', 'cc_parent',    '', 'Manage Agents', 'module', 15),
    ('cc_pauses',     'cc_parent',    '', 'Pause Reasons', 'module', 16),
    ('cc_reports',    'cc_parent',    '', 'Reports',       'module', 17);
COMMIT;
SQL

#-----------------------------------------------------------------------------
# the permissions of the administrator
#-----------------------------------------------------------------------------
# acl_resource (id, name, description), the name is the id of the menu entry.
# acl_group_permission (id, id_action, id_group, id_resource), the action 1 is
# "access" and the group 1 is the administrator.
echo "== the permissions"
# The ids are computed first: $((x + 1)) inside the sql would eat the
# brackets of the statement.
RESOURCE_BASE=$(sqlite3 "$ACL_DB" "SELECT COALESCE(MAX(id), 0) FROM acl_resource;")
PERMISSION_BASE=$(sqlite3 "$ACL_DB" "SELECT COALESCE(MAX(id), 0) FROM acl_group_permission;")
RESOURCE_PARENT=$((RESOURCE_BASE + 1))
RESOURCE_MONITOR=$((RESOURCE_BASE + 2))
RESOURCE_AGENTS=$((RESOURCE_BASE + 3))
RESOURCE_PAUSES=$((RESOURCE_BASE + 4))
RESOURCE_REPORTS=$((RESOURCE_BASE + 5))
PERMISSION_PARENT=$((PERMISSION_BASE + 1))
PERMISSION_MONITOR=$((PERMISSION_BASE + 2))
PERMISSION_AGENTS=$((PERMISSION_BASE + 3))
PERMISSION_PAUSES=$((PERMISSION_BASE + 4))
PERMISSION_REPORTS=$((PERMISSION_BASE + 5))

sqlite3 "$ACL_DB" <<SQL
BEGIN;
DELETE FROM acl_resource WHERE name IN ('cc_parent', 'cc_monitor', 'cc_agents_mgr', 'cc_pauses', 'cc_reports');
DELETE FROM acl_group_permission WHERE id_resource IN (
    SELECT id FROM acl_resource WHERE name IN ('cc_parent', 'cc_monitor', 'cc_agents_mgr', 'cc_pauses', 'cc_reports'));
INSERT INTO acl_resource (id, name, description) VALUES
    ($RESOURCE_PARENT, 'cc_parent',      'Call Center'),
    ($RESOURCE_MONITOR, 'cc_monitor',     'Live Monitor'),
    ($RESOURCE_AGENTS, 'cc_agents_mgr', 'Manage Agents'),
    ($RESOURCE_PAUSES, 'cc_pauses',     'Pause Reasons'),
    ($RESOURCE_REPORTS, 'cc_reports',    'Reports');
INSERT INTO acl_group_permission (id, id_action, id_group, id_resource) VALUES
    ($PERMISSION_PARENT, 1, 1, $RESOURCE_PARENT),
    ($PERMISSION_MONITOR, 1, 1, $RESOURCE_MONITOR),
    ($PERMISSION_AGENTS, 1, 1, $RESOURCE_AGENTS),
    ($PERMISSION_PAUSES, 1, 1, $RESOURCE_PAUSES),
    ($PERMISSION_REPORTS, 1, 1, $RESOURCE_REPORTS);
COMMIT;
SQL

#-----------------------------------------------------------------------------
# the result
#-----------------------------------------------------------------------------
echo
echo "== the menu"
sqlite3 -header -column "$MENU_DB" \
    "SELECT id, IdParent, Name, Type, order_no FROM menu WHERE id IN ('cc_parent','cc_monitor','cc_agents_mgr','cc_pauses','cc_reports') ORDER BY IdParent, order_no;"
echo
echo "== the permissions"
sqlite3 -header -column "$ACL_DB" \
    "SELECT r.id, r.name, a.name AS action, g.name AS grp FROM acl_group_permission gp
     JOIN acl_resource r ON r.id = gp.id_resource
     JOIN acl_action a ON a.id = gp.id_action
     JOIN acl_group g ON g.id = gp.id_group
     WHERE r.name IN ('cc_parent','cc_monitor','cc_agents_mgr','cc_pauses','cc_reports');"
echo
echo "== the modules"
ls -l "$MODULES_DIR/cc_monitor/index.php" "$MODULES_DIR/cc_agents_mgr/index.php" \
      "$MODULES_DIR/cc_pauses/index.php" "$MODULES_DIR/cc_reports/index.php"
echo
echo "== done, the sidebar of Issabel has the category Call Center now"
