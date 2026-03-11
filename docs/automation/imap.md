---
title: IMAP Email Watcher
summary: "Watch email via IMAP IDLE for real-time notifications"
read_when:
  - You want to trigger actions when new emails arrive
  - You use 163, QQ, Yahoo, iCloud, Outlook, or other IMAP-compatible email
  - You want an alternative to Gmail Pub/Sub
---

# IMAP Email Watcher

Watch any IMAP-compatible mailbox for new emails using IMAP IDLE (real-time push notifications).

## Overview

The IMAP watcher maintains a persistent connection to your email server and receives instant notifications when new emails arrive. This works with most email providers including:

- **Chinese providers**: 163, 126, QQ, Foxmail
- **International providers**: Gmail, Outlook, Yahoo, iCloud, ProtonMail (via Bridge)
- **Enterprise**: Any IMAP-compatible server

## Quick Start

```bash
# Interactive setup (recommended)
clawdbot webhooks imap setup
```

The setup wizard will:
1. Detect your email provider settings automatically
2. Guide you through getting an app password (if needed)
3. Test the connection
4. Save your configuration

## Setup Options

### Interactive Setup

```bash
clawdbot webhooks imap setup
```

### With Options

```bash
clawdbot webhooks imap setup \
  --email user@163.com \
  --password "your-app-password"
```

### Manual Server Configuration

For enterprise or custom IMAP servers:

```bash
clawdbot webhooks imap setup \
  --email user@company.com \
  --host imap.company.com \
  --port 993 \
  --secure \
  --password "password"
```

## Commands

| Command | Description |
|---------|-------------|
| `clawdbot webhooks imap setup` | Add an IMAP account |
| `clawdbot webhooks imap status` | List configured accounts |
| `clawdbot webhooks imap remove <email>` | Remove an account |
| `clawdbot webhooks imap run` | Manually run watchers |

## Supported Providers

### Chinese Email Providers

| Provider | Auth Type | Notes |
|----------|-----------|-------|
| 163.com | App Password | Enable IMAP in settings, generate authorization code |
| 126.com | App Password | Same as 163 |
| qq.com | App Password | Enable IMAP, generate authorization code |
| foxmail.com | App Password | Uses QQ Mail servers |

### International Providers

| Provider | Auth Type | Notes |
|----------|-----------|-------|
| Gmail | App Password | Enable 2FA, generate app password |
| Outlook/Hotmail | Password | Regular password works |
| Yahoo | App Password | Generate app password in security settings |
| iCloud | App Password | Generate app-specific password |
| ProtonMail | Password | Requires ProtonMail Bridge |

## App Password Setup

Most providers require an "app password" or "authorization code" instead of your regular password:

### 163/126 Mail
1. Log in to mail.163.com (or mail.126.com)
2. Go to Settings -> POP3/SMTP/IMAP
3. Enable IMAP service
4. Generate an authorization code

### QQ Mail
1. Log in to mail.qq.com
2. Go to Settings -> Account -> POP3/IMAP/SMTP
3. Enable IMAP
4. Generate an authorization code

### Gmail
1. Enable 2-Factor Authentication on your Google account
2. Go to Google Account -> Security -> App passwords
3. Generate a new app password

### iCloud
1. Go to appleid.apple.com
2. Sign-In and Security -> App-Specific Passwords
3. Generate a new password

## Configuration

The IMAP watcher configuration is stored in `~/.clawdbot/config.yaml`:

```yaml
hooks:
  enabled: true
  imap:
    # Default model for all IMAP accounts
    model: anthropic/claude-3-haiku
    accounts:
      - email: user@163.com
        host: imap.163.com
        port: 993
        secure: true
        mailbox: INBOX
```

Credentials are stored securely in `~/.clawdbot/credentials/imap/`.

## Gateway Integration

When the gateway starts, it automatically starts IMAP watchers for all configured accounts. You can disable this with:

```bash
CLAWDBOT_SKIP_IMAP_WATCHER=1 clawdbot gateway run
```

## How It Works

1. **IMAP IDLE**: The watcher maintains a persistent connection using IMAP IDLE, which allows the server to push notifications when new emails arrive.

2. **Auto-reconnect**: If the connection drops, the watcher automatically reconnects with exponential backoff.

3. **IDLE Refresh**: IMAP IDLE has a ~29 minute timeout on most servers. The watcher automatically refreshes the IDLE state every 25 minutes.

## Comparison with Gmail Pub/Sub

| Feature | IMAP Watcher | Gmail Pub/Sub |
|---------|--------------|---------------|
| Requires public URL | No | Yes |
| External dependencies | None | GCP (gcloud) |
| Provider support | All IMAP | Gmail only |
| Setup complexity | Simple | Complex |
| Real-time | Yes (IDLE) | Yes (Push) |

## Troubleshooting

### Connection Refused
- Verify IMAP is enabled for your account
- Check firewall settings
- Try port 143 with STARTTLS if 993 fails

### Authentication Failed
- Use app password, not regular password
- Regenerate the app password
- Check if IMAP access is enabled

### Connection Drops Frequently
- Some networks block long-lived connections
- The watcher will auto-reconnect
- Consider using Gmail Pub/Sub for more reliable delivery

## Related

- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)
- [CLI Reference](/cli/webhooks)
