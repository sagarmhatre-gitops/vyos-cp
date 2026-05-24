#!/bin/bash
# vyos-cp backup — captures source tree + database into a single tarball.
# Restore by: tar xzf <backup> -C /opt && cd /opt/vyos-cp && bash restore.sh
set -euo pipefail

cd /opt/vyos-cp
TS=$(date +%Y%m%d-%H%M%S)
OUT=/opt/vyos-cp-backups
mkdir -p "$OUT"

echo "[1/3] Dumping database..."
docker compose exec -T db pg_dump -U vyoscp -d vyoscp \
  --clean --if-exists --no-owner \
  > "$OUT/db-$TS.sql"

echo "[2/3] Tarring source tree + .env + db dump..."
# Exclude node_modules and the docker volume directories.
tar czf "$OUT/vyos-cp-$TS.tar.gz" \
  --exclude='./frontend/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./.git' \
  -C /opt/vyos-cp . \
  -C "$OUT" "db-$TS.sql"

# Don't keep the loose .sql once it's in the tarball.
rm "$OUT/db-$TS.sql"

echo "[3/3] Done."
ls -lh "$OUT/vyos-cp-$TS.tar.gz"
echo
echo "To restore later:"
echo "  cd /opt && sudo tar xzf $OUT/vyos-cp-$TS.tar.gz -C vyos-cp/"
echo "  cd /opt/vyos-cp"
echo "  sudo docker compose exec -T db psql -U vyoscp -d vyoscp < db-*.sql"
