-- Third API token level: "operational" tokens may call the routes that act on live equipment
-- (switch ports, DNS records, scans, ProPresenter). Every existing token gets false.
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "allow_operational" boolean DEFAULT false NOT NULL;
