// PM2 ecosystem — abs-sync.
//
// This app is not just a web UI: `instrumentation.ts` starts a transfer worker
// and a watch scheduler on boot, so it is a long-running service that has to
// outlive the shell it was started from. Running `npm run dev` in an SSH
// session does not — sshd sends SIGHUP to the process group on disconnect and
// the server dies mid-transfer, which is exactly what happened on 2026-08-11.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// `pm2-conrad.service` plus `loginctl enable-linger` bring it back after a
// reboot. Logs land in ./logs rather than the terminal, so a real crash leaves
// evidence behind.
module.exports = {
  apps: [
    {
      name: 'abs-sync',
      // The built server, not `next dev`: hot reload and pm2's restart
      // supervision work against each other, and dev mode costs ~1 GB RSS.
      script: 'npm',
      args: 'run start',
      cwd: __dirname + '/apps/web',
      out_file: __dirname + '/logs/abs-sync.log',
      error_file: __dirname + '/logs/abs-sync-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // A transfer that dies takes its spool with it; the worker requeues
      // interrupted jobs on the next boot, so restarting is safe and wanted.
      autorestart: true,
      // Back off rather than hammering a server that fails on startup (e.g. a
      // bad ABS_SYNC_SECRET), and give up after enough tries to be obviously wrong.
      restart_delay: 5000,
      max_restarts: 10,
      // Transfers hold whole audiobooks in flight; dev mode peaked near 1 GB.
      // This is a ceiling against a leak, not a normal operating point.
      max_memory_restart: '2G',
      // Let an in-flight upload finish rather than truncating it on `pm2 reload`.
      kill_timeout: 30000,
    },
  ],
};
