const express = require('express');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const ps = require('./lib/powershell');
const ssh = require('./lib/ssh');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const VM_NAME = 'dune-awakening';

const DEFAULT_SERVER_PATH = path.join(
  'C:', 'Program Files (x86)', 'Steam', 'steamapps', 'common',
  'Dune Awakening Self-Hosted Server'
);

app.use(express.json());

// ---------------------------------------------------------------------------
// WebSocket — broadcast helper
// ---------------------------------------------------------------------------
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function log(text) {
  broadcast('output', text);
}

// ---------------------------------------------------------------------------
// VM helpers
// ---------------------------------------------------------------------------
const VM_STATUS_CMD = `
$vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
if ($vm) {
  $ip = $null
  if ($vm.State -eq 'Running') {
    $ip = (Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses |
          Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } |
          Select-Object -First 1
  }
  [PSCustomObject]@{
    exists   = $true
    state    = $vm.State.ToString()
    ip       = $ip
    memoryMB = [math]::Round($vm.MemoryAssigned / 1MB)
    uptime   = $vm.Uptime.ToString()
  } | ConvertTo-Json -Compress
} else {
  '{"exists":false}'
}`.trim();

let cachedVmStatus = null;

async function getVmStatus() {
  try {
    cachedVmStatus = await ps.runJson(VM_STATUS_CMD);
  } catch {
    cachedVmStatus = { exists: false, error: 'Failed to query Hyper-V' };
  }
  return cachedVmStatus;
}

async function getVmIp() {
  const st = cachedVmStatus || (await getVmStatus());
  return st && st.ip ? st.ip : null;
}

// Auto-sync is disabled once the user explicitly sets an IP via the dashboard.
// It only runs on first boot to seed settings.conf when it's empty.
let lastKnownVmIp = null;
let visibilityManuallySet = false;

// Funcom reads line 4 of settings.conf at gateway startup as GameRmqAddress.
const PORT_FORWARD_INFO = {
  rmqTcp: 31982,
  gameUdpStart: 7777,
  gameUdpEnd: 7810,
};

async function readSettingsConfIp(vmIp) {
  return (await ssh.run(vmIp,
    "sed -n '4p' /home/dune/.dune/settings.conf 2>/dev/null",
    null, { timeout: 10000 })).trim();
}

async function writeSettingsConfIp(vmIp, advertisedIp) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(advertisedIp)) {
    throw new Error(`Invalid IP address: ${advertisedIp}`);
  }
  const content = `\n\n\n${advertisedIp}\n`;
  const b64 = Buffer.from(content).toString('base64');
  await ssh.run(vmIp, `echo ${b64} | base64 -d > /home/dune/.dune/settings.conf`, null, { timeout: 10000 });
}

async function syncSettingsConfIp(ip) {
  if (!ip || ip === lastKnownVmIp || visibilityManuallySet) return;
  try {
    const currentIpInConf = await readSettingsConfIp(ip);
    if (!currentIpInConf) {
      // settings.conf has no IP yet — seed it with the VM's private IP
      log(`Seeding settings.conf with VM IP ${ip}...\n`);
      await writeSettingsConfIp(ip, ip);
    }
    lastKnownVmIp = ip;
  } catch { /* non-critical */ }
}

async function getDirectorPort(ip) {
  try {
    const raw = await ssh.run(ip,
      "sudo kubectl get svc -A -o jsonpath='{.items[*].spec.ports[?(@.port==11717)].nodePort}' 2>/dev/null"
    );
    const port = raw.replace(/'/g, '').trim();
    return /^\d+$/.test(port) ? port : null;
  } catch {
    return null;
  }
}

function battlegroupOutputNeedsBootstrap(output) {
  return /No resources found/i.test(output || '');
}

async function cleanOrphanBattlegroupNamespaces(ip) {
  const bgCount = (await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers 2>/dev/null | wc -l",
    null, { timeout: 15000 })).trim();
  if (parseInt(bgCount, 10) > 0) return false;

  log('No battlegroup CR found — removing empty seabass namespace(s)...\n');
  await ssh.run(ip, [
    "for ns in $(sudo kubectl get ns -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\\n' | grep '^funcom-seabass-'); do",
    '  sudo kubectl delete ns "$ns" --wait=false 2>/dev/null || true',
    'done',
    'echo CLEAN_OK',
  ].join(' '), log, { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 8000));
  return true;
}

async function runBootstrapSetup(ip, { token, worldName, region, enableSwap }) {
  log('Uploading bootstrap files...\n');
  const psUpload = `
    $scriptDir = '${DEFAULT_SERVER_PATH}\\battlegroup-management'
    $sshKey = "$env:LOCALAPPDATA\\DuneAwakeningServer\\sshKey"
    $bootstrapSetup = Join-Path $scriptDir 'bootstrap\\setup'
    $setupText = (Get-Content $bootstrapSetup -Raw) -replace "\`r\`n", "\`n"
    $b64Setup = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($setupText))
    $uploadScript = @"
#!/bin/sh
set -e
echo $b64Setup | base64 -d | sudo -n tee /home/dune/.dune/bin/setup > /dev/null
sudo -n chmod +x /home/dune/.dune/bin/setup
echo UPLOAD_OK
"@
    $uploadScript = $uploadScript -replace "\`r\`n", "\`n"
    $b64Upload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($uploadScript))
    $uploadCmd = "echo $b64Upload | base64 -d | sh"
    $out = & ssh -o StrictHostKeyChecking=no -o LogLevel=QUIET -i "$sshKey" "dune@${ip}" $uploadCmd 2>&1
    $out | Out-String
  `;
  const uploadOut = await ps.run(psUpload, log);
  if (!uploadOut.includes('UPLOAD_OK')) {
    throw new Error('Bootstrap upload failed');
  }

  const stdinLines = [
    worldName || 'Dune Server',
    region || '3',
    token || '',
  ].join('\n') + '\n';

  log('\nRunning first-time battlegroup setup (this takes a while)...\n');
  await ssh.run(ip, '/home/dune/.dune/bin/setup 2>&1', log, {
    timeout: 900000,
    stdin: stdinLines,
  });
  log('\nBattlegroup setup complete.\n');

  if (enableSwap) {
    log('\nEnabling experimental swap memory...\n');
    await ssh.run(
      ip,
      'echo yes | /home/dune/.dune/bin/battlegroup enable-experimental-swap 2>&1',
      log,
      { timeout: 600000, tty: true }
    );
    log('Swap memory enabled.\n');
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// --- Status (with in-flight guard to prevent stacking from fast polls) ---
let statusInFlight = false;
let lastStatusResult = null;

app.get('/api/status', async (_req, res) => {
  if (statusInFlight && lastStatusResult) return res.json(lastStatusResult);

  statusInFlight = true;
  try {
    const vm = await getVmStatus();
    let bg = null;
    let directorPort = null;

    if (vm.exists && vm.state === 'Running' && vm.ip) {
      try {
        const raw = await ssh.run(vm.ip, '/home/dune/.dune/bin/battlegroup status 2>&1', null, { timeout: 10000, tty: true });
        const gameServersSection = raw.split(/Game Servers/i)[1] || '';
        const hasRunningServers = /\bRunning\b/i.test(gameServersSection);
        bg = {
          running: hasRunningServers,
          output: raw,
          needsBootstrap: battlegroupOutputNeedsBootstrap(raw),
        };
      } catch (e) {
        const out = e.stdout || e.message;
        bg = {
          running: false,
          output: out,
          needsBootstrap: battlegroupOutputNeedsBootstrap(out),
        };
      }
      directorPort = await getDirectorPort(vm.ip);
      syncSettingsConfIp(vm.ip);
    }

    lastStatusResult = {
      vm,
      battlegroup: bg,
      links: vm.ip ? {
        fileBrowser: `http://${vm.ip}:18888/`,
        director: directorPort ? `http://${vm.ip}:${directorPort}/` : null,
      } : null,
    };
    res.json(lastStatusResult);
  } catch (e) {
    if (lastStatusResult) return res.json(lastStatusResult);
    res.status(500).json({ error: e.message });
  } finally {
    statusInFlight = false;
  }
});

// --- VM controls ---
app.post('/api/vm/start', async (_req, res) => {
  try {
    log('Starting VM...\n');
    await ps.run(`Start-VM -Name '${VM_NAME}'`, log);

    log('Waiting for IP address...\n');
    let ip = null;
    for (let i = 0; i < 60 && !ip; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const raw = await ps.run(
          `(Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses | ` +
          `Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | ` +
          `Select-Object -First 1`
        );
        if (raw && /^\d+\.\d+\.\d+\.\d+$/.test(raw)) ip = raw;
      } catch { /* keep waiting */ }
    }

    if (ip) {
      log(`VM ready at ${ip}\n`);
      await syncSettingsConfIp(ip);
    } else {
      log('VM started but could not detect IP within 2 minutes.\n');
    }
    cachedVmStatus = null;
    res.json({ success: true, ip });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/vm/stop', async (_req, res) => {
  try {
    log('Stopping VM...\n');
    await ps.run(`Stop-VM -Name '${VM_NAME}' -Force`, log);
    log('VM stopped.\n');
    cachedVmStatus = null;
    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- VM settings ---
app.post('/api/vm/password', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const b64 = Buffer.from(`dune:${password}\n`).toString('base64');
    const out = await ssh.run(ip, `echo ${b64} | base64 -d | sudo -n chpasswd && echo PWOK`);
    if (out.includes('PWOK')) {
      log('Password changed successfully.\n');
      res.json({ success: true });
    } else {
      throw new Error('Unexpected output');
    }
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/vm/rotate-key', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Rotating SSH key...\n');
    const psCmd = `
      $scriptDir = '${DEFAULT_SERVER_PATH}\\battlegroup-management'
      . "$scriptDir\\vm-utilities.ps1"
      Update-SshKey -Ip '${ip}'
    `;
    await ps.run(psCmd, log);
    log('SSH key rotated.\n');
    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Battlegroup commands ---
async function fixImageTagsIfNeeded(ip) {
  try {
    const ns = (await ssh.run(ip,
      "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.namespace' 2>/dev/null | head -1",
      null, { timeout: 15000 })).trim();
    const bgName = (await ssh.run(ip,
      "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.name' 2>/dev/null | head -1",
      null, { timeout: 15000 })).trim();
    if (!ns || !bgName) return;

    const raw = await ssh.run(ip,
      `sudo kubectl get battlegroup ${bgName} -n ${ns} -o json 2>/dev/null`,
      null, { timeout: 30000 });
    const bg = JSON.parse(raw);

    const serverImage = bg.spec?.serverGroup?.template?.spec?.sets?.[0]?.image || '';
    if (!/:0-0-shipping$/.test(serverImage)) return;

    log('Detected placeholder image tags (0-0-shipping). Looking up correct version...\n');

    const imgLine = (await ssh.run(ip,
      "sudo crictl images 2>/dev/null | grep 'seabass-server ' | head -1",
      null, { timeout: 15000 })).trim();
    const parts = imgLine.split(/\s+/);
    const correctTag = parts[1];
    if (!correctTag || correctTag === '0-0-shipping') {
      log('Could not determine correct image tag from local images.\n');
      return;
    }

    log(`Patching image tags from 0-0-shipping to ${correctTag}...\n`);
    await ssh.run(ip,
      `sudo kubectl get battlegroup ${bgName} -n ${ns} -o json 2>/dev/null | ` +
      `sed 's|:0-0-shipping|:${correctTag}|g' | ` +
      `sudo kubectl apply -f - 2>&1`,
      null, { timeout: 30000 });
    log('Image tags corrected.\n');

    // Clean up any pods stuck from the bad tags
    const stuckPods = (await ssh.run(ip,
      `sudo kubectl get pods -n ${ns} --no-headers 2>/dev/null | grep -E 'ImagePullBackOff|ErrImagePull|Init:ImagePullBackOff' | awk '{print $1}'`,
      null, { timeout: 15000 })).trim();
    if (stuckPods) {
      const podList = stuckPods.split('\n').filter(Boolean);
      log(`Cleaning up ${podList.length} stuck pod(s)...\n`);
      await ssh.run(ip,
        `sudo kubectl delete pods -n ${ns} ${podList.join(' ')} 2>&1`,
        null, { timeout: 15000 });
    }

    // Clean up Error pods from failed DB init jobs so the operator can retry
    const errorPods = (await ssh.run(ip,
      `sudo kubectl get pods -n ${ns} --no-headers 2>/dev/null | grep -E 'Error' | grep 'db-dbdepl-util' | awk '{print $1}'`,
      null, { timeout: 15000 })).trim();
    if (errorPods) {
      const podList = errorPods.split('\n').filter(Boolean);
      log(`Cleaning up ${podList.length} failed DB init pod(s)...\n`);
      await ssh.run(ip,
        `sudo kubectl delete pods -n ${ns} ${podList.join(' ')} 2>&1`,
        null, { timeout: 15000 });
    }

    log('Pre-start cleanup complete.\n');
  } catch (e) {
    log(`Image tag check warning: ${e.message}\n`);
  }
}

function bgRoute(action, label, timeoutMs) {
  app.post(`/api/bg/${action}`, async (_req, res) => {
    const ip = await getVmIp();
    if (!ip) {
      log(`Cannot ${action}: VM is not running.\n`);
      return res.status(400).json({ error: 'VM not running' });
    }

    try {
      if (action === 'start' || action === 'restart') {
        // Fix placeholder image tags before starting
        await fixImageTagsIfNeeded(ip);

        // Re-apply the visibility IP so the gateway registers GameRmqAddress on startup
        try {
          const currentIp = await readSettingsConfIp(ip);
          if (currentIp && /^\d+\.\d+\.\d+\.\d+$/.test(currentIp)) {
            await writeSettingsConfIp(ip, currentIp);
            log(`Confirmed visibility IP: ${currentIp}\n`);
            if (currentIp !== ip) {
              log(`WAN mode: ensure TCP ${PORT_FORWARD_INFO.rmqTcp}, Director NodePort, and UDP ${PORT_FORWARD_INFO.gameUdpStart}-${PORT_FORWARD_INFO.gameUdpEnd} are forwarded to VM ${ip}\n`);
            }
          }
        } catch { /* non-critical */ }
      }

      log(`${label}...\n`);
      const out = await ssh.run(
        ip,
        `/home/dune/.dune/bin/battlegroup ${action} 2>&1`,
        log,
        { timeout: timeoutMs || 300000, tty: true }
      );
      log(`\n${label} complete.\n`);
      res.json({ success: true, output: out });
    } catch (e) {
      const hint = /timed out/i.test(e.message)
        ? `\nThe ${action} command timed out. The battlegroup may still be processing — check status in a minute.\n`
        : /ECONNREFUSED|connect/i.test(e.message)
        ? `\nCould not connect to the VM at ${ip}. Make sure the VM is running and SSH is reachable.\n`
        : /permission|denied/i.test(e.message)
        ? `\nSSH authentication failed. The VM may need its SSH key reconfigured.\n`
        : '';
      log(`Error: ${e.message}${hint}\n`);
      if (e.stdout) log(`Output before error:\n${e.stdout}\n`);
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

bgRoute('start', 'Starting battlegroup', 600000);
bgRoute('stop', 'Stopping battlegroup');
bgRoute('restart', 'Restarting battlegroup', 600000);
bgRoute('update', 'Updating battlegroup', 600000);
bgRoute('backup', 'Creating database backup', 600000);
bgRoute('import', 'Importing database backup', 600000);
bgRoute('enable-experimental-swap', 'Enabling swap memory', 600000);

// --- Logs ---
app.post('/api/logs/export', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Exporting battlegroup logs...\n');
    const out = await ssh.run(ip, '/home/dune/.dune/bin/battlegroup logs-export 2>&1', log, { timeout: 300000, tty: true });
    log('\nLog export complete.\n');
    res.json({ success: true, output: out });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/logs/operators', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Exporting operator logs...\n');
    const out = await ssh.run(ip, '/home/dune/.dune/bin/battlegroup operator-logs-export 2>&1', log, { timeout: 300000, tty: true });
    log('\nOperator log export complete.\n');
    res.json({ success: true, output: out });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

// Step 1 — Pre-flight: check Hyper-V, existing VM, available drives
app.get('/api/setup/preflight', async (_req, res) => {
  try {
    const out = await ps.run(`
      $result = @{ hyperv = $false; vmExists = $false; vmState = $null; drives = @() }

      if (Get-Module -ListAvailable -Name Hyper-V) {
        $svc = Get-Service -Name vmms -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { $result.hyperv = $true }
      }

      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        $result.vmExists = $true
        $result.vmState = $vm.State.ToString()
      }

      $result.drives = @(Get-PSDrive -PSProvider FileSystem |
        Where-Object { $_.Free -gt 100GB } |
        ForEach-Object { @{ name = $_.Name; freeGB = [math]::Round($_.Free / 1GB, 1) } })

      $vmcx = Get-Item '${DEFAULT_SERVER_PATH}\\Virtual Machines\\*.vmcx' -ErrorAction SilentlyContinue | Select-Object -First 1
      $result.vmcxFound = [bool]$vmcx

      $nics = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Hyper-V|Virtual' } |
        ForEach-Object { @{ name = $_.Name; desc = $_.InterfaceDescription } })
      $result.nics = $nics

      $result | ConvertTo-Json -Depth 3 -Compress
    `);
    res.json(JSON.parse(out));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset — remove VM, install folders, SSH keys (fresh setup)
app.post('/api/setup/reset', async (_req, res) => {
  const fs = require('fs');
  const os = require('os');

  try {
    log('=== Resetting Dune server installation ===\n');

    const vm = await getVmStatus();
    if (vm.exists && vm.state === 'Running' && vm.ip) {
      log('Stopping battlegroup (if running)...\n');
      try {
        await ssh.run(vm.ip, '/home/dune/.dune/bin/battlegroup stop 2>&1', log, { timeout: 180000, tty: true });
        log('Battlegroup stop sent.\n');
      } catch (e) {
        log(`Battlegroup stop skipped: ${e.message}\n`);
      }
    }

    log('Removing Hyper-V VM and install folders...\n');
    const psOut = await ps.run(`
      $removedVm = $false
      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        if ($vm.State -eq 'Running') { Stop-VM -Name '${VM_NAME}' -TurnOff -Force }
        Remove-VM -Name '${VM_NAME}' -Force
        $removedVm = $true
        Write-Output 'Removed VM dune-awakening.'
      }

      $cleared = @()
      Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        $dest = "$($_.Name):\\DuneAwakeningServer"
        if (Test-Path $dest) {
          Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
          if (-not (Test-Path $dest)) { $cleared += $dest }
        }
      }
      if ($cleared.Count -gt 0) { Write-Output ("Cleared: " + ($cleared -join ', ')) }

      $sw = Get-VMSwitch -Name 'DuneAwakeningServerSwitch' -ErrorAction SilentlyContinue
      if ($sw) {
        $used = @(Get-VMNetworkAdapter -All | Where-Object { $_.SwitchName -eq 'DuneAwakeningServerSwitch' })
        if ($used.Count -eq 0) {
          Remove-VMSwitch -Name 'DuneAwakeningServerSwitch' -Force -ErrorAction SilentlyContinue
          Write-Output 'Removed unused DuneAwakeningServerSwitch.'
        }
      }

      @{ removedVm = $removedVm; vmExists = [bool](Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
    `, log);

    let resetMeta = {};
    try { resetMeta = JSON.parse(psOut.trim().split('\n').pop()); } catch { /* ignore */ }

    const keyDir = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'DuneAwakeningServer'
    );
    if (fs.existsSync(keyDir)) {
      fs.rmSync(keyDir, { recursive: true, force: true });
      log(`Removed SSH keys at ${keyDir}\n`);
    }

    visibilityManuallySet = false;
    lastKnownVmIp = null;
    cachedVmStatus = null;
    lastStatusResult = null;

    log('Reset complete. Run the setup wizard from step 1.\n');
    res.json({
      success: true,
      removedVm: !!resetMeta.removedVm,
      vmExists: !!resetMeta.vmExists,
    });
  } catch (e) {
    log(`Reset error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 2 — Import VM: remove old if needed, import, configure network+memory, start
app.post('/api/setup/import', async (req, res) => {
  const { drive, memoryGB, networkMode, nicName } = req.body;
  if (!drive || !memoryGB) return res.status(400).json({ error: 'drive and memoryGB required' });

  const dest = `${drive}:\\DuneAwakeningServer`;
  const memBytes = memoryGB * 1073741824; // 1GB in bytes
  const switchMode = networkMode === 'default' ? 'default' : 'external';

  try {
    log('=== Starting VM import ===\n');

    // Remove existing VM if present
    log('Checking for existing VM...\n');
    await ps.run(`
      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        if ($vm.State -eq 'Running') { Stop-VM -Name '${VM_NAME}' -TurnOff -Force }
        Remove-VM -Name '${VM_NAME}' -Force
        Write-Output 'Removed existing VM.'
      }
      if (Test-Path '${dest}') {
        Remove-Item '${dest}' -Recurse -Force -ErrorAction SilentlyContinue
        Write-Output 'Cleared destination folder.'
      }
    `, log);

    // Import
    log('\nImporting VM (this may take a few minutes)...\n');
    await ps.run(`
      $vmcx = Get-Item '${DEFAULT_SERVER_PATH}\\Virtual Machines\\*.vmcx' -ErrorAction Stop | Select-Object -First 1
      $compat = Compare-VM -Path $vmcx.FullName -Copy -VirtualMachinePath '${dest}' -VhdDestinationPath '${dest}\\Virtual Hard Disks' -ErrorAction Stop
      Import-VM -CompatibilityReport $compat -ErrorAction Stop | Out-Null
      Write-Output 'VM imported.'
    `, log);

    // Network switch
    log('\nConfiguring network...\n');
    if (switchMode === 'default') {
      await ps.run(`
        Connect-VMNetworkAdapter -VMName '${VM_NAME}' -SwitchName 'Default Switch' -ErrorAction Stop
        Write-Output 'Connected to Default Switch.'
      `, log);
    } else {
      const nicArg = nicName ? nicName.replace(/'/g, "''") : '';
      await ps.run(`
        $nicName = '${nicArg}'
        if (-not $nicName) {
          $nic = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Hyper-V|Virtual' } | Select-Object -First 1
          $nicName = $nic.Name
        }
        $existing = Get-VMSwitch -SwitchType External -ErrorAction SilentlyContinue |
          Where-Object { $_.NetAdapterInterfaceDescription -eq (Get-NetAdapter -Name $nicName).InterfaceDescription }
        if ($existing) {
          $switchName = $existing.Name
        } else {
          $switchName = 'DuneAwakeningServerSwitch'
          New-VMSwitch -Name $switchName -NetAdapterName $nicName -AllowManagementOS $true -ErrorAction Stop | Out-Null
          Write-Output "Created external switch '$switchName'."
        }
        Connect-VMNetworkAdapter -VMName '${VM_NAME}' -SwitchName $switchName -ErrorAction Stop
        Write-Output "Connected to switch '$switchName'."
      `, log);
    }

    // Resize disk
    log('\nInitializing virtual disk...\n');
    await ps.run(`
      $vhdx = Get-Item '${dest}\\Virtual Hard Disks\\*.vhdx' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($vhdx) { Resize-VHD -Path $vhdx.FullName -SizeBytes 100GB -ErrorAction Stop; Write-Output 'Disk resized to 100GB.' }

      $boot = Get-VMHardDiskDrive -VMName '${VM_NAME}' | Select-Object -First 1
      if ($boot) { Set-VMFirmware -VMName '${VM_NAME}' -FirstBootDevice $boot }
    `, log);

    // Memory
    log('\nSetting memory to ' + memoryGB + 'GB...\n');
    await ps.run(`
      Set-VMMemory -VMName '${VM_NAME}' -StartupBytes ${memBytes}
      Write-Output 'Memory configured.'
    `, log);

    // Start VM
    log('\nStarting VM...\n');
    try {
      await ps.run(`Start-VM -Name '${VM_NAME}' -ErrorAction Stop`, log);
    } catch (startErr) {
      log(`\nVM imported successfully but failed to start: ${startErr.message}\n`);
      log('You can adjust memory below and retry.\n');
      cachedVmStatus = null;
      return res.json({ success: false, imported: true, startFailed: true, error: startErr.message });
    }

    // Wait for IP
    log('Waiting for VM to acquire IP...\n');
    let ip = null;
    for (let i = 0; i < 60 && !ip; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const raw = await ps.run(
          `(Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses | ` +
          `Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | ` +
          `Select-Object -First 1`
        );
        if (raw && /^\d+\.\d+\.\d+\.\d+$/.test(raw.trim())) ip = raw.trim();
      } catch { /* keep waiting */ }
    }

    if (!ip) {
      log('Could not detect VM IP after 2 minutes.\n');
      return res.status(500).json({ success: false, error: 'VM started but no IP detected' });
    }

    log(`VM ready at ${ip}\n`);
    cachedVmStatus = null;
    res.json({ success: true, ip });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Retry start with different memory (VM already imported)
app.post('/api/setup/retry-start', async (req, res) => {
  const { memoryGB } = req.body;
  if (!memoryGB) return res.status(400).json({ error: 'memoryGB required' });

  const memBytes = memoryGB * 1073741824;

  try {
    log(`\nSetting memory to ${memoryGB}GB...\n`);
    await ps.run(`Set-VMMemory -VMName '${VM_NAME}' -StartupBytes ${memBytes}`, log);

    log('Starting VM...\n');
    await ps.run(`Start-VM -Name '${VM_NAME}' -ErrorAction Stop`, log);

    log('Waiting for VM to acquire IP...\n');
    let ip = null;
    for (let i = 0; i < 60 && !ip; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const raw = await ps.run(
          `(Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses | ` +
          `Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } | ` +
          `Select-Object -First 1`
        );
        if (raw && /^\d+\.\d+\.\d+\.\d+$/.test(raw.trim())) ip = raw.trim();
      } catch { /* keep waiting */ }
    }

    if (!ip) {
      log('Could not detect VM IP after 2 minutes.\n');
      return res.status(500).json({ success: false, error: 'VM started but no IP detected' });
    }

    log(`VM ready at ${ip}\n`);
    cachedVmStatus = null;
    res.json({ success: true, ip });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 3 — SSH key + password (combined — uses ASKPASS for first-time key install)
app.post('/api/setup/security', async (req, res) => {
  const { ip, currentPassword, newPassword } = req.body;
  if (!ip || !newPassword) return res.status(400).json({ error: 'ip and newPassword required' });

  const curPw = currentPassword || 'dune';
  const fs = require('fs');
  const os = require('os');
  const { spawn: spawnProc } = require('child_process');

  const keyDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'DuneAwakeningServer'
  );
  const keyPath = path.join(keyDir, 'sshKey');
  const tmpDir = os.tmpdir();
  const tempKey = path.join(tmpDir, `dunekey-${Date.now()}`);
  const askpassFile = path.join(tmpDir, `dune_askpass_${Date.now()}.bat`);

  try {
    fs.mkdirSync(keyDir, { recursive: true });

    // 1. Generate key pair
    log('Generating SSH key pair...\n');
    await new Promise((resolve, reject) => {
      const kg = spawnProc('ssh-keygen', ['-t', 'ed25519', '-f', tempKey, '-N', '', '-q', '-C', 'dune-server-manager'], {
        windowsHide: true, stdio: 'ignore',
      });
      kg.on('error', reject);
      kg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ssh-keygen exited ${code}`)));
    });

    // 2. Build the remote install command
    const pubKey = fs.readFileSync(tempKey + '.pub', 'utf8').trim();
    const b64Pub = Buffer.from(pubKey + '\n').toString('base64');
    const installSh = [
      'mkdir -p $HOME/.ssh',
      'chmod 700 $HOME/.ssh',
      `echo ${b64Pub} | base64 -d > $HOME/.ssh/authorized_keys`,
      'chmod 600 $HOME/.ssh/authorized_keys',
      'echo KEY_INSTALLED',
    ].join(' && ');

    // 3. Create askpass script that echoes the current password
    fs.writeFileSync(askpassFile, `@echo ${curPw}`);

    // 4. SSH with ASKPASS to install the public key
    log('Installing SSH key on VM (using current password)...\n');
    await new Promise((resolve, reject) => {
      const sshProc = spawnProc('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'LogLevel=QUIET',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'PreferredAuthentications=keyboard-interactive,password',
        '-o', 'ConnectTimeout=15',
        `dune@${ip}`,
        installSh,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SSH_ASKPASS: askpassFile,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: 'dummy',
        },
      });

      let out = '';
      sshProc.stdout.on('data', (d) => { out += d.toString(); log(d.toString()); });
      sshProc.stderr.on('data', (d) => { out += d.toString(); log(d.toString()); });

      const timer = setTimeout(() => { sshProc.kill(); reject(new Error('SSH key install timed out')); }, 60000);
      sshProc.on('error', (e) => { clearTimeout(timer); reject(e); });
      sshProc.on('close', (code) => {
        clearTimeout(timer);
        if (out.includes('KEY_INSTALLED')) resolve();
        else reject(new Error(`Key install failed (exit ${code}): ${out.slice(-200)}`));
      });
    });

    // Cleanup askpass
    try { fs.unlinkSync(askpassFile); } catch {}

    // 5. Verify the new key works
    log('Verifying key...\n');
    await new Promise((resolve, reject) => {
      const v = spawnProc('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'LogLevel=QUIET',
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-i', tempKey, `dune@${ip}`, 'echo VERIFY_OK',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      v.stdout.on('data', (d) => { out += d.toString(); });
      v.on('close', () => out.includes('VERIFY_OK') ? resolve() : reject(new Error('Key verification failed')));
      v.on('error', reject);
    });

    // 6. Move key into place
    try { fs.unlinkSync(keyPath); } catch {}
    try { fs.unlinkSync(keyPath + '.pub'); } catch {}
    fs.renameSync(tempKey, keyPath);
    fs.renameSync(tempKey + '.pub', keyPath + '.pub');
    log('SSH key installed.\n');

    // 7. Change password using the new key
    log('Changing password...\n');
    const b64Pw = Buffer.from(`dune:${newPassword}\n`).toString('base64');
    const pwOut = await ssh.run(ip, `echo ${b64Pw} | base64 -d | sudo -n chpasswd && echo PWOK`, null, { timeout: 30000 });
    if (!pwOut.includes('PWOK')) throw new Error('Password change failed');
    log('Password changed.\n');

    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    try { fs.unlinkSync(askpassFile); } catch {}
    try { fs.unlinkSync(tempKey); } catch {}
    try { fs.unlinkSync(tempKey + '.pub'); } catch {}
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 5 — Detect public IP from VM
app.post('/api/setup/detect-ip', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  let publicIp = null;
  for (const method of [
    () => ssh.run(ip, "wget -qO- --timeout=5 'https://api.ipify.org' 2>/dev/null"),
    () => ssh.run(ip, 'curl -s --max-time 5 https://api.ipify.org 2>/dev/null'),
    () => ps.run("(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 5).Content"),
  ]) {
    try {
      const out = await method();
      if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out.trim())) { publicIp = out.trim(); break; }
    } catch { /* try next */ }
  }
  res.json({ privateIp: ip, publicIp });
});

// Step 6 — Configure networking (DHCP or static) + set player IP + write token
app.post('/api/setup/network', async (req, res) => {
  const { ip, mode, staticIp, staticCidr, staticGw, staticDns, playerIp, token } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  let finalIp = ip;

  try {
    if (mode === 'static') {
      log('Applying static network config...\n');
      const iface = 'eth0';
      const cidr = staticCidr || '/24';
      const gw = staticGw;
      const dns = staticDns || '1.1.1.1';

      const ifContent = `auto lo\\niface lo inet loopback\\n\\nauto ${iface}\\niface ${iface} inet static\\n    address ${staticIp}${cidr}\\n    gateway ${gw}\\n`;
      const resolvContent = `nameserver ${dns}\\n`;
      const b64If = Buffer.from(ifContent.replace(/\\n/g, '\n')).toString('base64');
      const b64Resolv = Buffer.from(resolvContent.replace(/\\n/g, '\n')).toString('base64');

      const script = [
        `echo ${b64If} | base64 -d | sudo -n tee /etc/network/interfaces > /dev/null`,
        `echo ${b64Resolv} | base64 -d | sudo -n tee /etc/resolv.conf > /dev/null`,
        `echo APPLY_OK`,
        `nohup sudo -n sh -c 'sleep 2; rc-service networking restart' </dev/null >/dev/null 2>&1 &`,
      ].join(' && ');

      const out = await ssh.run(ip, script);
      if (!out.includes('APPLY_OK')) throw new Error('Failed to apply static config');

      log('Waiting for VM on new IP...\n');
      await new Promise((r) => setTimeout(r, 6000));

      let reachable = false;
      for (let i = 0; i < 30 && !reachable; i++) {
        try {
          await ssh.run(staticIp, 'true');
          reachable = true;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!reachable) throw new Error(`VM not reachable on ${staticIp}`);
      finalIp = staticIp;
      log(`VM now at ${finalIp}\n`);
    }

    // Write player IP to VM settings
    const pIp = playerIp || finalIp;
    log(`Setting player-facing IP to ${pIp}...\n`);
    await writeSettingsConfIp(finalIp, pIp);
    log('Player IP configured.\n');

    res.json({ success: true, vmIp: finalIp });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 7 — Upload bootstrap + run first-time setup on VM
app.post('/api/setup/bootstrap', async (req, res) => {
  const { ip, enableSwap, token, worldName, region } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  try {
    await runBootstrapSetup(ip, { token, worldName, region, enableSwap });
    cachedVmStatus = null;
    lastStatusResult = null;
    res.json({ success: true });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Repair incomplete install (empty namespace / no battlegroup CR)
app.post('/api/setup/repair', async (req, res) => {
  const { token, worldName, region, enableSwap } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('=== Repairing incomplete battlegroup setup ===\n');
    await cleanOrphanBattlegroupNamespaces(ip);
    await runBootstrapSetup(ip, { token, worldName, region, enableSwap });
    cachedVmStatus = null;
    lastStatusResult = null;
    res.json({ success: true });
  } catch (e) {
    log(`\nRepair error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Game config (UserGame.ini + UserEngine.ini)
// ---------------------------------------------------------------------------
const CONFIG_PATHS = {
  game: '/home/dune/.dune/download/scripts/setup/config/UserGame.ini',
  engine: '/home/dune/.dune/download/scripts/setup/config/UserEngine.ini',
};

function parseIni(raw) {
  const result = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) continue;
    // Parse both active and commented-out key=value lines
    let active = true;
    let content = trimmed;
    if (trimmed.startsWith(';')) {
      // Only parse as a commented key=value if it looks like one (no spaces before =)
      const rest = trimmed.slice(1).trim();
      if (!/^[A-Za-z]/.test(rest)) continue; // pure comment
      const eq = rest.indexOf('=');
      if (eq === -1) continue;
      active = false;
      content = rest;
    }
    const eq = content.indexOf('=');
    if (eq === -1) continue;
    const key = content.slice(0, eq).trim();
    if (active) {
      result[key] = content.slice(eq + 1).trim();
    } else if (!(key in result)) {
      // Commented-out values shown as empty so UI knows the key exists but is off
      result[key] = '';
    }
  }
  return result;
}

function applyToIni(raw, updates) {
  const lines = raw.split('\n');
  const applied = new Set();
  const quotedKeys = new Set(['Bgd.ServerDisplayName', 'Bgd.ServerLoginPassword']);

  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) return line;

    let content = trimmed;
    if (trimmed.startsWith(';')) {
      content = trimmed.slice(1).trim();
      if (!/^[A-Za-z]/.test(content)) return line;
    }
    const eq = content.indexOf('=');
    if (eq === -1) return line;
    const key = content.slice(0, eq).trim();

    if (key in updates) {
      applied.add(key);
      const val = updates[key];
      if (!val && val !== '0' && val !== 0) {
        // Empty value → comment out the line
        const defaultVal = content.slice(eq + 1).trim();
        return `;${key}=${defaultVal || '""'}`;
      }
      // Wrap in quotes if this key expects quoted values
      const formatted = quotedKeys.has(key) && !String(val).startsWith('"')
        ? `"${val}"` : String(val);
      return `${key}=${formatted}`;
    }
    return line;
  });

  // Append any keys that weren't found in the file
  for (const [key, val] of Object.entries(updates)) {
    if (applied.has(key) || (!val && val !== '0' && val !== 0)) continue;
    const formatted = quotedKeys.has(key) && !String(val).startsWith('"')
      ? `"${val}"` : String(val);
    result.push(`${key}=${formatted}`);
  }

  return result.join('\n');
}

app.get('/api/config', async (_req, res) => {
  const vmIp = await getVmIp();
  if (!vmIp) return res.status(400).json({ error: 'VM not running' });

  try {
    const [gameRaw, engineRaw] = await Promise.all([
      ssh.run(vmIp, `cat ${CONFIG_PATHS.game} 2>/dev/null`, null, { timeout: 15000 }),
      ssh.run(vmIp, `cat ${CONFIG_PATHS.engine} 2>/dev/null`, null, { timeout: 15000 }),
    ]);
    res.json({
      game: parseIni(gameRaw),
      engine: parseIni(engineRaw),
      rawGame: gameRaw,
      rawEngine: engineRaw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', async (req, res) => {
  const { game, engine } = req.body;
  const vmIp = await getVmIp();
  if (!vmIp) return res.status(400).json({ error: 'VM not running' });

  try {
    // Read current files, apply changes, write back
    const [gameRaw, engineRaw] = await Promise.all([
      ssh.run(vmIp, `cat ${CONFIG_PATHS.game} 2>/dev/null`, null, { timeout: 15000 }),
      ssh.run(vmIp, `cat ${CONFIG_PATHS.engine} 2>/dev/null`, null, { timeout: 15000 }),
    ]);

    if (game && Object.keys(game).length) {
      const updated = applyToIni(gameRaw, game);
      const b64 = Buffer.from(updated).toString('base64');
      await ssh.run(vmIp, `echo '${b64}' | base64 -d > ${CONFIG_PATHS.game}`, null, { timeout: 15000 });
    }

    if (engine && Object.keys(engine).length) {
      const updated = applyToIni(engineRaw, engine);
      const b64 = Buffer.from(updated).toString('base64');
      await ssh.run(vmIp, `echo '${b64}' | base64 -d > ${CONFIG_PATHS.engine}`, null, { timeout: 15000 });
    }

    // Deploy INI files to the Kubernetes pods so game servers pick them up
    log('Deploying settings to battlegroup pods…\n');
    const applyOut = await ssh.run(vmIp,
      '/home/dune/.dune/bin/battlegroup apply-default-usersettings 2>&1',
      null, { timeout: 30000 });
    log(applyOut + '\n');

    log('Config saved and deployed. Stop & start the battlegroup to apply changes.\n');
    res.json({ success: true });
  } catch (e) {
    log(`Config save error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Character Editor
// ---------------------------------------------------------------------------

let dbPodCache = null;
let dbPodCacheTime = 0;

async function getDbPod(vmIp) {
  if (dbPodCache && Date.now() - dbPodCacheTime < 120000) return dbPodCache;
  const raw = await ssh.run(vmIp,
    "sudo kubectl get pods --all-namespaces --no-headers 2>/dev/null | grep 'db-dbdepl-sts.*Running'",
    null, { timeout: 15000 }
  );
  const line = raw.trim().split('\n')[0];
  if (!line) throw new Error('Database pod not found — is the VM fully booted?');
  const parts = line.trim().split(/\s+/);
  dbPodCache = { ns: parts[0], name: parts[1] };
  dbPodCacheTime = Date.now();
  return dbPodCache;
}

async function runPsql(vmIp, sql, opts = {}) {
  const { ns, name } = await getDbPod(vmIp);
  const remoteCmd =
    `sudo kubectl exec -i -n ${ns} ${name} -- psql -U dune -d dune -p 15432 -t -A 2>&1`;
  // Pipe SQL via SSH stdin — embedding large queries in the command line hits
  // Windows ENAMETOOLONG (e.g. unlock-all cosmetics with 600+ IDs).
  return ssh.run(vmIp, remoteCmd, null, {
    timeout: opts.timeout || 60000,
    stdin: sql,
  });
}

app.get('/api/characters', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const raw = await runPsql(ip,
      "SELECT json_agg(row_to_json(t)) FROM (" +
      "SELECT eps.player_pawn_id as id, decrypt_user_data(eps.encrypted_character_name) as name " +
      "FROM encrypted_player_state eps " +
      "WHERE eps.player_pawn_id IS NOT NULL " +
      "ORDER BY eps.player_pawn_id) t"
    );
    res.json({ characters: JSON.parse(raw.trim()) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/characters/:id', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const propsRaw = await runPsql(ip, `SELECT properties::text FROM actors WHERE id = ${id}`);
    const gasRaw = await runPsql(ip, `SELECT gas_attributes::text FROM actors WHERE id = ${id}`);

    const invRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT id, inventory_type, max_item_count FROM inventories WHERE actor_id = ${id} AND inventory_type IS NOT NULL ORDER BY id) t`
    );

    const itemsRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT i.id, i.inventory_id, i.template_id, i.stack_size, i.position_index, inv.inventory_type ` +
      `FROM items i JOIN inventories inv ON i.inventory_id = inv.id ` +
      `WHERE inv.actor_id = ${id} ORDER BY inv.inventory_type, i.position_index) t`
    );

    res.json({
      actorId: id,
      properties: JSON.parse(propsRaw.trim() || '{}'),
      gasAttributes: JSON.parse(gasRaw.trim() || '{}'),
      inventories: JSON.parse(invRaw.trim()) || [],
      items: JSON.parse(itemsRaw.trim()) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/characters/:id/stats', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { updates } = req.body;
  if (!updates || !updates.length) return res.status(400).json({ error: 'No updates' });

  try {
    const propUpdates = updates.filter(u => u.field === 'properties');
    const gasUpdates = updates.filter(u => u.field === 'gas_attributes');

    if (propUpdates.length) {
      let expr = 'properties';
      for (const u of propUpdates) {
        const pathStr = '{' + u.path.join(',') + '}';
        expr = `jsonb_set(${expr}, '${pathStr}', '${JSON.stringify(u.value)}'::jsonb)`;
      }
      await runPsql(ip, `UPDATE actors SET properties = ${expr} WHERE id = ${id}`);
    }

    if (gasUpdates.length) {
      let expr = 'gas_attributes';
      for (const u of gasUpdates) {
        const pathStr = '{' + u.path.join(',') + '}';
        expr = `jsonb_set(${expr}, '${pathStr}', '${JSON.stringify(u.value)}'::jsonb)`;
      }
      await runPsql(ip, `UPDATE actors SET gas_attributes = ${expr} WHERE id = ${id}`);
    }

    log(`Character ${id} stats updated.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/characters/:id/inventory/add', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const actorId = parseInt(req.params.id);
  const { templateId, stackSize, inventoryId, isEquipment } = req.body;

  if (!templateId || !stackSize || !inventoryId) {
    return res.status(400).json({ error: 'templateId, stackSize, and inventoryId required' });
  }

  const safeId = templateId.replace(/'/g, "''");
  const stats = isEquipment
    ? '{"FCustomizationStats": [[], {}], "FItemStackAndDurabilityStats": [[], {}]}'
    : '{"FItemStackAndDurabilityStats": [[], {"DecayedMaxDurability": 0.0}]}';

  try {
    const posRaw = await runPsql(ip,
      `SELECT COALESCE(MAX(position_index) + 1, 0) FROM items WHERE inventory_id = ${inventoryId}`
    );
    const nextPos = parseInt(posRaw.trim()) || 0;

    await runPsql(ip,
      `INSERT INTO items (inventory_id, template_id, stack_size, position_index, stats) ` +
      `VALUES (${inventoryId}, '${safeId}', ${parseInt(stackSize)}, ${nextPos}, '${stats}'::jsonb)`
    );

    log(`Added ${stackSize}x ${templateId} to inventory.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlock all tech tree recipes
app.post('/api/characters/:id/tech/unlock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    await runPsql(ip,
      `UPDATE actors SET properties = jsonb_set(` +
      `properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', ` +
      `(SELECT jsonb_agg(CASE WHEN elem->>'UnlockedState' = 'NotPurchased' ` +
      `THEN jsonb_set(elem, '{UnlockedState}', '"Purchased"') ELSE elem END) ` +
      `FROM jsonb_array_elements(properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData') as elem)` +
      `) WHERE id = ${id}`
    );
    log(`All tech tree recipes unlocked for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lock all tech tree recipes (reset)
app.post('/api/characters/:id/tech/lock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    await runPsql(ip,
      `UPDATE actors SET properties = jsonb_set(` +
      `properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', ` +
      `(SELECT jsonb_agg(jsonb_set(elem, '{UnlockedState}', '"NotPurchased"')) ` +
      `FROM jsonb_array_elements(properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData') as elem)` +
      `) WHERE id = ${id}`
    );
    log(`All tech tree recipes locked for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get cosmetics list
app.get('/api/characters/:id/cosmetics', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const raw = await runPsql(ip,
      `SELECT COALESCE(json_agg(elem->>'m_CustomizationId' ORDER BY elem->>'m_CustomizationId'), '[]') ` +
      `FROM (SELECT jsonb_array_elements(properties->'CustomizationLibraryActorComponent'` +
      `->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') as elem ` +
      `FROM actors WHERE id = ${id}) sub`
    );
    res.json({ cosmetics: JSON.parse(raw.trim()) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add cosmetic
app.post('/api/characters/:id/cosmetics/add', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { cosmeticId } = req.body;
  if (!cosmeticId) return res.status(400).json({ error: 'cosmeticId required' });

  const safe = cosmeticId.replace(/[^a-zA-Z0-9_ ]/g, '');
  try {
    await runPsql(ip,
      `UPDATE actors SET properties = jsonb_set(properties, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `(properties->'CustomizationLibraryActorComponent'->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') ` +
      `|| '[{"m_CustomizationId": "${safe.replace(/'/g, "''")}"}]'::jsonb` +
      `) WHERE id = ${id}`
    );
    log(`Cosmetic "${safe}" added to character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove cosmetic
app.post('/api/characters/:id/cosmetics/remove', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { cosmeticId } = req.body;
  if (!cosmeticId) return res.status(400).json({ error: 'cosmeticId required' });

  const safe = cosmeticId.replace(/[^a-zA-Z0-9_ ]/g, '');
  try {
    await runPsql(ip,
      `UPDATE actors SET properties = jsonb_set(properties, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `(SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) FROM jsonb_array_elements(` +
      `properties->'CustomizationLibraryActorComponent'->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds'` +
      `) as elem WHERE elem->>'m_CustomizationId' != '${safe.replace(/'/g, "''")}')` +
      `) WHERE id = ${id}`
    );
    log(`Cosmetic "${safe}" removed from character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function loadCosmeticCatalogIds() {
  const catalogPath = path.join(__dirname, 'public', 'data', 'cosmetic-catalog.json');
  const data = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  return Object.entries(data.cosmetics || {})
    .filter(([id, info]) => info.unlock !== 'inventory' && !id.startsWith('Swatch_'))
    .map(([id]) => id)
    .sort();
}

// Unlock all cosmetics from catalog (merge with existing)
app.post('/api/characters/:id/cosmetics/unlock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const catalogIds = loadCosmeticCatalogIds();
    const raw = await runPsql(ip,
      `SELECT COALESCE(json_agg(elem->>'m_CustomizationId' ORDER BY elem->>'m_CustomizationId'), '[]') ` +
      `FROM (SELECT jsonb_array_elements(properties->'CustomizationLibraryActorComponent'` +
      `->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') as elem ` +
      `FROM actors WHERE id = ${id}) sub`
    );
    const current = JSON.parse(raw.trim()) || [];
    const merged = [...new Set([...current, ...catalogIds])].sort();
    const payload = JSON.stringify(merged.map((cid) => ({ m_CustomizationId: cid })));
    const escaped = payload.replace(/'/g, "''");

    await runPsql(ip,
      `UPDATE actors SET properties = jsonb_set(properties, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `'${escaped}'::jsonb` +
      `) WHERE id = ${id}`,
      { timeout: 120000 }
    );
    log(`All ${merged.length} cosmetics unlocked for character ${id}.\n`);
    res.json({ success: true, total: merged.length, added: merged.length - current.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get specialization data
app.get('/api/characters/:id/specializations', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const pawnRow = await runPsql(ip,
      `SELECT player_controller_id FROM encrypted_player_state WHERE player_pawn_id = ${id}`
    );
    const controllerId = parseInt(pawnRow.trim());

    const tracksRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT track_type, xp_amount, level FROM specialization_tracks WHERE player_id = ${id} ORDER BY track_type) t`
    );

    const keystonesRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(km.name ORDER BY km.id), '[]') FROM purchased_specialization_keystones pk ` +
      `JOIN specialization_keystones_map km ON pk.keystone_id = km.id WHERE pk.player_id = ${id}`
    );

    const allKeystonesRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]') FROM (SELECT id, name FROM specialization_keystones_map ORDER BY id) t`
    );

    res.json({
      controllerId,
      tracks: JSON.parse(tracksRaw.trim()) || [],
      purchasedKeystones: JSON.parse(keystonesRaw.trim()) || [],
      allKeystones: JSON.parse(allKeystonesRaw.trim()) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set specialization track
app.post('/api/characters/:id/specializations/track', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { trackType, xp, level } = req.body;

  const validTracks = ['Combat', 'Crafting', 'Gathering', 'Exploration', 'Sabotage'];
  if (!validTracks.includes(trackType)) return res.status(400).json({ error: 'Invalid track type' });

  try {
    await runPsql(ip,
      `INSERT INTO specialization_tracks (player_id, track_type, xp_amount, level) ` +
      `VALUES (${id}, '${trackType}', ${parseInt(xp)}, ${parseFloat(level)}) ` +
      `ON CONFLICT (player_id, track_type) DO UPDATE SET xp_amount = EXCLUDED.xp_amount, level = EXCLUDED.level`
    );
    log(`Specialization ${trackType} set to level ${level} for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlock all keystones for a track
app.post('/api/characters/:id/specializations/unlock-keystones', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { trackPrefix } = req.body;

  const validPrefixes = ['Combat_', 'Crafting_', 'Exploration_', 'Gathering_', 'Sabotage_'];
  if (!validPrefixes.some(p => trackPrefix === p)) return res.status(400).json({ error: 'Invalid track prefix' });

  try {
    await runPsql(ip,
      `INSERT INTO purchased_specialization_keystones (player_id, keystone_id) ` +
      `SELECT ${id}, id FROM specialization_keystones_map WHERE name LIKE '${trackPrefix}%' ` +
      `ON CONFLICT DO NOTHING`
    );
    log(`All ${trackPrefix.replace('_', '')} keystones unlocked for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get currency and faction data
app.get('/api/characters/:id/economy', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const pawnRow = await runPsql(ip,
      `SELECT player_controller_id FROM encrypted_player_state WHERE player_pawn_id = ${id}`
    );
    const controllerId = parseInt(pawnRow.trim());

    const currencyRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT currency_id, balance FROM player_virtual_currency_balances WHERE player_controller_id = ${controllerId} ORDER BY currency_id) t`
    );

    const factionRepRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT fr.faction_id, f.name as faction_name, fr.reputation_amount ` +
      `FROM player_faction_reputation fr JOIN factions f ON fr.faction_id = f.id ` +
      `WHERE fr.actor_id = ${id} ORDER BY fr.faction_id) t`
    );

    const factionsRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (SELECT id, name FROM factions ORDER BY id) t`
    );

    res.json({
      controllerId,
      currency: JSON.parse(currencyRaw.trim()) || [],
      factionRep: JSON.parse(factionRepRaw.trim()) || [],
      factions: JSON.parse(factionsRaw.trim()) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set currency
app.post('/api/characters/:id/economy/currency', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { currencyId, balance } = req.body;

  try {
    const pawnRow = await runPsql(ip,
      `SELECT player_controller_id FROM encrypted_player_state WHERE player_pawn_id = ${id}`
    );
    const controllerId = parseInt(pawnRow.trim());

    await runPsql(ip,
      `INSERT INTO player_virtual_currency_balances (player_controller_id, currency_id, balance) ` +
      `VALUES (${controllerId}, ${parseInt(currencyId)}, ${parseInt(balance)}) ` +
      `ON CONFLICT (player_controller_id, currency_id) DO UPDATE SET balance = EXCLUDED.balance`
    );
    log(`Currency ${currencyId} set to ${balance} for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set faction reputation
app.post('/api/characters/:id/economy/reputation', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { factionId, amount } = req.body;

  try {
    await runPsql(ip,
      `INSERT INTO player_faction_reputation (actor_id, faction_id, reputation_amount) ` +
      `VALUES (${id}, ${parseInt(factionId)}, ${parseInt(amount)}) ` +
      `ON CONFLICT (actor_id, faction_id) DO UPDATE SET reputation_amount = EXCLUDED.reputation_amount`
    );
    log(`Faction ${factionId} reputation set to ${amount} for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/characters/:id/inventory/:itemId', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const itemId = parseInt(req.params.itemId);

  try {
    await runPsql(ip, `DELETE FROM items WHERE id = ${itemId}`);
    log(`Removed item ${itemId}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Server Visibility (LAN / Public)
// ---------------------------------------------------------------------------

app.get('/api/server-visibility', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const advertisedIp = await readSettingsConfIp(ip);
    const directorPort = await getDirectorPort(ip);

    // Detect public IP — try VM first, fall back to Windows host
    let publicIp = null;
    for (const method of [
      () => ssh.run(ip, 'curl -s --max-time 5 https://api.ipify.org 2>/dev/null', null, { timeout: 10000 }),
      () => ssh.run(ip, "wget -qO- --timeout=5 'https://api.ipify.org' 2>/dev/null", null, { timeout: 10000 }),
      () => ps.run("(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 5).Content"),
    ]) {
      try {
        const out = await method();
        if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out.trim())) { publicIp = out.trim(); break; }
      } catch { /* try next */ }
    }

    const isWan = advertisedIp && advertisedIp !== ip;

    res.json({
      advertisedIp,
      vmIp: ip,
      publicIp,
      directorPort,
      isWan,
      portForward: {
        targetIp: ip,
        ...PORT_FORWARD_INFO,
        directorTcp: directorPort,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/server-visibility', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const { advertisedIp } = req.body;
  if (!advertisedIp) return res.status(400).json({ error: 'advertisedIp required' });

  try {
    await writeSettingsConfIp(ip, advertisedIp.trim());
    visibilityManuallySet = true;
    const isWan = advertisedIp.trim() !== ip;
    log(`Server visibility IP set to ${advertisedIp}.\n`);
    if (isWan) {
      log(`WAN: forward TCP ${PORT_FORWARD_INFO.rmqTcp}, Director NodePort, and UDP ${PORT_FORWARD_INFO.gameUdpStart}-${PORT_FORWARD_INFO.gameUdpEnd} to VM ${ip}, then stop and start the battlegroup.\n`);
    } else {
      log('LAN mode: players on your local network can join. Stop and start the battlegroup to apply.\n');
    }
    log('Self-hosted worlds appear in-game under Servers → Experimental (not Official or Private).\n');
    res.json({
      success: true,
      isWan,
      requiresBattlegroupRestart: true,
      message: 'Stop the battlegroup completely, then start it again for the gateway to register the new address with Funcom.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Experimental: Multi-Sietch Management
// ---------------------------------------------------------------------------

async function getBattlegroupJson(ip) {
  const ns = await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.namespace' 2>/dev/null | head -1",
    null, { timeout: 15000 });
  const name = await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.name' 2>/dev/null | head -1",
    null, { timeout: 15000 });
  if (!ns || !name) throw new Error('Battlegroup not found');
  const raw = await ssh.run(ip,
    `sudo kubectl get battlegroups -n ${ns.trim()} ${name.trim()} -o json 2>/dev/null`,
    null, { timeout: 30000 });
  return { ns: ns.trim(), name: name.trim(), bg: JSON.parse(raw) };
}

app.get('/api/sietches', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;

    const survivalSets = sets
      .map((s, i) => ({ index: i, map: s.map, partitions: s.partitions, replicas: s.replicas, memory: s.resources?.limits?.memory || '?', dedicatedScaling: s.dedicatedScaling }))
      .filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);

    const maxPartitionId = Math.max(...worldPartitions.flatMap(w => w.partitions.map(p => p.id)));

    res.json({
      sietches: survivalSets,
      sietchCount: survivalSets.length,
      maxPartitionId,
      totalSets: sets.length,
      totalWorldPartitions: worldPartitions.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sietches/add', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { ns, name, bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;
    const grid = (bg.metadata.annotations.grid || '').split(',');

    const survivalSets = sets.filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);
    const currentCount = survivalSets.length;
    const maxPartitionId = Math.max(...worldPartitions.flatMap(w => w.partitions.map(p => p.id)));
    const newPartitionId = maxPartitionId + 1;
    const newSietchNum = currentCount + 1;

    log(`Adding sietch ${newSietchNum} (partition ${newPartitionId})...\n`);

    // Clone the first Survival_1 set as template
    const template = JSON.parse(JSON.stringify(sets.find(s => s.map === 'Survival_1' && !s.dedicatedScaling)));
    template.partitions = [newPartitionId];

    // Build patches
    const patches = [
      { op: 'add', path: '/spec/serverGroup/template/spec/sets/-', value: template },
      { op: 'add', path: '/spec/database/template/spec/deployment/spec/worldPartitions/-', value: {
        map: 'Survival_1',
        partitions: [{ dimension: 0, disable: false, id: newPartitionId, maxX: 1, maxY: 1, minX: 0, minY: 0 }]
      }},
      { op: 'replace', path: '/metadata/annotations/grid', value: [...grid, '1x1'].join(',') },
    ];

    const patchJson = JSON.stringify(patches);
    const b64 = Buffer.from(patchJson).toString('base64');

    await ssh.run(ip,
      `echo '${b64}' | base64 -d | sudo kubectl patch battlegroup ${name} -n ${ns} --type=json -p "$(echo '${b64}' | base64 -d)" 2>&1`,
      log, { timeout: 30000 });

    log(`\nSietch ${newSietchNum} added (partition ${newPartitionId}). Restart the battlegroup to apply.\n`);
    res.json({ success: true, sietchNumber: newSietchNum, partitionId: newPartitionId });
  } catch (e) {
    log(`Error adding sietch: ${e.message}\n`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sietches/remove', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { ns, name, bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;
    const grid = (bg.metadata.annotations.grid || '').split(',');

    // Find all Survival_1 sets (non-dedicatedScaling)
    const survivalIndices = sets
      .map((s, i) => ({ ...s, _idx: i }))
      .filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);

    if (survivalIndices.length <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last sietch' });
    }

    const lastSurvival = survivalIndices[survivalIndices.length - 1];
    const lastPartitionId = lastSurvival.partitions[0];

    // Find matching worldPartition entry
    const wpIdx = worldPartitions.findIndex(w =>
      w.map === 'Survival_1' && w.partitions.some(p => p.id === lastPartitionId));

    log(`Removing sietch ${survivalIndices.length} (partition ${lastPartitionId})...\n`);

    // Build patches (remove in reverse index order to avoid shifting)
    const patches = [];
    patches.push({ op: 'remove', path: `/spec/serverGroup/template/spec/sets/${lastSurvival._idx}` });
    if (wpIdx >= 0) {
      patches.push({ op: 'remove', path: `/spec/database/template/spec/deployment/spec/worldPartitions/${wpIdx}` });
    }
    if (grid.length > 1) {
      patches.push({ op: 'replace', path: '/metadata/annotations/grid', value: grid.slice(0, -1).join(',') });
    }

    // Sort patches so higher indices are removed first
    patches.sort((a, b) => (b.path > a.path ? 1 : -1));

    const patchJson = JSON.stringify(patches);
    const b64 = Buffer.from(patchJson).toString('base64');

    await ssh.run(ip,
      `echo '${b64}' | base64 -d | sudo kubectl patch battlegroup ${name} -n ${ns} --type=json -p "$(echo '${b64}' | base64 -d)" 2>&1`,
      log, { timeout: 30000 });

    log(`\nSietch removed. Restart the battlegroup to apply.\n`);
    res.json({ success: true, removedPartition: lastPartitionId, remainingSietches: survivalIndices.length - 1 });
  } catch (e) {
    log(`Error removing sietch: ${e.message}\n`);
    res.status(500).json({ error: e.message });
  }
});

// --- Static UI (after all API routes) ---
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'API endpoint not found. Stop and restart the Server Manager (start_as_admin.bat) to load updates.',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- SPA fallback ---
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Dune Server Manager running at http://localhost:${PORT}`);
});
