# SocialPublicator agent integration

WBot can run independently or connect to SocialPublicator. When account IDs are configured, WBot validates its token and account assignments before starting browser/session services.

## Required environment

```dotenv
LARAVEL_API_URL=https://social-publicator.example
LARAVEL_API_TOKEN=<one-time token issued for this BotAgent>
BOT_NAME=WBot
BOT_INSTANCE_ID=wbot-wa-01
SOCIAL_ACCOUNT_ID=123
FACEBOOK_SOCIAL_ACCOUNT_ID=456
```

Use a different BotAgent token, `BOT_INSTANCE_ID`, WhatsApp session name, lock file, token directory, and browser profile directory for every additional WBot instance. Do not share a profile directory between concurrent processes.

- `SOCIAL_ACCOUNT_ID` is a WhatsApp account in the selected SocialPublicator workspace.
- `FACEBOOK_SOCIAL_ACCOUNT_ID` is a Facebook profile account used by the persistent browser session. Official Facebook Page publishing is authorized separately through Meta OAuth in SocialPublicator.
- The configured BotAgent must be granted both account IDs that this process will use.
- Do not put session cookies, QR values, OAuth tokens, or browser profile contents in source control.

## Startup preflight

Before WPPConnect or Puppeteer is started, WBot calls:

`GET /api/bot/agent/health?instance_id={BOT_INSTANCE_ID}`

The API returns only account metadata and non-secret connection state for the authenticated agent's workspace and grants. WBot stops before opening a session if the token, instance identity, account platform/type, account grants, or existing session ownership do not match.

A pending account without a session record is allowed, so the first QR pairing can proceed. If neither SocialPublicator account ID is configured, the preflight is skipped and WBot remains in standalone mode.

## Existing sessions

The preflight does not touch local session files. The default values remain:

- WhatsApp session: `whatsapp-bot`
- WhatsApp session directory: `whatsapp_session`
- WhatsApp token directory: `whatsapp_session/tokens`
- Facebook legacy directory: `facebook_session`

For the existing installation, keep these values and back up the full WBot data directory before changing deployment paths. Never start two instances against the same browser profile, WhatsApp token directory, or lock file.

## Troubleshooting

- **401:** verify the agent token and that it has not been revoked.
- **403 identity mismatch:** `BOT_INSTANCE_ID` must exactly match the instance used when issuing the token.
- **Account not authorized:** grant the account to this BotAgent in SocialPublicator, then restart WBot.
- **Wrong platform/type:** check that the WhatsApp variable references a WhatsApp account and the Facebook variable references a Facebook profile.
- **Session owned by another instance:** stop the other instance and deliberately reassign the connection in the administrative workflow; do not copy or delete its session directory to bypass the check.

The health endpoint never returns credentials, cookies, QR payloads, session references, or filesystem paths.
