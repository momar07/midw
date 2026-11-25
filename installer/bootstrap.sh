#!/bin/bash
# The full setup of the middleware on a fresh Issabel box. It runs on the
# Issabel box itself, as root. The middleware folder is delivered next to it:
#
#   tar czf middleware.tgz -C /home/momar/apps middleware --exclude=.env
#   scp middleware.tgz root@<new-issabel>:/tmp/
#   ssh root@<new-issabel>
#   cd /tmp && tar xzf middleware.tgz
#   bash /tmp/middleware/installer/bootstrap.sh
#
# What it does (all of it idempotent, a second run changes nothing):
#   1. node (portable under /opt/node)
#   2. the middleware in /opt/middleware
#   3. the database: the user, the cc_* tables and the first pause reasons
#   4. the ami user of the middleware in the asterisk manager
#   5. the .env of the middleware (new secrets unless they are given)
#   6. the systemd service cc-middleware
#   7. the proxy /cc/ of apache
#   8. the sidebar of Issabel (menus, acl, modules, the loader patch)
#
# Options:  --sip-ip <ip>        the sip server the agents register to
#                               (default: the first ip of this box)
#           --db-pass <pass>    the password of the cc_middleware db user
#           --ami-secret <s>    the secret of the ami user cc_middleware
#           --db-root-pass <p>  the mysql root password
#                               (default: the one of /etc/issabel.conf)

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MIDDLEWARE_DIR=$(dirname "$HERE")
ENV_FILE=/opt/middleware/.env

SIP_IP=
DB_PASS=
AMI_SECRET=
DB_ROOT_PASS=$(grep '^mysqlrootpwd=' /etc/issabel.conf 2>/dev/null | cut -d= -f2- || true)
while [ $# -gt 0 ]; do
    case "$1" in
        --sip-ip)        SIP_IP=$2; shift 2;;
        --db-pass)       DB_PASS=$2; shift 2;;
        --ami-secret)    AMI_SECRET=$2; shift 2;;
        --db-root-pass)  DB_ROOT_PASS=$2; shift 2;;
        *) echo "unknown option: $1" >&2; exit 1;;
    esac
done
if [ -z "$SIP_IP" ]; then
    SIP_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$DB_ROOT_PASS" ]; then
    echo "FATAL: no mysql root password (use --db-root-pass)" >&2
    exit 1
fi
MYSQL="mysql -uroot -p$DB_ROOT_PASS"

command -v openssl >/dev/null || { echo "FATAL: openssl is missing" >&2; exit 1; }
[ -z "$DB_PASS" ] && DB_PASS=$(openssl rand -hex 16)
[ -z "$AMI_SECRET" ] && AMI_SECRET=$(openssl rand -hex 16)
TOKEN_SECRET=$(openssl rand -hex 24)
ADMIN_TOKEN=$(openssl rand -hex 24)

if ! id asterisk >/dev/null 2>&1; then
    echo "FATAL: this does not look like an issabel box (no asterisk user)" >&2
    exit 1
fi

#-----------------------------------------------------------------------------
# 1. node
#-----------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo "== node"
    NODE_VERSION=v22.22.0
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
    mkdir -p /opt/node
    tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
    ln -sf /opt/node/bin/node /usr/local/bin/node
    ln -sf /opt/node/bin/npm  /usr/local/bin/npm
fi
echo "== node $(node --version)"

#-----------------------------------------------------------------------------
# 2. the middleware
#-----------------------------------------------------------------------------
echo "== the middleware in /opt/middleware"
mkdir -p /opt/middleware
cp -a "$MIDDLEWARE_DIR/." /opt/middleware/
rm -f /opt/middleware/.env
if [ ! -d /opt/middleware/node_modules ] || [ ! -x /opt/middleware/node_modules/.bin ]; then
    (cd /opt/middleware && npm install --omit=dev)
fi

#-----------------------------------------------------------------------------
# 3. the database
#-----------------------------------------------------------------------------
echo "== the database"
$MYSQL <<'SQL'
CREATE DATABASE IF NOT EXISTS asterisk;
SQL
$MYSQL asterisk <<'SQL'
CREATE TABLE IF NOT EXISTS cc_agents (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `password` varchar(255) NOT NULL,
  `sip_extension` varchar(20) NOT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS cc_agent_queues (
  `agent_id` int(11) NOT NULL,
  `queue_number` varchar(20) NOT NULL,
  PRIMARY KEY (`agent_id`,`queue_number`),
  CONSTRAINT `cc_agent_queues_ibfk_1` FOREIGN KEY (`agent_id`) REFERENCES `cc_agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS cc_pause_reasons (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `reason_code` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `reason_code` (`reason_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS cc_agent_logs (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `agent_id` int(11) NOT NULL,
  `event_type` enum('login','logout','pause','unpause') NOT NULL,
  `pause_reason_id` int(11) DEFAULT NULL,
  `event_time` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `agent_id` (`agent_id`),
  KEY `pause_reason_id` (`pause_reason_id`),
  KEY `event_time` (`event_time`),
  CONSTRAINT `cc_agent_logs_ibfk_1` FOREIGN KEY (`agent_id`) REFERENCES `cc_agents` (`id`) ON DELETE CASCADE,
  CONSTRAINT `cc_agent_logs_ibfk_2` FOREIGN KEY (`pause_reason_id`) REFERENCES `cc_pause_reasons` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT IGNORE INTO cc_pause_reasons (reason_code, description, is_active) VALUES
    ('Break',      'استراحة قصيرة', 1),
    ('Pray',       'صلاة',          1),
    ('AdminBreak', 'إيقاف إداري',   1);
SQL
$MYSQL -e "
CREATE USER IF NOT EXISTS 'cc_middleware'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.cc_agents TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.cc_agent_queues TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.cc_pause_reasons TO 'cc_middleware'@'localhost';
GRANT SELECT, INSERT ON asterisk.cc_agent_logs TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.sip TO 'cc_middleware'@'localhost';
GRANT SELECT ON asterisk.queues_config TO 'cc_middleware'@'localhost';
FLUSH PRIVILEGES;"

#-----------------------------------------------------------------------------
# 4. the ami user
#-----------------------------------------------------------------------------
echo "== the ami user"
if ! grep -q '^\[cc_middleware\]' /etc/asterisk/manager_custom.conf 2>/dev/null; then
    cat >> /etc/asterisk/manager_custom.conf <<EOF

; the call center middleware of the MicroSIP agent
[cc_middleware]
secret = $AMI_SECRET
permit = 127.0.0.1/255.255.255.255
read = agent
write = agent
EOF
    asterisk -rx "manager reload" >/dev/null 2>&1 || true
fi

#-----------------------------------------------------------------------------
# 5. the .env
#-----------------------------------------------------------------------------
echo "== the .env"
cat > "$ENV_FILE" <<EOF
PORT=8080
DB_HOST=127.0.0.1
DB_USER=cc_middleware
DB_PASS=$DB_PASS
DB_NAME=asterisk
SIP_SERVER_IP=$SIP_IP
SIP_SERVER_PORT=5060
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=cc_middleware
AMI_SECRET=$AMI_SECRET
TOKEN_SECRET=$TOKEN_SECRET
ADMIN_TOKEN=$ADMIN_TOKEN
TOKEN_TTL=43200
EOF
chown asterisk:asterisk "$ENV_FILE"
chmod 640 "$ENV_FILE"
# the ami user may already be there (a second run), the secret of the .env has
# to be the one of the manager then
if grep -q '^\[cc_middleware\]' /etc/asterisk/manager_custom.conf 2>/dev/null; then
    MANAGER_SECRET=$(awk '/^\[cc_middleware\]/{f=1;next} f && /^secret/{print $3; exit}' /etc/asterisk/manager_custom.conf | tr -d ' ')
    if [ -n "$MANAGER_SECRET" ] && [ "$MANAGER_SECRET" != "$AMI_SECRET" ]; then
        sed -i "s/^AMI_SECRET=.*/AMI_SECRET=$MANAGER_SECRET/" "$ENV_FILE"
    fi
fi

#-----------------------------------------------------------------------------
# 6. the service
#-----------------------------------------------------------------------------
echo "== the service"
cat > /etc/systemd/system/cc-middleware.service <<'EOF'
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
EOF
systemctl daemon-reload
systemctl enable --now cc-middleware
sleep 2
systemctl is-active cc-middleware >/dev/null

#-----------------------------------------------------------------------------
# 7. the proxy of apache
#-----------------------------------------------------------------------------
echo "== the proxy /cc/"
if [ ! -f /etc/httpd/conf.d/cc-dashboard.conf ]; then
    cat > /etc/httpd/conf.d/cc-dashboard.conf <<'EOF'
# The supervisor dashboard of the call center. It is served by the middleware
# (node on port 8080) and proxied here, so the dashboard is on the same origin
# as Issabel: a https page can not show a http iframe (mixed content).
ProxyPass /cc/ws ws://127.0.0.1:8080/ws
ProxyPass /cc/ http://127.0.0.1:8080/
ProxyPassReverse /cc/ http://127.0.0.1:8080/
EOF
fi
systemctl reload httpd 2>/dev/null || apachectl graceful || true

#-----------------------------------------------------------------------------
# 8. the sidebar of issabel
#-----------------------------------------------------------------------------
bash "$HERE/issabel-cc-dashboard.sh"

#-----------------------------------------------------------------------------
# the result
#-----------------------------------------------------------------------------
echo
echo "== done. the dashboard is in the sidebar (Call Center), the login of"
echo "== the agents is the one of MicroSIP:"
echo "     api url   : http://<this box>:8080"
echo "     dashboard : https://<this box>/cc/"
echo "     admin token (the supervisor pages): $(grep '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
