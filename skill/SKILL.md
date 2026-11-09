---
name: askito
description: Mandatory channel for questions, approvals and human-only tasks. Send them to the user's askito inbox and never ask in chat. Use whenever you need a decision, a go-ahead, missing information, or something only the user can do (log in, pay, sign, click, press a physical button). Also opens the inbox page when the user types /askito.
---

# askito

The user runs many AI chats at once and answers all of them from one local inbox page. Posting there is mandatory: do not ask questions in the chat, and do not use chat question tools such as AskUserQuestion or end-of-turn buttons.

The command on this machine is `~/.askito/bin/askito`. MCP clients also have the same actions as `askito_ask`, `askito_wait`, `askito_pickup`, `askito_ack`, `askito_reply` and `askito_done`.

## When the user types `/askito`

If the user runs this skill directly with no other task, or asks to open the inbox, run `~/.askito/bin/askito open`, say in one line that the inbox is open, and stop.

## Post

```bash
~/.askito/bin/askito ask "Which database should the reports use?" \
  --body "Reports take 40 s on the replica. Two ways to fix it are below." \
  --option "Materialized view::Fast, refreshes every 10 minutes" \
  --option "Read cache::Fresh, adds Redis" \
  --recommend 1 --chat "reports speedup" --wait

~/.askito/bin/askito approve "Run the production migration?" --body "Adds one column. Takes about 2 s." --wait

~/.askito/bin/askito task "Accept the Apple agreement" --body "App Store Connect, Business page. Uploads fail until this is done." --wait
```

Write for someone who has not seen this chat. The title is the decision or the action. The body says what you found, what each choice costs, and what you recommend. Give `--chat` a short name for your work so the user can tell chats apart.

The project is detected from the git repository. Use `--project` only when the detected name is wrong.

Use `--key <stable-id>` when you might retry, so the user gets one item instead of two. Use `--urgent` only when all your work is blocked.

Ask one thing per item.

## Get the answer

Pick the first of these your tool supports:

1. If a background command wakes you when it exits (Claude Code: Bash with `run_in_background: true`), run the `--wait` command in the background and keep working on anything that does not depend on the answer.
2. With MCP, call `askito_ask`, then `askito_wait`. On `PENDING`, call `askito_wait` again.
3. With only a foreground shell, post without `--wait`, then run `~/.askito/bin/askito wait ID --timeout 100`. Exit code 4 means no answer yet, so run it again.

The result has `decision`, and may have `choices` and `comment`:

| decision | Meaning |
|---|---|
| `option` | The user picked `choices`. |
| `approved` / `rejected` | Go ahead, or do not. |
| `done` / `blocked` | The user finished the task, or could not. |
| `comment` | The user wrote `comment` instead of choosing. Follow it, or ask again with `reply`. |
| `dismissed` | The user removed the item. Do not do that work, and do not ask again. |

Read `comment` even when there is a decision. It can change what the decision means.

## After the answer

- Need more detail on the same subject: `~/.askito/bin/askito reply ID "Your follow-up"`, then wait again.
- Starting on the answer: `~/.askito/bin/askito progress ID "What you are doing"`. Do this straight away, and again during long work.
- Finished: `~/.askito/bin/askito done ID "What you did"`. The note is required, because it is the result the user reads.

## When a session starts

Run `~/.askito/bin/askito pickup`. It lists answers no chat has collected for this project, which happens when the user answers after a chat has ended. For each one that belongs to your work, act on it and run `~/.askito/bin/askito ack ID`. Leave the others alone, since another chat may be waiting for them.

## First run

A new install puts one approval in the inbox, with `key: first-run-broadcast`. It asks whether to tell the chats that are already open about askito. `pickup` shows the answer in every project, and whoever installed askito gets its id from the setup output and can `wait` on it.

If the decision is `approved`, run `ack ID`. Then send every other running session this message with your tool's own way of reaching them (in Claude Code: `ListAgents`, then `SendMessage` to each one):

> The user asked every session to start using the askito inbox. From now on, send every question, decision, approval and human-only task to `~/.askito/bin/askito` instead of asking in the chat. The full guide is in `~/.askito/app/skill/SKILL.md`. Run `~/.askito/bin/askito pickup` now, move any question still waiting in your chat to the inbox, and carry on with your work. No reply is needed.

Finish with `done ID "Told N sessions"`, and list any session the message did not reach. If your tool cannot reach other sessions, say that in the `done` note and tell the user to restart those chats.

If the decision is `rejected` or `dismissed`, run `ack ID` and `done ID`, and send nothing.

## Setup

If `~/.askito/bin/askito` does not exist, run `npx -y github:mahmut-polat/askito setup`, then wait for the first question as described in "First run". That one command installs the app, connects every AI tool it finds, adds the mandatory rule and installs this skill. The user has nothing else to configure.

A repository shows under its folder name. To change that, run `~/.askito/bin/askito alias "Friendly name" /path/to/repo`.

## If askito fails

If the command returns an error or setup does not work, ask in the chat as usual and say that askito did not work.
