# Garage (S3-compatible object store) for the bundled `S3_MODE=bundled` setup. This is a
# TEMPLATE: garage-render.sh fills the @...@ values from the environment into /tmp/garage.toml.
# Single node: replication factor 1, reached as garage:3901. In a cluster each node advertises
# its own address and the replication factor is 2 or 3 (see scripts/compose.sh).
# No secrets here: the RPC secret and admin token come from GARAGE_RPC_SECRET and
# GARAGE_ADMIN_TOKEN, which scripts/compose.sh derives from AUTH_SECRET.

metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
# LMDB must not live on a network filesystem (NFS, SMB). The entrypoint refuses to start
# if the metadata directory is on one; point GARAGE_META_DIR at local disk.
db_engine = "lmdb"
# Fixed when the cluster is created: it cannot be changed afterwards without rebuilding it.
replication_factor = @REPLICATION_FACTOR@

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "@RPC_PUBLIC_ADDR@"

[s3_api]
# The region name the app signs requests with (compose sets S3_REGION to match).
s3_region = "garage"
api_bind_addr = "[::]:3900"

[admin]
api_bind_addr = "[::]:3903"
