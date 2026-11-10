import { execFile } from 'node:child_process';

const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

// Title and body come from agents, so they are passed as arguments or
// environment values and never interpolated into a script.
export function notifyCommand(platform, rawTitle, rawBody) {
  const title = clip(rawTitle, 80);
  const body = clip(rawBody, 180);
  // On macOS an osascript notification belongs to Script Editor, which opens
  // on every click. The inbox page shows browser notifications there instead.
  if (platform === 'darwin') return null;
  if (platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      '$n.ShowBalloonTip(6000,$env:ASKITO_N_TITLE,$env:ASKITO_N_BODY,"Info");Start-Sleep 7;$n.Dispose()';
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ASKITO_N_TITLE: title, ASKITO_N_BODY: body } }];
  }
  return ['notify-send', ['--', title, body], {}];
}

export function notify(title, body) {
  const command = notifyCommand(process.platform, title, body);
  if (command) execFile(command[0], command[1], command[2], () => {});
}
