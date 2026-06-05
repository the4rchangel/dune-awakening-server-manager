const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let cachedLocalAppData = null;

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function getWindowsLocalAppData() {
  if (cachedLocalAppData) return cachedLocalAppData;
  if (process.env.LOCALAPPDATA) {
    cachedLocalAppData = process.env.LOCALAPPDATA;
    return cachedLocalAppData;
  }
  if (process.env.USERPROFILE) {
    cachedLocalAppData = path.join(process.env.USERPROFILE, 'AppData', 'Local');
    return cachedLocalAppData;
  }
  try {
    const out = execSync(
      'powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath(\'LocalApplicationData\')"',
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    ).trim();
    if (out) {
      cachedLocalAppData = out;
      return cachedLocalAppData;
    }
  } catch { /* fall through */ }
  throw new Error(
    'Could not resolve Windows LOCALAPPDATA. Start the manager with start_as_admin.bat on Windows.'
  );
}

function windowsToWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return winPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function getDuneKeyDir() {
  return path.join(getWindowsLocalAppData(), 'DuneAwakeningServer');
}

function getKeyPath() {
  return path.join(getDuneKeyDir(), 'sshKey');
}

function getWslKeyMirrorPath() {
  return path.join(os.homedir(), '.dune-awakening-server-manager', 'sshKey');
}

function sshKeyExists() {
  try {
    const keyPath = isWsl() ? windowsToWslPath(getKeyPath()) : getKeyPath();
    return fs.existsSync(keyPath);
  } catch {
    return false;
  }
}

function getSshIdentityPath() {
  const keyPath = getKeyPath();
  if (!isWsl()) return keyPath;

  const source = windowsToWslPath(keyPath);
  if (!fs.existsSync(source)) {
    throw new Error(
      `SSH key not found at ${keyPath}. Use Settings → Rotate SSH Key, or re-run Setup → Security.`
    );
  }

  const localKey = getWslKeyMirrorPath();
  fs.mkdirSync(path.dirname(localKey), { recursive: true });

  const srcStat = fs.statSync(source);
  let needsCopy = !fs.existsSync(localKey);
  if (!needsCopy) {
    const dstStat = fs.statSync(localKey);
    needsCopy = srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size;
  }
  if (needsCopy) {
    fs.copyFileSync(source, localKey);
  }
  fs.chmodSync(localKey, 0o600);
  return localKey;
}

function removeWslKeyMirror() {
  try {
    const mirror = getWslKeyMirrorPath();
    if (fs.existsSync(mirror)) fs.unlinkSync(mirror);
  } catch { /* ignore */ }
}

module.exports = {
  isWsl,
  getWindowsLocalAppData,
  getDuneKeyDir,
  getKeyPath,
  getSshIdentityPath,
  getWslKeyMirrorPath,
  sshKeyExists,
  removeWslKeyMirror,
  windowsToWslPath,
};
