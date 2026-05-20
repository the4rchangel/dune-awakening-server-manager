const { spawn } = require('child_process');

const PS_ARGS = ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function run(command, onData) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [...PS_ARGS, command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onData) onData(text);
    });

    ps.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onData) onData(text);
    });

    ps.on('error', (err) => reject(err));
    ps.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const err = new Error(stderr.trim() || `PowerShell exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function runJson(command) {
  return run(command).then((out) => {
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  });
}

module.exports = { run, runJson };
