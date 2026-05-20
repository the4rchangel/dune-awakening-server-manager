const express = require('express');
const http = require('http');
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
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// --- Status ---
app.get('/api/status', async (_req, res) => {
  const vm = await getVmStatus();
  let bg = null;
  let directorPort = null;

  if (vm.exists && vm.state === 'Running' && vm.ip) {
    try {
      const raw = await ssh.run(vm.ip, '/home/dune/.dune/bin/battlegroup status 2>&1', null, { timeout: 30000, tty: true });
      bg = { running: true, output: raw };
    } catch (e) {
      bg = { running: false, output: e.stdout || e.message };
    }
    directorPort = await getDirectorPort(vm.ip);
  }

  res.json({
    vm,
    battlegroup: bg,
    links: vm.ip ? {
      fileBrowser: `http://${vm.ip}:18888/`,
      director: directorPort ? `http://${vm.ip}:${directorPort}/` : null,
    } : null,
  });
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
function bgRoute(action, label, timeoutMs) {
  app.post(`/api/bg/${action}`, async (_req, res) => {
    const ip = await getVmIp();
    if (!ip) return res.status(400).json({ error: 'VM not running' });

    try {
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
      log(`Error: ${e.message}\n`);
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

  try {
    const publicIp = await ssh.run(ip, "wget -qO- --timeout=5 'https://api.ipify.org' 2>/dev/null");
    res.json({ privateIp: ip, publicIp: publicIp.trim() || null });
  } catch {
    res.json({ privateIp: ip, publicIp: null });
  }
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
    await ssh.run(finalIp, `printf '\\n\\n\\n${pIp}\\n' > /home/dune/.dune/settings.conf`);
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
    // Upload bootstrap
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

    // Run setup — feed all interactive answers via stdin
    // Prompt order: 1) world name, 2) region (1-5), 3) token
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

    // Optional swap
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

    cachedVmStatus = null;
    res.json({ success: true });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
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
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

function applyToIni(raw, updates) {
  const lines = raw.split('\n');
  const applied = new Set();
  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      applied.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
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

    log('Config saved. Restart the battlegroup to apply changes.\n');
    res.json({ success: true });
  } catch (e) {
    log(`Config save error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Fallback ---
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Dune Server Manager running at http://localhost:${PORT}`);
});
