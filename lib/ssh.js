const { spawn } = require('child_process');
const path = require('path');

function getKeyPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(localAppData, 'DuneAwakeningServer', 'sshKey');
}

/**
 * @param {string} ip
 * @param {string} command
 * @param {function} [onData]  — streaming callback
 * @param {object}  [opts]
 * @param {number}  [opts.timeout]  — kill after N ms (default 300000 = 5 min)
 * @param {boolean} [opts.tty]      — force pseudo-terminal (-tt)
 * @param {string}  [opts.stdin]    — data to write to stdin then close
 */
function run(ip, command, onData, opts = {}) {
  return new Promise((resolve, reject) => {
    const keyPath = getKeyPath();
    const timeout = opts.timeout || 300000;

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'LogLevel=QUIET',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
    ];

    if (opts.tty) args.push('-tt');

    args.push('-i', keyPath, `dune@${ip}`, command);

    const proc = spawn('ssh', args, {
      windowsHide: true,
      stdio: [opts.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (opts.stdin != null) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onData) onData(text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onData) onData(text);
    });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const err = new Error(`SSH command timed out after ${timeout / 1000}s`);
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const err = new Error(stderr.trim() || stdout.trim() || `SSH exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

module.exports = { run, getKeyPath };
