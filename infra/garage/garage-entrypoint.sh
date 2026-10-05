#!/bin/sh
# Starts Garage, after refusing to put its metadata database on a network filesystem.
# Garage keeps its metadata in LMDB, which relies on file locking and memory mapping that
# NFS and SMB do not provide reliably; the failure mode is silent corruption, found later.
set -eu
meta=/var/lib/garage/meta
fs="$(stat -f -c %T "$meta" 2>/dev/null || echo unknown)"
case "$fs" in
  nfs|nfs4|cifs|smb|smb2|smb3|9p|fuse.sshfs|fuseblk.sshfs)
    if [ "${GARAGE_ALLOW_NETWORK_META:-}" != "1" ]; then
      echo "garage: the metadata directory ($meta) is on a network filesystem ($fs)." >&2
      echo "garage: its LMDB database can be corrupted there. Set GARAGE_META_DIR in .env to a" >&2
      echo "garage: folder on local disk (e.g. /var/lib/church-garage-meta) and start again." >&2
      echo "garage: (GARAGE_ALLOW_NETWORK_META=1 overrides this; do not, unless you know why.)" >&2
      exit 1
    fi
    ;;
esac
. /usr/local/bin/garage-render.sh
exec "$@"
