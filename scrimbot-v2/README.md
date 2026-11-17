# ScrimBot

Gives members a regional role when they react to the "Regional Role Assignment" message, and takes it away when they remove the reaction. The roles unlock the regional channels.

## How it works

- Reactions are read from raw gateway events, so they work on any message whether or not the bot has seen it before. A reaction costs one API call (the role change).
- Custom emoji are matched by ID. Renaming an emoji in the server does not break anything.
- Role changes for one person are applied in the order the reactions happened.
- On startup the bot checks its permissions and role order, finds the role message, and gives roles to anyone who reacted while it was offline.
- A failed call is logged and, if `NOTIFY_CHANNEL` is set, reported there. It never stops the bot.
- Only the `Guilds` and `GuildMessageReactions` gateway intents are used. No message content or member data is received.

## Slash commands

Usable by Administrators and by roles listed in `ROLE_PERMISSION_ALLOWED_ROLES` (names or IDs). Replies are visible only to the person who ran the command.

| Command | What it does |
| --- | --- |
| `/rolepoll` | Edits the role message to match `ROLE_MAPPING` and adds missing reactions. `new:true` posts a fresh message. |
| `/rolesync` | Preview of reaction vs role differences. `apply:true` gives roles to people who reacted but lack the role. It never removes roles. |
| `/roleaccess` | Lists, per mapped role, the channels that role unlocks beyond what everyone can see. Sent as a text file. |
| `/rolestatus` | Gateway state, watched message, counters, and the result of the setup check. |


## Configuration

See `.env.example`. `DISCORD_CLIENT_SECRET` is accepted as an alias for `DISCORD_TOKEN`, so the existing Kubernetes secret works unchanged.

## Development

```
npm ci
npm run typecheck
npm test          # unit tests
npm run build
npm run e2e       # runs the real bot against a fake Discord gateway and REST server
E2E_ENTRY=dist/index.js npm run e2e   # same, against the compiled build
```

Deployment steps are in [DEPLOY.md](DEPLOY.md).
