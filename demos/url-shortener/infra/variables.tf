locals {
  cloudflare_api_token   = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id  = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  cloudflare_zone_id     = data.dotenv.config.env["CLOUDFLARE_ZONE_ID"]
  demo_domain            = data.dotenv.config.env["DEMO_DOMAIN"]
  demo_name              = data.dotenv.config.env["DEMO_NAME"]
  admin_email            = data.dotenv.config.env["ADMIN_EMAIL"]
  cloudflare_team_domain = data.dotenv.config.env["CLOUDFLARE_TEAM_DOMAIN"]
}
