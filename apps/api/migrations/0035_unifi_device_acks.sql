-- Operator acknowledgements of offline UniFi devices, keyed by MAC. An ack
-- suppresses a currently-offline device from the Network (UniFi) tab problem
-- badge and is auto-cleared when the device is next seen online, so a later
-- re-offline is a fresh episode that counts again. Inline REFERENCES (no DO
-- block) for CockroachDB v24.2 compatibility.
CREATE TABLE IF NOT EXISTS "unifi_device_acks" (
  "mac" text PRIMARY KEY,
  "device_name" text NOT NULL DEFAULT '',
  "acked_at" timestamp NOT NULL DEFAULT now(),
  "acked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
