const ps = require('./powershell');

const VM_NAME = 'dune-awakening';
const MIN_MEMORY_GB = 12;
const STEP_DOWN_GB = [40, 32, 30, 24, 20, 18, 16, 14, 12];

function isOutOfMemoryError(err) {
  const msg = `${err && err.message || ''}\n${err && err.stderr || ''}`;
  return /OutOfMemory|Not enough memory|0x8007000E/i.test(msg);
}

function shortVmError(message) {
  if (!message) return 'Unknown error';
  if (/Not enough memory|OutOfMemory|0x8007000E/i.test(message)) {
    const match = message.match(/ram size (\d+) megabytes/i);
    const gb = match ? Math.round(parseInt(match[1], 10) / 1024) : null;
    return gb
      ? `Not enough free RAM on this PC to start the VM at ${gb} GB. Choose a lower memory setting and try again.`
      : 'Not enough free RAM on this PC to start the VM. Choose a lower memory setting and try again.';
  }
  const line = message.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('At line:'));
  return (line || message).trim().slice(0, 240);
}

function buildStepDownList(configuredGB) {
  const cap = Math.max(MIN_MEMORY_GB, configuredGB || 30);
  return STEP_DOWN_GB.filter((gb) => gb >= MIN_MEMORY_GB && gb <= cap)
    .filter((gb, i, arr) => arr.indexOf(gb) === i)
    .sort((a, b) => b - a);
}

async function getVmStartupMemoryGB() {
  const raw = await ps.run(`(Get-VM -Name '${VM_NAME}').MemoryStartup`);
  const bytes = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes / 1073741824);
}

async function setVmMemoryGB(memoryGB, log) {
  const memBytes = memoryGB * 1073741824;
  if (log) log(`Setting VM memory to ${memoryGB} GB...\n`);
  await ps.run(`Set-VMMemory -VMName '${VM_NAME}' -StartupBytes ${memBytes}`, log);
}

async function waitForVmIp(log, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const raw = await ps.run(
        `(Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses | ` +
        `Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | ` +
        `Select-Object -First 1`
      );
      const ip = String(raw || '').trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch { /* keep waiting */ }
  }
  return null;
}

async function startVm({ memoryGB, log, autoStepDown = true } = {}) {
  let configuredGB = memoryGB;
  if (!configuredGB) {
    try {
      configuredGB = await getVmStartupMemoryGB();
    } catch {
      configuredGB = 30;
    }
  }

  const tryList = memoryGB
    ? [memoryGB]
    : autoStepDown
      ? buildStepDownList(configuredGB)
      : [configuredGB];

  let lastErr = null;

  for (let i = 0; i < tryList.length; i++) {
    const gb = tryList[i];
    const needsSet = gb !== configuredGB || Boolean(memoryGB) || i > 0;
    if (needsSet) {
      await setVmMemoryGB(gb, log);
    }

    try {
      if (log) log('Starting VM...\n');
      await ps.run(`Start-VM -Name '${VM_NAME}' -ErrorAction Stop`, log);
      if (log) log('Waiting for IP address...\n');
      const ip = await waitForVmIp(log);
      if (ip) {
        if (log) log(`VM ready at ${ip}\n`);
        return { success: true, ip, memoryGB: gb };
      }
      if (log) log('VM started but could not detect IP within 2 minutes.\n');
      return { success: true, ip: null, memoryGB: gb };
    } catch (err) {
      lastErr = err;
      if (!isOutOfMemoryError(err) || memoryGB) throw err;
      if (log) {
        log(`\nNot enough host RAM for ${gb} GB (${shortVmError(err.message)})\n`);
        if (i < tryList.length - 1) {
          log(`Trying ${tryList[i + 1]} GB instead...\n`);
        }
      }
    }
  }

  const err = new Error(shortVmError(lastErr && lastErr.message));
  err.code = 'OUT_OF_MEMORY';
  err.cause = lastErr;
  err.attemptedGB = tryList;
  throw err;
}

module.exports = {
  VM_NAME,
  MIN_MEMORY_GB,
  STEP_DOWN_GB,
  isOutOfMemoryError,
  shortVmError,
  getVmStartupMemoryGB,
  setVmMemoryGB,
  waitForVmIp,
  startVm,
};
