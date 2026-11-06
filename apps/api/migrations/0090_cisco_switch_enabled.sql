-- A Cisco switch can have monitoring switched off: it is not polled, raises no alerts and is left alone (no SSH logins).
ALTER TABLE "cisco_switches" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
