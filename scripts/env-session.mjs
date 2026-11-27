// Prints the environment variables an AI tool sets that could name the chat a
// command runs in. Values are shown only for names that cannot hold a secret.
const secret = /TOKEN|KEY|SECRET|PASS|AUTH|COOKIE|CRED/i;
const wanted = /CLAUDE|SESSION|CODEX|CURSOR|ENTRYPOINT|TERM_PROGRAM|ANTHROPIC/i;
for (const name of Object.keys(process.env).sort()) {
  if (!wanted.test(name)) continue;
  console.log(secret.test(name) ? `${name}=<hidden>` : `${name}=${process.env[name]}`);
}
