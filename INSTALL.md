# Installing askbell (instructions for an AI agent)

The user asked you to install askbell, a local inbox where AI chats post questions for them. Follow these steps.

1. Check that `node --version` is 20 or newer. If Node is missing or older, tell the user and stop.
2. Run `npx -y github:mahmut-polat/askbell setup`.
3. Read the output. Show the user every line that starts with `SKIPPED`, since those files need a manual edit.
4. Check whether the `Connected:` line names the tool you are running in. If it does not, run `~/.askbell/bin/askbell instructions` and add its output to your tool's global rules file. If your tool supports MCP, also register a stdio server named `askbell` with command `~/.askbell/bin/askbell` (use the full path) and argument `mcp`.
5. Run `~/.askbell/bin/askbell open` to open the inbox in the browser.
6. Tell the user to restart any open AI chats so they load askbell.

On Windows the command is `%USERPROFILE%\.askbell\bin\askbell.cmd`.
