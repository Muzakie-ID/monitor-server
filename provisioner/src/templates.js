// Semua yang dipasang di server target memakai nama berawalan "pantau-", jadi tidak pernah
// menimpa node_exporter/Alloy yang mungkin sudah dipasang pemilik server, dan bisa
// dicopot bersih tanpa menyentuh hal lain.
export const P = {
  exporterUser: 'pantau-exporter',
  exporterBin: '/usr/local/bin/pantau-node-exporter',
  exporterDir: '/etc/pantau/node-exporter',
  exporterService: 'pantau-node-exporter',
  alloyUser: 'pantau-alloy',
  alloyBin: '/usr/local/bin/pantau-alloy',
  alloyDir: '/etc/pantau/alloy',
  alloyData: '/var/lib/pantau-alloy',
  alloyService: 'pantau-alloy',
  rootDir: '/etc/pantau',
  ufwComment: 'pantau-server'
};

const hardening = `NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=256M
CPUQuota=50%`;

export const exporterUnit = (port) => `[Unit]
Description=Pantau Server - node_exporter (TLS + basic auth)
Documentation=https://github.com/prometheus/node_exporter
After=network-online.target
Wants=network-online.target

[Service]
User=${P.exporterUser}
Group=${P.exporterUser}
ExecStart=${P.exporterBin} --web.listen-address=:${port} --web.config.file=${P.exporterDir}/web.yml
Restart=on-failure
RestartSec=5
${hardening}

[Install]
WantedBy=multi-user.target
`;

export const exporterWebConfig = (bcryptHash) => `# Dibuat oleh Pantau Server. Jangan diubah manual.
tls_server_config:
  cert_file: ${P.exporterDir}/tls.crt
  key_file: ${P.exporterDir}/tls.key
basic_auth_users:
  pantau: ${bcryptHash}
`;

export const alloyUnit = () => `[Unit]
Description=Pantau Server - agen log (Grafana Alloy)
Documentation=https://grafana.com/docs/alloy/
After=network-online.target
Wants=network-online.target

[Service]
User=${P.alloyUser}
Group=${P.alloyUser}
# systemd-journal: membaca journald; adm: membaca /var/log/auth.log
SupplementaryGroups=systemd-journal adm
ExecStart=${P.alloyBin} run ${P.alloyDir}/config.alloy --storage.path=${P.alloyData} --server.http.listen-addr=127.0.0.1:12399 --disable-reporting
Restart=on-failure
RestartSec=10
${hardening.replace('ProtectSystem=strict', `ProtectSystem=strict\nReadWritePaths=${P.alloyData}`)}

[Install]
WantedBy=multi-user.target
`;

const q = (s) => JSON.stringify(String(s));

// Hanya log level warning ke atas dari journald (hemat bandwidth), ditambah log login/sudo.
export const alloyConfig = ({ server, lokiUrl }) => `// Dibuat oleh Pantau Server. Jangan diubah manual.
loki.relabel "journal" {
  forward_to = []
  rule {
    source_labels = ["__journal_priority"]
    regex         = "[0-4]"
    action        = "keep"
  }
  rule {
    source_labels = ["__journal__systemd_unit"]
    target_label  = "unit"
  }
  rule {
    source_labels = ["__journal_priority_keyword"]
    target_label  = "level"
  }
}

loki.source.journal "system" {
  forward_to    = [loki.write.pantau.receiver]
  relabel_rules = loki.relabel.journal.rules
  max_age       = "12h"
  labels        = { server = ${q(server)}, source = "journal" }
}

local.file_match "auth" {
  path_targets = [{ "__path__" = "/var/log/auth.log", server = ${q(server)}, source = "auth" }]
}

loki.source.file "auth" {
  targets    = local.file_match.auth.targets
  forward_to = [loki.write.pantau.receiver]
}

loki.write "pantau" {
  endpoint {
    url = ${q(lokiUrl)}
    basic_auth {
      username      = "pantau"
      password_file = "${P.alloyDir}/password"
    }
    tls_config {
      ca_file = "${P.alloyDir}/ca.crt"
    }
  }
}
`;
