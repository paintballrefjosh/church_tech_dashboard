-- Per switch: should port-channels (logical interfaces, Po*) count in the port-state check and its alerts? Off for every
-- existing switch: a bundle is down because its members are, and the members are counted. Additive.
ALTER TABLE "cisco_switches" ADD COLUMN IF NOT EXISTS "check_port_channels" boolean DEFAULT false NOT NULL;
