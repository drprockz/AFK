# AFK

Claude Code interrupts you. Every permission prompt is a context switch that breaks flow. When you
step away, Claude stalls entirely. When it does proceed, you have no record of what it decided or why.

AFK is the intelligent permission layer that fixes this. It learns how you work, decides confidently
on your behalf, defers what's dangerous, and never lets Claude stall because you're not watching.

**Core principle: Claude should never interrupt you when you're away, and should never do something
irreversible without your knowledge.**

Every feature in this project flows from that sentence.

---

A Claude Code plugin that learns your permission patterns, handles requests while you're away, and
defers dangerous actions for your review.

---

## Install

```
/plugin marketplace add drprockz/afk-marketplace
/plugin install afk@drprockz
```

No configuration required. AFK starts learning from your first decision.

---

## Features

- 7-step decision chain: sensitive path guard, injection detection, destructive classifier, static
  rules, anomaly detection, behavior prediction, and AFK fallback
- AFK mode: auto-approves safe actions based on your history, defers dangerous ones, sensitive
  paths always interrupt regardless of mode
- Git auto-commit safety net creates a checkpoint commit before any destructive action is approved
  or deferred
- Deferral queue holds destructive actions while you're away so you can review them on return
- Anomaly detection flags requests that are statistically unusual for the current project
- Push notifications via ntfy.sh or Telegram with inline approve/deny actions
- Web dashboard at localhost:6789 with decision history, pattern heatmap, rules editor, and
  deferred queue management
- Session tracking with token estimation and per-session statistics
- Five slash commands: `/afk`, `/afk:review`, `/afk:stats`, `/afk:rules`, `/afk:reset`
- Zero configuration required — works out of the box and improves as it learns your patterns

---

## How it works

Every time Claude Code would show a permission prompt, it calls AFK first. AFK runs the request
through a decision chain and returns `allow`, `deny`, or `ask`. The chain completes in under 200ms.

```
PermissionRequest
     |
     v
[1. Sensitive path?] --yes--> Always interrupt user (phone notification in AFK mode)
     | no
     v
[2. Injection detected?] --yes--> Deny immediately, log reason
     | no
     v
[3. Destructive action?] --yes--> AFK on: snapshot + defer to queue
     | no                         AFK off: interrupt user immediately
     v
[4. Static rule match?] --yes--> Apply rule (allow or deny), log rule_id
     | no
     v
[5. Anomaly flagged?] --yes--> AFK on: notify + defer
     | no                       AFK off: interrupt with anomaly explanation
     v
[6. Behavior prediction]
     | confidence > 0.85  --> auto-decide (allow or deny)
     | confidence 0.15-0.85 -> escalate to next step
     | confidence < 0.15  --> auto-deny
     v
[7. AFK fallback]
     | AFK on  --> send phone notification, wait for response, then auto-approve
     | AFK off --> return ask (Claude Code prompts user normally)
     v
    done
```

Decisions are stored in a local SQLite database at `~/.claude/afk/afk.db`. The predictor queries
this history to build confidence scores from your past approve/deny patterns. After three decisions
for a given pattern, AFK starts predicting automatically.

---

## AFK mode

AFK mode is the core of the plugin. Enable it when you step away and do not want Claude to stall.

```
/afk on          enable AFK mode indefinitely
/afk off         disable AFK mode, show digest of what happened
/afk status      show current state and pending queue count
/afk 30m         enable AFK mode for 30 minutes, then auto-return
```

**While AFK mode is on:**

- Safe actions that match your history with high confidence are auto-approved and logged
- Destructive actions (rm, DROP TABLE, git reset --hard, overwriting existing files) are deferred
  to a queue — Claude skips them and continues with the rest of the session
- Sensitive paths (.env, *.key, *.pem, SSH keys, credentials) always interrupt regardless of
  AFK mode — a phone notification is sent immediately
- Anomalous requests are flagged and deferred

**When you return:**

Run `/afk off` to see a digest of everything that happened:

```
AFK session digest - 47 minutes AFK

Auto-approved (23 actions):
  Read x12  --  src/components/ files
  Bash x8   --  npm run build, npm test
  Write x3  --  new files in src/utils/

Deferred for your review (3 actions):
  rm -rf dist/              [review required]
  Write to .env.local       [sensitive path]
  DROP TABLE sessions       [critical - database]

Anomalies flagged (1):
  curl https://external-api.com/data  --  unusual for this project

Auto-denied (1):
  eval $(cat suspicious.sh)  --  injection pattern detected
```

Run `/afk:review` to open the dashboard and process deferred actions.

---

## Configuration

Config file: `~/.claude/afk/config.json`

AFK creates this file on first run with sensible defaults. Edit it to customize behavior.

| Key | Default | Description |
|-----|---------|-------------|
| `thresholds.autoApprove` | `0.85` | Confidence required to auto-approve without asking |
| `thresholds.autoDeny` | `0.15` | Confidence below which the request is auto-denied |
| `thresholds.anomalyFlag` | `0.7` | Anomaly score above which a request is flagged |
| `safety.snapshotBeforeDestructive` | `true` | Create a git checkpoint before destructive actions |
| `safety.alwaysInterruptSensitive` | `true` | Never auto-approve sensitive paths in any mode |
| `safety.failClosed` | `true` | If AFK itself errors, fall back to asking the user |
| `notifications.provider` | `null` | `"ntfy"` or `"telegram"` for push notifications |
| `notifications.timeout` | `120` | Seconds to wait for a phone response before continuing |
| `dashboard.port` | `6789` | Port for the local web dashboard |
| `afk.autoAfkMinutes` | `15` | Minutes of inactivity before auto-enabling AFK mode |

### Push notifications

To receive approve/deny prompts on your phone while AFK:

**ntfy.sh** (recommended, free):
```json
{
  "notifications": {
    "provider": "ntfy",
    "ntfyServer": "https://ntfy.sh",
    "ntfyTopic": "your-unique-topic-here",
    "onlyFor": ["high", "critical"]
  }
}
```

**Telegram:**
```json
{
  "notifications": {
    "provider": "telegram",
    "telegramToken": "your-bot-token",
    "telegramChatId": "your-chat-id",
    "onlyFor": ["high", "critical"]
  }
}
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/afk` | Toggle AFK mode on/off or set a timed duration |
| `/afk:review` | Open the web dashboard in your default browser |
| `/afk:stats` | Show today's decision summary in the terminal |
| `/afk:rules` | List, add, or remove static approval rules |
| `/afk:reset` | Clear decision history and start fresh |

### Static rules

Rules let you hard-code decisions for specific patterns without waiting for confidence to build.

```
/afk:rules                     list all rules
/afk:rules add                 interactive: set tool, pattern, action, label
/afk:rules remove <id>         delete a rule by ID
/afk:rules project             list rules scoped to the current project only
```

Rules are evaluated before behavior prediction. Higher-priority rules run first.

Example: always allow `npm test` without asking:

```
Tool: Bash
Pattern: npm test*
Action: allow
Label: Always allow npm test
```

---

## Web dashboard

The dashboard runs locally at `http://localhost:6789` and is started automatically when you run
`/afk:review`. It binds to 127.0.0.1 only and requires no internet connection.

Pages:

- **Overview** — AFK toggle, session stats, auto-rate, deferred count
- **Queue** — deferred actions waiting for review, approve or deny inline
- **History** — full decision log with filters by tool, source, and date
- **Patterns** — heatmap of which commands are auto-approved vs always flagged
- **Rules** — add, edit, and delete static rules
- **Digest** — narrative summary of the last AFK session

---

## Contributing

Requires Node.js 18 or later. AFK has two production dependencies: `better-sqlite3` and `express`.
Everything else uses Node.js built-ins.

```
git clone https://github.com/drprockz/afk
cd afk
npm install
node --test test/*.test.js
```

Open a pull request against `main`. Please include a test for any new engine behavior. The test
suite uses `node:test` with no additional test framework.

To test the hook locally:

```
echo '{"tool":"Bash","input":{"command":"npm test"},"session_id":"test-1","cwd":"/tmp"}' \
  | node src/hook.js
```

---

## License

MIT. See LICENSE for details.
