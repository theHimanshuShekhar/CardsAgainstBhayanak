#!/bin/sh
set -e

echo "Applying database schema..."
# --force auto-approves the push so the container starts non-interactively.
# This is the MVP tradeoff documented in CLAUDE.md (no migration files).
pnpm exec drizzle-kit push --force

echo "Starting server..."
exec pnpm start
