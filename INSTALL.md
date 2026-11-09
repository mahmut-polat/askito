# Installing askito (instructions for an AI agent)

The user asked you to install askito, a local inbox where AI chats post questions for them. Follow these steps.

1. Check that `node --version` is 20 or newer. If Node is missing or older, tell the user and stop.
2. Run `npx -y github:mahmut-polat/askito setup`.
3. Read the output. Show the user every line that starts with `SKIPPED`, since those files need a manual edit.
4. Check whether the `Connected:` line names the tool you are running in. If it does not, run `~/.askito/bin/askito instructions` and add its output to your tool's global rules file. If your tool supports MCP, also register a stdio server named `askito` with command `~/.askito/bin/askito` (use the full path) and argument `mcp`.
5. Run `~/.askito/bin/askito open` to open the inbox in the browser.
6. Tell the user to restart any open AI chats so they load askito.

On Windows the command is `%USERPROFILE%\.askito\bin\askito.cmd`.
