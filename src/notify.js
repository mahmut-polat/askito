import { execFile } from 'node:child_process';

const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

// Title and body come from agents, so they are passed as arguments or
// environment values and never interpolated into a script.
export function notify(rawTitle, rawBody) {
  const title = clip(rawTitle, 80);
  const body = clip(rawBody, 180);
  const ignore = () => {};
  if (process.platform === 'darwin') {
    const script = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];
    execFile('osascript', [...script.flatMap((line) => ['-e', line]), title, body], ignore);
  } else if (process.platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      '$n.ShowBalloonTip(6000,$env:ASKITO_N_TITLE,$env:ASKITO_N_BODY,"Info");Start-Sleep 7;$n.Dispose()';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ASKITO_N_TITLE: title, ASKITO_N_BODY: body } }, ignore);
  } else {
    execFile('notify-send', ['--', title, body], ignore);
  }
}
