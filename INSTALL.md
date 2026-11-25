# Installing askito (instructions for an AI agent)

The user asked you to install askito, a local inbox where AI chats post questions for them. Follow these steps.

1. Check that `node --version` is 20 or newer. If Node is missing or older, tell the user and stop.
2. Run `npx -y github:mahmut-polat/askito setup`.
3. Read the output. Show the user every line that starts with `SKIPPED`, since those files need a manual edit. If the output ends with `SKIPPED Claude panel`, the Claude Code panel was not added. Run `claude --version`. If it prints a version, run the two `claude plugin` commands printed under that line, exactly as printed, and tell the user the panel appears in Claude Code sessions they start from now on. If `claude` is not found, tell the user that the inbox works without the panel and that adding it needs the Claude Code command line tool, then point them to the "Claude Code panel" section of https://github.com/mahmut-polat/askito#claude-code-panel.
4. Check whether the `Connected:` line names the tool you are running in. If it does not, run `~/.askito/bin/askito instructions` and add its output to your tool's global rules file. If your tool supports MCP, also register a stdio server named `askito` with command `~/.askito/bin/askito` (use the full path) and argument `mcp`.
5. Run `~/.askito/bin/askito open` to open the inbox in the browser.
6. The setup output names the first question in the inbox. Tell the user to answer it, run `~/.askito/bin/askito wait ID`, and follow "First run" in `~/.askito/app/skill/SKILL.md`.

On Windows the command is `%USERPROFILE%\.askito\bin\askito.cmd`.
