#!/bin/sh
# Renders prometheus.yml from env so METRICS_TOKEN lands inside the scrape
# config without baking secrets into the repo. Prometheus reads the config
# with the static token query param (the /metrics route accepts ?token=).
cat > /etc/prometheus/prometheus.yml <<EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: crypto-screener
    metrics_path: /metrics
    params:
      token: [${METRICS_TOKEN}]
    static_configs:
      - targets: [server:3001]
EOF

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=14d