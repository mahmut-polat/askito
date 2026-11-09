---
name: askbell
description: Mandatory channel for questions, approvals and human-only tasks. Send them to the user's askbell inbox and never ask in chat. Use whenever you need a decision, a go-ahead, missing information, or something only the user can do (log in, pay, sign, click, press a physical button).
---

# askbell

The user runs many AI chats at once and answers all of them from one local inbox page. Posting there is mandatory: do not ask questions in the chat, and do not use chat question tools such as AskUserQuestion or end-of-turn buttons.

The command on this machine is `~/.askbell/bin/askbell`. MCP clients also have the same actions as `askbell_ask`, `askbell_wait`, `askbell_pickup`, `askbell_ack`, `askbell_reply` and `askbell_done`.

## Post

```bash
~/.askbell/bin/askbell ask "Which database should the reports use?" \
  --body "Reports take 40 s on the replica. Two ways to fix it are below." \
  --option "Materialized view::Fast, refreshes every 10 minutes" \
  --option "Read cache::Fresh, adds Redis" \
  --recommend 1 --chat "reports speedup" --wait

~/.askbell/bin/askbell approve "Run the production migration?" --body "Adds one column. Takes about 2 s." --wait

~/.askbell/bin/askbell task "Accept the Apple agreement" --body "App Store Connect, Business page. Uploads fail until this is done." --wait
```

Write for someone who has not seen this chat. The title is the decision or the action. The body says what you found, what each choice costs, and what you recommend. Give `--chat` a short name for your work so the user can tell chats apart.

The project is detected from the git repository. Use `--project` only when the detected name is wrong.

Use `--key <stable-id>` when you might retry, so the user gets one item instead of two. Use `--urgent` only when all your work is blocked.

Ask one thing per item.

## Get the answer

Pick the first of these your tool supports:

1. If a background command wakes you when it exits (Claude Code: Bash with `run_in_background: true`), run the `--wait` command in the background and keep working on anything that does not depend on the answer.
2. With MCP, call `askbell_ask`, then `askbell_wait`. On `PENDING`, call `askbell_wait` again.
3. With only a foreground shell, post without `--wait`, then run `~/.askbell/bin/askbell wait ID --timeout 100`. Exit code 4 means no answer yet, so run it again.

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

- Need more detail on the same subject: `~/.askbell/bin/askbell reply ID "Your follow-up"`, then wait again.
- Finished acting on the answer: `~/.askbell/bin/askbell done ID "What happened, in one line"`.

## When a session starts

Run `~/.askbell/bin/askbell pickup`. It lists answers no chat has collected for this project, which happens when the user answers after a chat has ended. For each one that belongs to your work, act on it and run `~/.askbell/bin/askbell ack ID`. Leave the others alone, since another chat may be waiting for them.

## If askbell fails

If the command is missing or returns an error, ask in the chat as usual and say that askbell did not work.
