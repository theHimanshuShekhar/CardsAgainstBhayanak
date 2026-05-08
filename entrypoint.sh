#!/bin/sh
set -e
echo "Applying database schema..."
pnpm db:push
echo "Seeding cards..."
pnpm seed
echo "Starting server..."
exec node server.mjs
