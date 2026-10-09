#!/usr/bin/env bash
set -e
export SCRIPT_PATH=/docker-entrypoint-initdb.d/
export PGPASSWORD=postgres
psql -f "$SCRIPT_PATH/scripts/db-v4.sql"
