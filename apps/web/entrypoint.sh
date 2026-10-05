#!/bin/sh
# The key Next.js uses at run time to encrypt the values a Server Action closes over.
# Derived from AUTH_SECRET, which every node of a cluster already has to share, so all
# nodes get the same key without another secret to configure, and it is not something
# a reader of the source could compute. Set NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
# (base64, 16, 24 or 32 bytes) yourself to rotate it independently of AUTH_SECRET.
# Changing it only invalidates forms that are open in a browser at that moment.
if [ -z "$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" ]; then
  if [ -z "$AUTH_SECRET" ]; then
    echo "entrypoint: AUTH_SECRET is not set" >&2
    exit 1
  fi
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.AUTH_SECRET + ":church-dashboard/server-actions/runtime-key/v1").digest("base64"))')"
  export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
fi
exec "$@"
