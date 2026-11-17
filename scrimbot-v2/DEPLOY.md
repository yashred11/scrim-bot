# Deploying

The tests run the bot against a fake Discord server. They do not prove your real server's permissions are right, so steps 1 to 3 matter.

## 1. Developer Portal

Open the application, then Bot.

- Privileged Gateway Intents: leave **Server Members Intent ON**. The bot does not subscribe to it, but Discord only allows the member list endpoint (used by `/rolesync` and the startup sync) when it is enabled.
- **Message Content Intent** is no longer needed and can be turned off.
- Keep using the existing token. The old bot and the new bot are the same application, so the existing role message stays editable and its reactions stay in place.

## 2. Invite with the right scopes

Slash commands need the `applications.commands` scope, which an old invite may not have. Open this link (replace `APP_ID`) and add the bot to the server again. It does not create a second bot.

```
https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=268520512
```

The permissions number is Manage Roles, View Channel, Send Messages, Embed Links, Read Message History and Add Reactions.

## 3. Server settings

- Server Settings, Roles: drag the bot's role **above** EEU, WEU, NA, SA, SEA, LFT and MENA. This is the most common reason roles are not assigned.
- In the role channel the bot needs View Channel, Send Messages, Embed Links, Add Reactions and Read Message History.

The bot checks both on every start and posts any problem to `NOTIFY_CHANNEL`.

## 4. Try it in a test server first

```
cp .env.example .env     # fill in token, IDs and mapping for a test server
npm ci && npm run build && npm start
```

Run `/rolepoll`, react, confirm the role arrives, remove the reaction, confirm it goes. Run `/rolestatus`.

## 5. Production (Kubernetes, same pipeline as before)

`k8s/1-configmap.yaml` already holds your real IDs and mapping. `k8s/2-secrets.enc.yaml` is the existing encrypted secret, unchanged.

```
git tag v1.0.0 && git push origin v1.0.0
```

The pipeline runs the tests, builds the image, and applies `k8s/`. The deployment uses `Recreate`, so the old pod stops before the new one starts. Manual alternative: build and push the image, replace `REPLACE_VERSION_IN_CI` in `k8s/3-deployment.yaml`, then `kubectl apply -f k8s/`.

Verify:

```
kubectl -n scrim-discord-bot rollout status deployment/discord-bot-deployment
kubectl -n scrim-discord-bot logs deployment/discord-bot-deployment
```

Expected lines: `Logged in`, `Setup check passed`, `Watching role message`, `Slash commands registered`, and about 10 seconds later `Startup sync done`.

Then in Discord:

1. `/rolestatus` should show no setup problems.
2. `/rolesync` (preview). Read the counts. People who reacted while the old bot was down will show as `+N`.
3. `/rolesync apply:true` if the numbers look right. The startup sync does the add-only part automatically, so `+N` is usually 0 afterwards.

The startup sync gives the role to everyone who has the reaction and lacks the role. If a moderator removed someone's role on purpose while leaving their reaction, set `SYNC_ON_START: "off"` and use `/rolesync` manually.

## Without Kubernetes

```
docker build -t scrimbot .
docker run -d --name scrimbot --restart unless-stopped --env-file .env -p 8080:8080 scrimbot
```

## Rollback

```
kubectl -n scrim-discord-bot rollout undo deployment/discord-bot-deployment
```

Or tag the previous commit again. Roles already assigned stay as they are.

## Troubleshooting

| Log or symptom | Cause and fix |
| --- | --- |
| `Invalid configuration:` and exit code 2 | A variable is missing or malformed. The message lists each one. |
| `Login failed` | Wrong token. |
| `Setup check` error: role not below the bot's highest role | Move the bot role above the regional roles (step 3). |
| `Cannot add role ... Missing Permissions` in `NOTIFY_CHANNEL` | Same fix, or the bot lacks Manage Roles. |
| `No role message found` | `ROLE_REACTION_MESSAGE_ID` is wrong or the message was deleted. Run `/rolepoll`, then put the new ID in the ConfigMap. |
| Slash commands missing | Re-invite with the link in step 2. Reactions keep working without them. |
| `Startup sync failed` with a 403 | Server Members Intent is off in the Developer Portal (step 1). |
| Pod restarts | `kubectl describe pod` shows the reason. `OOMKilled` means raise the memory limit. A liveness failure means the gateway connection was down for about 90 seconds. |

If the old role message was posted by a different application, `/rolepoll` cannot edit it (reactions on it still work). Use `/rolepoll new:true` and update `ROLE_REACTION_MESSAGE_ID`.
