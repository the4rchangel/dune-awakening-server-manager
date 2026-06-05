(() => {
  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const vmChip        = $('#vm-chip');
  const bgChip        = $('#bg-chip');
  const vmBadge       = $('#vm-badge');
  const bgBadge       = $('#bg-badge');
  const vmState       = $('#vm-state');
  const vmIp          = $('#vm-ip');
  const vmMemory      = $('#vm-memory');
  const vmUptime      = $('#vm-uptime');
  const bgStatusText  = $('#bg-status-text');
  const consoleOut    = $('#console-output');
  const consoleToggle = $('#console-toggle');
  const consoleWrap   = $('#console-wrapper');
  const consoleBadge  = $('#console-badge');
  const overlay       = $('#overlay');
  const overlayText   = $('#overlay-text');
  const linkFB        = $('#link-filebrowser');
  const linkDir       = $('#link-director');
  const monFB         = $('#mon-filebrowser');
  const monDir        = $('#mon-director');

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let status = null;
  let busy = false;

  // -----------------------------------------------------------------------
  // Tabs
  // -----------------------------------------------------------------------
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // -----------------------------------------------------------------------
  // Console
  // -----------------------------------------------------------------------
  consoleWrap.classList.add('collapsed');

  consoleToggle.addEventListener('click', () => {
    consoleWrap.classList.toggle('collapsed');
    consoleBadge.hidden = true;
  });

  function appendConsole(text) {
    consoleOut.textContent += text;
    consoleOut.parentElement.scrollTop = consoleOut.parentElement.scrollHeight;
    if (consoleWrap.classList.contains('collapsed')) {
      consoleBadge.hidden = false;
    }
  }

  function expandConsole() {
    consoleWrap.classList.remove('collapsed');
    consoleBadge.hidden = true;
  }

  // -----------------------------------------------------------------------
  // Setup log pipe (defined early so WS handler can call it)
  // -----------------------------------------------------------------------
  let wizStep = 1;
  function pipeToSetupLog(text) {
    if (wizStep === 3) {
      const el = $('#setup-log');
      if (el) { el.textContent += text; el.scrollTop = el.scrollHeight; }
    } else if (wizStep === 6) {
      const el = $('#bootstrap-log');
      if (el) { el.textContent += text; el.scrollTop = el.scrollHeight; }
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------
  let ws;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
          appendConsole(msg.data);
          pipeToSetupLog(msg.data);
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }
  connectWs();

  // -----------------------------------------------------------------------
  // API helpers
  // -----------------------------------------------------------------------
  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api/${path}`, opts);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        res.ok
          ? 'Invalid JSON from server'
          : `Server error (${res.status}): ${text.startsWith('<!') ? 'endpoint missing or manager needs restart' : text.slice(0, 120)}`
      );
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.startFailed = data.startFailed;
      err.attemptedGB = data.attemptedGB;
      throw err;
    }
    return data;
  }

  function showOverlay(text) {
    overlayText.textContent = text;
    overlay.hidden = false;
    busy = true;
  }

  function hideOverlay() {
    overlay.hidden = true;
    busy = false;
  }

  async function runAction(path, label, body) {
    if (busy) return;
    showOverlay(label + '...');
    appendConsole(`\n> ${label}\n`);
    try {
      await api('POST', path, body);
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
      expandConsole();
      alert(`${label} failed: ${e.message}`);
    }
    hideOverlay();
    refreshStatus();
  }

  async function startVmAction(memoryGB) {
    if (busy) return;
    const vmRetryPanel = $('#vm-start-retry');
    if (vmRetryPanel) vmRetryPanel.hidden = true;

    showOverlay('Starting VM...');
    appendConsole('\n> Starting VM\n');
    expandConsole();

    try {
      const body = memoryGB ? { memoryGB } : undefined;
      const result = await api('POST', 'vm/start', body);
      if (result.memoryGB) {
        appendConsole(`VM started with ${result.memoryGB} GB RAM.\n`);
      }
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
      expandConsole();
      alert('Failed to start VM: ' + e.message);
      if (e.startFailed || e.status === 507) {
        if (vmRetryPanel) vmRetryPanel.hidden = false;
      }
    }

    hideOverlay();
    refreshStatus();
  }

  // -----------------------------------------------------------------------
  // Status refresh
  // -----------------------------------------------------------------------
  function applyStatus(s) {
    status = s;
    const vm = s.vm || {};
    const bg = s.battlegroup;
    const links = s.links || {};

    // VM card
    const running = vm.exists && vm.state === 'Running';
    const stopped = vm.exists && vm.state !== 'Running';
    const missing = !vm.exists;

    vmState.textContent  = vm.exists ? vm.state : 'Not Found';
    vmIp.textContent     = vm.ip || '—';
    if (running && vm.memoryMB) {
      vmMemory.textContent = `${Math.round(vm.memoryMB)} MB`;
    } else if (vm.startupMemoryMB) {
      vmMemory.textContent = `${Math.round(vm.startupMemoryMB / 1024)} GB configured`;
    } else {
      vmMemory.textContent = '—';
    }
    vmUptime.textContent = vm.uptime || '—';

    vmBadge.textContent = running ? 'Running' : stopped ? vm.state : 'Not Found';
    vmBadge.className   = `badge ${running ? 'running' : stopped ? 'stopped' : ''}`;

    vmChip.className  = `status-chip ${running ? 'running' : stopped ? 'stopped' : 'unknown'}`;
    $('#vm-chip-state').textContent = running ? vm.ip || 'Running' : vm.exists ? vm.state : '—';

    $('#btn-vm-start').disabled = busy || running || missing;
    $('#btn-vm-stop').disabled  = busy || !running;

    // Battlegroup card
    const bgUp = bg && bg.running;
    bgBadge.textContent = !running ? 'VM Off' : bgUp ? 'Active' : 'Inactive';
    bgBadge.className   = `badge ${!running ? '' : bgUp ? 'running' : 'stopped'}`;
    bgChip.className    = `status-chip ${!running ? 'unknown' : bgUp ? 'running' : 'stopped'}`;
    $('#bg-chip-state').textContent = !running ? '—' : bgUp ? 'Active' : 'Inactive';
    bgStatusText.textContent = bg ? bg.output || 'No details' : 'VM not running';

    const bgBtns = ['btn-bg-start', 'btn-bg-restart', 'btn-bg-stop', 'btn-bg-update'];
    bgBtns.forEach((id) => { $(`#${id}`).disabled = busy || !running; });

    // All data-action buttons
    $$('[data-action]').forEach((btn) => { btn.disabled = busy || !running; });

    // Links
    function setLink(el, url) {
      if (url) {
        el.href = url;
        el.classList.remove('disabled');
        el.removeAttribute('data-nolink');
      } else {
        el.removeAttribute('href');
        el.classList.add('disabled');
        el.setAttribute('data-nolink', '1');
      }
    }
    setLink(linkFB, links.fileBrowser);
    setLink(linkDir, links.director);
    setLink(monFB, links.fileBrowser);
    setLink(monDir, links.director);

    // Settings buttons
    $('#btn-rotate-key').disabled = busy || !running;

    // Config warning banner
    const cw = $('#config-warning');
    if (cw) {
      if (bgUp) {
        cw.classList.remove('ok');
        cw.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span><strong>Battlegroup is running.</strong> Stop it before editing. Changes apply on next start.</span>';
      } else {
        cw.classList.add('ok');
        cw.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2.5 2.5L16 9"/></svg><span><strong>Battlegroup is offline.</strong> Safe to edit. Changes will apply on next start.</span>';
      }
    }

    const repairPanel = $('#repair-bootstrap-panel');
    if (repairPanel) {
      const needsRepair = running && bg && bg.needsBootstrap;
      repairPanel.hidden = !needsRepair;
      $('#btn-repair-bootstrap').disabled = busy || !needsRepair;
    }

    const vmRetryPanel = $('#vm-start-retry');
    if (vmRetryPanel && running) vmRetryPanel.hidden = true;
  }

  async function refreshStatus() {
    try {
      const s = await api('GET', 'status');
      applyStatus(s);
    } catch { /* silent */ }
  }

  refreshStatus();
  setInterval(refreshStatus, 3000);

  // -----------------------------------------------------------------------
  // Setup Wizard
  // -----------------------------------------------------------------------
  let wizData = {};

  const wizNext = $('#wiz-next');
  const wizBack = $('#wiz-back');
  const wizBadge = $('#setup-step-badge');
  const wizFill = $('#wizard-progress-fill');

  function showWizStep(n) {
    wizStep = n;
    $$('.wizard-step').forEach((s) => s.classList.remove('active'));
    const el = $(`#wiz-step-${n}`);
    if (el) el.classList.add('active');
    wizBadge.textContent = n <= 6 ? `Step ${n} of 6` : 'Complete';
    wizFill.style.width = `${Math.min((n / 6) * 100, 100)}%`;
    wizBack.hidden = n <= 1 || n >= 7;
    wizNext.hidden = n >= 7;
    wizNext.textContent = n === 6 ? 'Finish Setup' : 'Next';
    if (n === 7) {
      wizNext.hidden = true;
      wizBack.hidden = true;
    }
    if (n === 5) updateSetupPortForwardPanel();
  }

  // Retry start with different memory
  $('#btn-retry-start').addEventListener('click', async () => {
    const memGB = parseInt($('#retry-memory').value, 10);
    const logEl = $('#setup-log');
    const spinner = $('#setup-spinner');
    const retryPanel = $('#retry-start');

    spinner.hidden = false;
    retryPanel.hidden = true;
    $('#btn-retry-start').disabled = true;

    try {
      const result = await api('POST', 'setup/retry-start', { memoryGB: memGB });
      if (result.success) {
        wizData.ip = result.ip;
        wizData.memoryGB = memGB;
        logEl.textContent += `\nVM ready at ${result.ip}\n`;
        spinner.hidden = true;
        wizNext.disabled = false;
        if (memGB < 20) $('#setup-swap').checked = true;
      } else {
        throw new Error(result.error || 'Start failed');
      }
    } catch (e) {
      logEl.textContent += `\nError: ${e.message}\n`;
      spinner.hidden = true;
      retryPanel.hidden = false;
      $('#btn-retry-start').disabled = false;
    }
  });

  // Preflight
  let preflightPassed = false;
  let preflightData = null;

  function applyPreflightResults(data) {
    preflightData = data;

    function mark(id, ok) {
      const el = $(id);
      el.classList.toggle('pass', ok);
      el.classList.toggle('fail', !ok);
      el.querySelector('.pf-icon').textContent = ok ? '\u2705' : '\u274C';
    }
    mark('#pf-hyperv', data.hyperv);
    mark('#pf-vmcx', data.vmcxFound);
    mark('#pf-drives', data.drives && data.drives.length > 0);

    preflightPassed = data.hyperv && data.vmcxFound && data.drives && data.drives.length > 0;

    const resetPanel = $('#setup-reset-panel');
    const resetDesc = $('#setup-reset-desc');
    if (resetPanel) {
      if (data.vmExists) {
        resetPanel.hidden = false;
        if (resetDesc) {
          resetDesc.textContent = data.vmState
            ? `VM "dune-awakening" exists (${data.vmState}). Delete everything below to run setup again from scratch.`
            : 'VM "dune-awakening" exists. Delete everything below to run setup again from scratch.';
        }
      } else {
        resetPanel.hidden = true;
      }
    }

    if (preflightPassed) {
      const sel = $('#setup-drive');
      sel.innerHTML = '';
      data.drives.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = `${d.name}: — ${d.freeGB} GB free`;
        sel.appendChild(opt);
      });

      if (data.nics && data.nics.length > 0) {
        const nicSel = $('#setup-nic');
        nicSel.innerHTML = '';
        data.nics.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = n.name;
          opt.textContent = `${n.name} (${n.desc})`;
          nicSel.appendChild(opt);
        });
      }
    }
  }

  async function runPreflight() {
    $('#btn-preflight').disabled = true;
    $('#btn-preflight').textContent = 'Checking...';
    try {
      applyPreflightResults(await api('GET', 'setup/preflight'));
    } catch (e) {
      appendConsole(`Preflight error: ${e.message}\n`);
    }
    $('#btn-preflight').disabled = false;
    $('#btn-preflight').textContent = 'Run Checks';
  }

  $('#btn-preflight').addEventListener('click', runPreflight);

  document.querySelector('.tab[data-tab="setup"]')?.addEventListener('click', () => {
    if (!preflightData) runPreflight();
  });

  $('#btn-setup-reset').addEventListener('click', async () => {
    if (busy) return;

    const msg =
      'This permanently deletes your Dune VM, all battlegroup/world data inside it, ' +
      'install folders, and SSH keys.\n\n' +
      'Export a database backup first if you need to keep your world.\n\n' +
      'Type DELETE to confirm.';
    const typed = prompt(msg);
    if (typed !== 'DELETE') {
      if (typed !== null) alert('Reset cancelled — you must type DELETE exactly.');
      return;
    }

    busy = true;
    showOverlay('Deleting existing installation...');
    try {
      const res = await api('POST', 'setup/reset');
      if (!res.success) throw new Error(res.error || 'Reset failed');

      wizData = {};
      preflightPassed = false;
      showWizStep(1);
      $('#setup-log').textContent = '';
      $('#bootstrap-log').textContent = '';
      appendConsole('Installation reset complete. Run pre-flight checks to begin a fresh setup.\n');
      cachedVmStatus = null;
      await runPreflight();
      refreshStatus();
    } catch (e) {
      alert('Reset failed: ' + e.message);
      appendConsole(`Reset error: ${e.message}\n`);
    }
    hideOverlay();
    busy = false;
  });

  // Show/hide NIC field based on network mode
  document.addEventListener('change', (e) => {
    if (e.target.id === 'setup-network') {
      $('#nic-field').style.display = e.target.value === 'external' ? '' : 'none';
    }
    if (e.target.id === 'setup-ip-mode') {
      $('#static-fields').style.display = e.target.value === 'static' ? '' : 'none';
    }
    if (e.target.name === 'playerIpChoice') {
      $('#setup-player-ip-manual').style.display = e.target.value === 'manual' ? '' : 'none';
      updateSetupPortForwardPanel();
    }
  });

  // Next / Back
  wizBack.addEventListener('click', () => {
    if (wizStep > 1) showWizStep(wizStep - 1);
  });

  wizNext.addEventListener('click', async () => {
    if (busy) return;

    // Validate and execute per step
    if (wizStep === 1) {
      if (!preflightPassed) {
        alert('Pre-flight checks must pass before continuing. Click "Run Checks".');
        return;
      }
      if (preflightData && preflightData.vmExists) {
        if (!confirm(
          'A VM already exists. Continuing will replace it during import, but SSH keys may be stale.\n\n' +
          'For a clean reinstall, use "Delete & Start Fresh" on step 1 instead.\n\nContinue anyway?'
        )) return;
      }
      showWizStep(2);

    } else if (wizStep === 2) {
      const token = $('#setup-token').value.trim();
      if (!token) { alert('Server token is required. Get one from account.duneawakening.com'); return; }
      wizData.token = token;
      wizData.drive = $('#setup-drive').value;
      wizData.memoryGB = parseInt($('#setup-memory').value, 10);
      wizData.networkMode = $('#setup-network').value;
      wizData.nicName = wizData.networkMode === 'external' ? $('#setup-nic').value : null;
      if (wizData.memoryGB < 20) {
        $('#setup-swap').checked = true;
      }
      showWizStep(3);

      // Auto-run import
      const logEl = $('#setup-log');
      const spinner = $('#setup-spinner');
      const retryPanel = $('#retry-start');
      logEl.textContent = '';
      spinner.hidden = false;
      retryPanel.hidden = true;
      wizNext.disabled = true;

      try {
        const result = await api('POST', 'setup/import', {
          drive: wizData.drive,
          memoryGB: wizData.memoryGB,
          networkMode: wizData.networkMode,
          nicName: wizData.nicName,
        });
        if (result.success) {
          wizData.ip = result.ip;
          logEl.textContent += `\nVM ready at ${result.ip}\n`;
          spinner.hidden = true;
          wizNext.disabled = false;
        } else if (result.imported && result.startFailed) {
          spinner.hidden = true;
          retryPanel.hidden = false;
        } else {
          throw new Error(result.error || 'Import failed');
        }
      } catch (e) {
        logEl.textContent += `\nError: ${e.message}\n`;
        spinner.hidden = true;
        wizNext.disabled = false;
      }

    } else if (wizStep === 3) {
      if (!wizData.ip) { alert('VM must be running before continuing. If the start failed, use Retry Start below.'); return; }
      showWizStep(4);

    } else if (wizStep === 4) {
      const curPw = $('#setup-curpw').value || 'dune';
      const pw = $('#setup-pw').value;
      const pw2 = $('#setup-pw2').value;
      if (!pw) { alert('New password required.'); return; }
      if (pw !== pw2) { alert('Passwords do not match.'); return; }

      showOverlay('Installing SSH key and changing password...');
      try {
        const res = await api('POST', 'setup/security', {
          ip: wizData.ip,
          currentPassword: curPw,
          newPassword: pw,
        });
        if (!res.success) throw new Error(res.error || 'Security setup failed');
        appendConsole('SSH key installed and password changed.\n');
      } catch (e) {
        appendConsole(`Security setup error: ${e.message}\n`);
        hideOverlay();
        alert('Failed: ' + e.message + '. Check the console for details.');
        return;
      }
      hideOverlay();
      showWizStep(5);

      // Detect IPs
      try {
        const ips = await api('POST', 'setup/detect-ip', { ip: wizData.ip });
        wizData.publicIp = ips.publicIp;
        wizData.privateIp = ips.privateIp;
        $('#opt-public').textContent = ips.publicIp
          ? `Public IP: ${ips.publicIp} (requires port forwarding)`
          : 'Public IP: not detected';
        $('#opt-private').textContent = `Private IP: ${ips.privateIp} (LAN only)`;
        if (!ips.publicIp) {
          document.querySelector('input[name="playerIpChoice"][value="private"]').checked = true;
        }
        updateSetupPortForwardPanel();
      } catch { /* ignore */ }

    } else if (wizStep === 5) {
      const ipMode = $('#setup-ip-mode').value;
      const choice = document.querySelector('input[name="playerIpChoice"]:checked').value;
      let playerIp;
      if (choice === 'public') playerIp = wizData.publicIp;
      else if (choice === 'private') playerIp = wizData.privateIp || wizData.ip;
      else playerIp = $('#setup-player-ip-manual').value;

      if (!playerIp) { alert('Please enter a player-facing IP.'); return; }

      showOverlay('Configuring network...');
      try {
        const body = { ip: wizData.ip, mode: ipMode, playerIp, token: wizData.token };
        if (ipMode === 'static') {
          body.staticIp = $('#setup-static-ip').value;
          body.staticGw = $('#setup-static-gw').value;
        }
        const res = await api('POST', 'setup/network', body);
        if (res.vmIp) wizData.ip = res.vmIp;
      } catch (e) {
        appendConsole(`Network config error: ${e.message}\n`);
      }
      hideOverlay();
      showWizStep(6);

    } else if (wizStep === 6) {
      const logEl = $('#bootstrap-log');
      const spinner = $('#bootstrap-spinner');
      logEl.textContent = '';
      spinner.hidden = false;
      wizNext.disabled = true;

      try {
        const worldName = $('#setup-world-name').value.trim();
        if (!worldName) { alert('World name is required.'); spinner.hidden = true; wizNext.disabled = false; return; }
        const res = await api('POST', 'setup/bootstrap', {
          ip: wizData.ip,
          enableSwap: $('#setup-swap').checked,
          token: wizData.token,
          worldName,
          region: $('#setup-region').value,
        });
        if (res.success) {
          logEl.textContent += '\nSetup complete!\n';
        } else {
          logEl.textContent += `\nError: ${res.error}\n`;
        }
      } catch (e) {
        logEl.textContent += `\nError: ${e.message}\n`;
      }
      spinner.hidden = true;
      showWizStep(7);
      // Replace nav with a "Go to Dashboard" button
      wizNext.hidden = false;
      wizNext.disabled = false;
      wizNext.textContent = 'Go to Dashboard';
      wizNext.onclick = () => {
        document.querySelector('.tab[data-tab="dashboard"]').click();
      };
      wizBack.hidden = true;
      cachedVmStatus = null;
      refreshStatus();
    }
  });

  // Block clicks on disabled links
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nolink]');
    if (a) e.preventDefault();
  });

  // -----------------------------------------------------------------------
  // Button bindings — Dashboard
  // -----------------------------------------------------------------------
  $('#btn-vm-start').addEventListener('click', () => startVmAction());
  $('#btn-dashboard-retry-start').addEventListener('click', () => {
    const memGB = parseInt($('#dashboard-retry-memory').value, 10);
    startVmAction(memGB);
  });
  $('#btn-vm-stop').addEventListener('click', () => {
    if (!confirm('Stop the VM? All running servers will go down.')) return;
    runAction('vm/stop', 'Stopping VM');
  });

  $('#btn-bg-start').addEventListener('click',   () => runAction('bg/start', 'Starting battlegroup'));
  $('#btn-bg-restart').addEventListener('click',  () => runAction('bg/restart', 'Restarting battlegroup'));
  $('#btn-bg-stop').addEventListener('click',     () => {
    if (!confirm('Stop the battlegroup?')) return;
    runAction('bg/stop', 'Stopping battlegroup');
  });
  $('#btn-bg-update').addEventListener('click',   () => runAction('bg/update', 'Checking for updates'));

  $('#btn-repair-bootstrap').addEventListener('click', async () => {
    const token = $('#repair-token').value.trim();
    const worldName = $('#repair-world-name').value.trim();
    if (!token) { alert('Server token is required.'); return; }
    if (!worldName) { alert('World name is required.'); return; }
    if (!confirm('Repair will delete the empty battlegroup namespace and re-run setup. Continue?')) return;

    const logEl = $('#repair-log');
    const spinner = $('#repair-spinner');
    logEl.textContent = '';
    spinner.hidden = false;
    $('#btn-repair-bootstrap').disabled = true;
    showOverlay('Repairing battlegroup setup...');

    try {
      const res = await api('POST', 'setup/repair', {
        token,
        worldName,
        region: $('#repair-region').value,
        enableSwap: $('#repair-swap').checked,
      });
      if (res.success) {
        logEl.textContent += '\nRepair complete. Refreshing status...\n';
        await refreshStatus();
      } else {
        logEl.textContent += `\nError: ${res.error}\n`;
      }
    } catch (e) {
      logEl.textContent += `\nError: ${e.message}\n`;
    }
    spinner.hidden = true;
    $('#btn-repair-bootstrap').disabled = false;
    hideOverlay();
  });

  // data-action buttons (battlegroup tab, monitoring, database)
  $$('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const label = btn.textContent.trim();
      runAction(action, label);
    });
  });

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------
  $('#form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw  = $('#pw-new').value;
    const pw2 = $('#pw-confirm').value;
    if (pw !== pw2) { alert('Passwords do not match.'); return; }
    if (!pw) { alert('Password cannot be empty.'); return; }
    showOverlay('Changing password...');
    appendConsole('\n> Changing VM password\n');
    try {
      const res = await api('POST', 'vm/password', { password: pw });
      if (res.success) {
        appendConsole('Password changed successfully.\n');
        $('#pw-new').value = '';
        $('#pw-confirm').value = '';
      } else {
        appendConsole(`Failed: ${res.error}\n`);
      }
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
    }
    hideOverlay();
  });

  $('#btn-rotate-key').addEventListener('click', () => {
    if (!confirm('Generate a new SSH key? The old key will be replaced.')) return;
    runAction('vm/rotate-key', 'Rotating SSH key');
  });

  // -----------------------------------------------------------------------
  // Game Config
  // -----------------------------------------------------------------------
  let configOriginal = {};

  async function loadConfig() {
    const loading = $('#config-loading');
    const panels = $('#config-panels');
    loading.style.display = '';
    panels.style.display = 'none';

    try {
      const data = await api('GET', 'config');
      if (data.error) throw new Error(data.error);

      configOriginal = { game: { ...data.game }, engine: { ...data.engine } };

      $$('.cfg').forEach((el) => {
        const file = el.dataset.file;
        const key = el.dataset.key;
        const values = file === 'game' ? data.game : data.engine;

        if (key in values) {
          let val = values[key];
          // Strip surrounding quotes for string values
          if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
          el.value = val;
        }
        el.classList.remove('cfg-dirty');
      });

      loading.style.display = 'none';
      panels.style.display = '';
    } catch (e) {
      loading.querySelector('.card-body').textContent = 'Failed to load config: ' + e.message;
    }
  }

  // Mark dirty on change
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('cfg')) e.target.classList.add('cfg-dirty');
  });
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('cfg')) e.target.classList.add('cfg-dirty');
  });

  // Load when tab opens
  const configTabBtn = document.querySelector('.tab[data-tab="gameconfig"]');
  configTabBtn.addEventListener('click', () => {
    if ($('#config-panels').style.display === 'none') loadConfig();
  });

  // Reload
  $('#btn-config-reload').addEventListener('click', loadConfig);

  // Save
  $('#btn-config-save').addEventListener('click', async () => {
    const changes = { game: {}, engine: {} };
    let count = 0;

    $$('.cfg.cfg-dirty').forEach((el) => {
      const file = el.dataset.file;
      const key = el.dataset.key;
      changes[file][key] = el.value;
      count++;
    });

    if (count === 0) { alert('No changes to save.'); return; }

    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before saving config changes.');
      return;
    }

    showOverlay(`Saving ${count} setting(s)...`);
    try {
      const res = await api('POST', 'config', changes);
      if (res.success) {
        appendConsole(`Saved ${count} config change(s). Settings deployed — stop & start the battlegroup to apply.\n`);
        $$('.cfg.cfg-dirty').forEach((el) => el.classList.remove('cfg-dirty'));
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      appendConsole(`Config save error: ${e.message}\n`);
      alert('Save failed: ' + e.message);
    }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Server Visibility
  // -----------------------------------------------------------------------
  let visibilityData = null;

  function buildPortForwardHtml(vmIp, directorPort, opts = {}) {
    const director = directorPort || 'see Dashboard';
    const target = vmIp || 'your VM IP';
    return (
      '<strong>Router port forwarding required (WAN)</strong>' +
      '<p class="pf-target">Forward these ports to your <strong>VM</strong> at <code>' + target + '</code> — not your Windows PC.</p>' +
      '<table><thead><tr><th>Port</th><th>Protocol</th><th>Purpose</th></tr></thead><tbody>' +
      '<tr><td><strong>31982</strong></td><td>TCP</td><td>Queue / matchmaking (required for server finder)</td></tr>' +
      '<tr><td><strong>' + director + '</strong></td><td>TCP</td><td>Director (matchmaking)</td></tr>' +
      '<tr><td><strong>7777–7810</strong></td><td>UDP</td><td>Game server traffic</td></tr>' +
      '</tbody></table>' +
      (opts.setupHint
        ? '<p>Finish setup, then configure these forwards on your router before sharing the server publicly.</p>'
        : '<p>After applying a public IP, <strong>stop the battlegroup completely</strong>, then start it again so Funcom registers the correct join address.</p>')
    );
  }

  function isWanVisibilityChoice(selectedValue, vmIp, publicIp) {
    if (!selectedValue || selectedValue === 'custom') return true;
    if (publicIp && selectedValue === publicIp) return true;
    return vmIp && selectedValue !== vmIp;
  }

  function updateVisibilityPortForwardPanel() {
    const panel = $('#visibility-port-forward');
    if (!panel || !visibilityData) return;

    const selected = document.querySelector('input[name="visibility"]:checked');
    let selectedValue = selected ? selected.value : '';
    if (selectedValue === 'custom') {
      selectedValue = $('#visibility-custom-ip').value.trim() || 'custom';
    }

    const show = isWanVisibilityChoice(selectedValue, visibilityData.vmIp, visibilityData.publicIp);
    panel.innerHTML = buildPortForwardHtml(
      visibilityData.vmIp,
      visibilityData.directorPort,
    );
    panel.hidden = !show;
    panel.style.display = show ? '' : 'none';
  }

  function updateSetupPortForwardPanel() {
    const panel = $('#setup-port-forward');
    if (!panel) return;

    const choice = document.querySelector('input[name="playerIpChoice"]:checked');
    const isPublic = choice && (choice.value === 'public' || choice.value === 'manual');
    if (!isPublic) {
      panel.hidden = true;
      panel.style.display = 'none';
      return;
    }

    panel.innerHTML = buildPortForwardHtml(wizData.ip || 'VM IP', null, { setupHint: true });
    panel.hidden = false;
    panel.style.display = '';
  }

  async function loadVisibility() {
    const loading = $('#visibility-loading');
    const controls = $('#visibility-controls');
    loading.style.display = '';
    controls.style.display = 'none';

    try {
      visibilityData = await api('GET', 'server-visibility');
      if (visibilityData.error) throw new Error(visibilityData.error);

      const radios = $('#visibility-radios');
      radios.innerHTML = '';

      const options = [];
      if (visibilityData.publicIp) {
        options.push({
          value: visibilityData.publicIp,
          label: `Public (WAN) — ${visibilityData.publicIp}`,
          hint: 'Internet players — port forwarding required',
        });
      }
      options.push({
        value: visibilityData.vmIp,
        label: `LAN — ${visibilityData.vmIp}`,
        hint: 'Only players on your local network',
      });
      options.push({ value: 'custom', label: 'Custom IP', hint: 'Enter manually' });

      const current = visibilityData.advertisedIp || visibilityData.vmIp;
      let matchedCustom = true;

      options.forEach((opt) => {
        const id = 'vis-' + opt.value.replace(/\./g, '-');
        const isSelected = opt.value !== 'custom' && current === opt.value;
        if (isSelected) matchedCustom = false;
        const div = document.createElement('label');
        div.className = 'radio-option' + (isSelected ? ' selected' : '');
        div.innerHTML =
          `<input type="radio" name="visibility" value="${opt.value}" id="${id}" ${isSelected ? 'checked' : ''}>` +
          `<span class="radio-label">${opt.label}</span>` +
          `<span class="radio-hint">${opt.hint}</span>`;
        radios.appendChild(div);
      });

      if (matchedCustom && current) {
        const customRadio = radios.querySelector('input[value="custom"]');
        if (customRadio) {
          customRadio.checked = true;
          customRadio.closest('.radio-option').classList.add('selected');
          $('#visibility-custom-ip').value = current;
          $('#visibility-custom-row').style.display = '';
        }
      }

      radios.querySelectorAll('input[type="radio"]').forEach((r) => {
        r.addEventListener('change', () => {
          radios.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('selected'));
          r.closest('.radio-option').classList.add('selected');
          $('#visibility-custom-row').style.display = r.value === 'custom' ? '' : 'none';
          updateVisibilityPortForwardPanel();
        });
      });

      const customIpInput = $('#visibility-custom-ip');
      if (customIpInput) {
        customIpInput.addEventListener('input', updateVisibilityPortForwardPanel);
      }

      $('#visibility-current').textContent = `Currently advertising: ${current}`;
      updateVisibilityPortForwardPanel();

      loading.style.display = 'none';
      controls.style.display = '';
    } catch (e) {
      loading.textContent = 'Failed to load visibility: ' + e.message;
    }
  }

  $('#btn-visibility-save').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="visibility"]:checked');
    if (!selected) { alert('Select an option.'); return; }

    let ip = selected.value;
    if (ip === 'custom') {
      ip = $('#visibility-custom-ip').value.trim();
      if (!ip) { alert('Enter a custom IP address.'); return; }
    }

    showOverlay('Setting server visibility...');
    try {
      const res = await api('POST', 'server-visibility', { advertisedIp: ip });
      appendConsole(`Server visibility set to ${ip}.\n`);
      if (res.message) appendConsole(res.message + '\n');
      appendConsole('Self-hosted servers appear in-game under Servers → Experimental.\n');
      await loadVisibility();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Load visibility when Game Config tab opens
  const origConfigLoad = loadConfig;
  loadConfig = async function() {
    await origConfigLoad();
    loadVisibility();
  };

  // -----------------------------------------------------------------------
  // Character Editor
  // -----------------------------------------------------------------------
  const INVENTORY_LABELS = {
    0: 'Backpack', 1: 'Recipes', 12: 'Emotes', 14: 'Social',
    15: 'Hotbar', 20: 'Quick-use', 25: 'Slot-25', 27: 'Equipped',
    29: 'Slot-29', 30: 'Storage', 31: 'Slot-31', 32: 'Slot-32', 33: 'Slot-33',
  };
  const WRITABLE_INV_TYPES = [0, 15, 20, 27];
  const STACK_LIMITS = {
    'Resources': 100, 'Ammo': 100, 'Consumables': 20, 'Fuel': 5,
    'Weapons - Melee': 1, 'Weapons - Ranged': 1,
    'Garments': 1, 'Garments - Head': 1, 'Garments - Chest': 1,
    'Garments - Hands': 1, 'Garments - Legs': 1, 'Garments - Feet': 1,
    'Tools': 1, 'Vehicle Modules': 1, 'Building': 1, 'Contract Items': 1, 'Misc': 1,
  };

  let itemCatalog = null;
  let catalogArr = [];
  let charData = null;

  async function loadItemCatalog() {
    if (itemCatalog) return;
    try {
      const resp = await fetch('/data/item-catalog.json');
      const data = await resp.json();
      itemCatalog = data.items;
      catalogArr = Object.entries(itemCatalog).map(([tid, info]) => ({
        tid, name: info.name, category: info.category,
      }));
      catalogArr.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      appendConsole('Failed to load item catalog: ' + e.message + '\n');
    }
  }

  let cosmeticCatalog = null;
  let cosmeticArr = [];
  let unlockedCosmetics = new Set();

  async function loadCosmeticCatalog() {
    if (cosmeticCatalog) return;
    try {
      const resp = await fetch('/data/cosmetic-catalog.json');
      const data = await resp.json();
      cosmeticCatalog = data.cosmetics;
      cosmeticArr = Object.entries(cosmeticCatalog).map(([id, info]) => ({
        id, name: info.name, category: info.category, unlock: info.unlock || 'customization',
      }));
      cosmeticArr.sort((a, b) => a.name.localeCompare(b.name));
      const hint = $('#cosmetic-results-hint');
      if (hint && data._meta?.unlockable) {
        hint.textContent = `Type at least 2 characters to search across ${data._meta.unlockable} unlockable cosmetics (${data._meta.total} total incl. inventory swatch tokens), or pick a category filter.`;
      }
    } catch (e) {
      appendConsole('Failed to load cosmetic catalog: ' + e.message + '\n');
    }
  }

  function catalogName(tid) {
    if (!itemCatalog) return tid;
    const info = itemCatalog[tid];
    return info ? info.name : tid;
  }

  function catalogCategory(tid) {
    if (!itemCatalog) return 'Misc';
    const info = itemCatalog[tid];
    return info ? info.category : 'Misc';
  }

  function isEquipmentCategory(cat) {
    return /Weapon|Garment|Tool/i.test(cat);
  }

  async function loadCharacterList() {
    const sel = $('#char-select');
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
      const data = await api('GET', 'characters');
      sel.innerHTML = '<option value="">— Choose a character —</option>';
      (data.characters || []).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (ID: ${c.id})`;
        sel.appendChild(opt);
      });
    } catch (e) {
      sel.innerHTML = '<option value="">Error loading characters</option>';
    }
  }

  function readStat(data, field, pathStr) {
    const parts = pathStr.split('.');
    let obj = field === 'properties' ? data.properties : data.gasAttributes;
    for (const p of parts) {
      if (!obj || typeof obj !== 'object') return '';
      obj = obj[p];
    }
    if (obj && typeof obj === 'object' && 'BaseValue' in obj) return obj.BaseValue;
    return obj != null ? obj : '';
  }

  function renderInventory() {
    if (!charData) return;
    const tbody = $('#inv-tbody');
    const items = charData.items || [];
    tbody.innerHTML = '';

    const nonEmoteItems = items.filter(i =>
      !i.template_id.startsWith('Emote_') && !i.template_id.startsWith('Social_')
    );

    nonEmoteItems.forEach(item => {
      const tr = document.createElement('tr');
      const name = catalogName(item.template_id);
      const loc = INVENTORY_LABELS[item.inventory_type] || `Type ${item.inventory_type}`;
      tr.innerHTML = `
        <td class="item-name">${name}</td>
        <td class="item-tid">${item.template_id}</td>
        <td>${item.stack_size}</td>
        <td>${loc}</td>
        <td><button class="btn-remove" data-item-id="${item.id}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    });

    $('#inv-count').textContent = `${nonEmoteItems.length} items`;
  }

  async function loadCharacter(actorId) {
    showOverlay('Loading character...');
    try {
      charData = await api('GET', `characters/${actorId}`);
      $('#char-editor').style.display = '';

      $$('.char-stat').forEach(el => {
        const field = el.dataset.field;
        const pathStr = el.dataset.path;
        el.value = readStat(charData, field, pathStr);
      });

      charData.writableInvs = charData.inventories
        .filter(inv => WRITABLE_INV_TYPES.includes(inv.inventory_type))
        .map(inv => ({
          id: inv.id,
          type: inv.inventory_type,
          label: INVENTORY_LABELS[inv.inventory_type] || `Type ${inv.inventory_type}`,
        }));

      renderInventory();
    } catch (e) {
      alert('Failed to load character: ' + e.message);
    }
    hideOverlay();
  }

  // Character tab — load list on first open
  let charTabLoaded = false;
  document.querySelector('.tab[data-tab="characters"]').addEventListener('click', async () => {
    await Promise.all([loadItemCatalog(), loadCosmeticCatalog()]);
    if (!charTabLoaded) {
      charTabLoaded = true;
      loadCharacterList();
    }
  });

  $('#btn-char-refresh').addEventListener('click', () => loadCharacterList());
  $('#btn-char-load').addEventListener('click', () => {
    const id = $('#char-select').value;
    if (!id) { alert('Select a character first.'); return; }
    loadCharacter(parseInt(id));
  });

  // Save stats
  $('#btn-stats-save').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing characters.');
      return;
    }

    const updates = [];
    $$('.char-stat').forEach(el => {
      const field = el.dataset.field;
      const pathStr = el.dataset.path;
      const parts = pathStr.split('.');
      const val = parseFloat(el.value);
      if (isNaN(val)) return;

      if (field === 'gas_attributes' && parts.length === 2) {
        updates.push({ field, path: [parts[0], parts[1], 'BaseValue'], value: val });
        updates.push({ field, path: [parts[0], parts[1], 'CurrentValue'], value: val });
      } else if (field === 'properties' && pathStr === 'DamageableActorComponent.m_TotalMaxHealth') {
        updates.push({ field, path: parts, value: val });
        updates.push({ field, path: ['DamageableActorComponent', 'm_CurrentMaxHealth'], value: val });
      } else {
        updates.push({ field, path: parts, value: val });
      }
    });

    if (!updates.length) { alert('No changes to save.'); return; }

    showOverlay('Saving stats...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/stats`, { updates });
      if (res.success) {
        appendConsole(`Stats saved for character ${charData.actorId}.\n`);
        alert('Stats saved. Restart the battlegroup for changes to take effect.');
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    hideOverlay();
  });

  // Remove item
  $('#inv-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-remove');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing inventory.');
      return;
    }

    const itemId = btn.dataset.itemId;
    if (!confirm('Remove this item?')) return;

    try {
      await api('DELETE', `characters/${charData.actorId}/inventory/${itemId}`);
      charData.items = charData.items.filter(i => i.id !== parseInt(itemId));
      renderInventory();
    } catch (e) {
      alert('Remove failed: ' + e.message);
    }
  });

  // Item search
  let searchTimeout;
  function runItemSearch() {
    const query = ($('#item-search').value || '').trim().toLowerCase();
    const catFilter = $('#item-cat-filter').value;
    const resultsWrap = $('#item-results');
    const tbody = $('#item-results-body');
    const hint = $('#item-results-hint');

    if (query.length < 2 && !catFilter) {
      resultsWrap.style.display = 'none';
      hint.style.display = '';
      return;
    }

    let results = catalogArr;
    if (query.length >= 2) {
      results = results.filter(i =>
        i.name.toLowerCase().includes(query) || i.tid.toLowerCase().includes(query));
    }
    if (catFilter) {
      if (catFilter === 'Garments') {
        results = results.filter(i => i.category.startsWith('Garments'));
      } else {
        results = results.filter(i => i.category === catFilter);
      }
    }

    results = results.slice(0, 50);

    tbody.innerHTML = '';
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim);text-align:center;padding:1rem">No items found</td></tr>';
    } else {
      const invOptions = (charData && charData.writableInvs || [])
        .map(inv => `<option value="${inv.id}">${inv.label}</option>`)
        .join('');
      const defaultInvOption = invOptions || '<option value="">No character loaded</option>';

      results.forEach(item => {
        const cat = item.category;
        const maxStack = STACK_LIMITS[cat] || 100;
        const isEq = isEquipmentCategory(cat);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="item-name">${item.name}<br><span class="item-tid">${item.tid}</span></td>
          <td style="font-size:.72rem;color:var(--text-dim)">${cat}</td>
          <td><input type="number" value="${isEq ? 1 : 1}" min="1" max="${maxStack}" class="add-qty" data-max="${maxStack}"></td>
          <td><select class="add-inv">${defaultInvOption}</select></td>
          <td><button class="btn-add" data-tid="${item.tid}" data-eq="${isEq ? 1 : 0}">Add</button></td>
        `;
        tbody.appendChild(tr);
      });
    }

    resultsWrap.style.display = '';
    hint.style.display = 'none';
  }

  $('#item-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(runItemSearch, 200);
  });
  $('#item-cat-filter').addEventListener('change', runItemSearch);

  // Add item
  $('#item-results-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-add');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing inventory.');
      return;
    }

    const row = btn.closest('tr');
    const qty = parseInt(row.querySelector('.add-qty').value);
    const invId = parseInt(row.querySelector('.add-inv').value);
    const tid = btn.dataset.tid;
    const isEq = btn.dataset.eq === '1';
    const maxStack = parseInt(row.querySelector('.add-qty').dataset.max);

    if (!invId) { alert('Load a character first.'); return; }
    if (isNaN(qty) || qty < 1) { alert('Invalid quantity.'); return; }
    if (qty > maxStack) {
      if (!confirm(`Warning: ${qty} exceeds the estimated max stack of ${maxStack} for this item type. This may cause issues. Continue?`)) return;
    }

    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await api('POST', `characters/${charData.actorId}/inventory/add`, {
        templateId: tid, stackSize: qty, inventoryId: invId, isEquipment: isEq,
      });
      if (res.success) {
        appendConsole(`Added ${qty}x ${catalogName(tid)} to inventory.\n`);
        await loadCharacter(charData.actorId);
        runItemSearch();
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Add';
  });

  // -----------------------------------------------------------------------
  // Cosmetics
  // -----------------------------------------------------------------------
  function cosmeticLabel(id) {
    if (cosmeticCatalog && cosmeticCatalog[id]) return cosmeticCatalog[id].name;
    return id.replace(/^MTX_/, '').replace(/_MeshVariant$/, '').replace(/_/g, ' ');
  }

  function cosmeticCategory(id) {
    if (cosmeticCatalog && cosmeticCatalog[id]) return cosmeticCatalog[id].category;
    return 'Other';
  }

  async function addCosmetic(cosmeticId) {
    if (!charData) { alert('Load a character first.'); return false; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return false;
    }
    if (unlockedCosmetics.has(cosmeticId)) return true;

    showOverlay('Adding cosmetic...');
    try {
      await api('POST', `characters/${charData.actorId}/cosmetics/add`, { cosmeticId });
      appendConsole(`Cosmetic "${cosmeticLabel(cosmeticId)}" added.\n`);
      unlockedCosmetics.add(cosmeticId);
      updateCosmeticCount();
      runCosmeticSearch();
      return true;
    } catch (e) {
      alert('Failed: ' + e.message);
      return false;
    } finally {
      hideOverlay();
    }
  }

  async function removeCosmetic(cosmeticId, { confirmRemove = true } = {}) {
    if (!charData) { alert('Load a character first.'); return false; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return false;
    }
    if (!unlockedCosmetics.has(cosmeticId)) return true;
    if (confirmRemove && !confirm(`Remove cosmetic "${cosmeticLabel(cosmeticId)}"?`)) return false;

    showOverlay('Removing cosmetic...');
    try {
      await api('POST', `characters/${charData.actorId}/cosmetics/remove`, { cosmeticId });
      appendConsole(`Cosmetic "${cosmeticLabel(cosmeticId)}" removed.\n`);
      unlockedCosmetics.delete(cosmeticId);
      updateCosmeticCount();
      runCosmeticSearch();
      return true;
    } catch (e) {
      alert('Failed: ' + e.message);
      return false;
    } finally {
      hideOverlay();
    }
  }

  function updateCosmeticCount() {
    $('#cosmetic-count').textContent = `${unlockedCosmetics.size} unlocked`;
  }

  let cosmeticSearchTimeout;
  function runCosmeticSearch() {
    const query = ($('#cosmetic-search').value || '').trim().toLowerCase();
    const catFilter = $('#cosmetic-cat-filter').value;
    const resultsWrap = $('#cosmetic-results');
    const tbody = $('#cosmetic-results-body');
    const hint = $('#cosmetic-results-hint');

    if (query.length < 2 && !catFilter) {
      resultsWrap.style.display = 'none';
      hint.style.display = '';
      return;
    }

    let results = cosmeticArr;
    if (query.length >= 2) {
      results = results.filter(c =>
        c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
    }
    if (catFilter) {
      results = results.filter(c => c.category === catFilter);
    }

    results = results.slice(0, 100);

    tbody.innerHTML = '';
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-dim);text-align:center;padding:1rem">No cosmetics found</td></tr>';
    } else {
      results.forEach(c => {
        const owned = unlockedCosmetics.has(c.id);
        const invOnly = c.unlock === 'inventory';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="item-name">${c.name}${invOnly ? ' <span style="color:var(--amber,#c9a227);font-size:.72rem">(inventory item)</span>' : ''}<br><span class="item-tid">${c.id}</span></td>
          <td style="font-size:.72rem;color:var(--text-dim)">${c.category}</td>
          <td><button class="btn btn-sm cosmetic-toggle ${owned ? 'btn-remove' : 'btn-green'}" data-cosmetic="${c.id}" data-owned="${owned ? '1' : '0'}" ${invOnly ? 'title="Swatch tokens usually need to be added via Inventory, not cosmetics"' : ''}>${owned ? 'Remove' : 'Add'}</button></td>
        `;
        tbody.appendChild(tr);
      });
    }

    resultsWrap.style.display = '';
    hint.style.display = 'none';
  }

  $('#cosmetic-search').addEventListener('input', () => {
    clearTimeout(cosmeticSearchTimeout);
    cosmeticSearchTimeout = setTimeout(runCosmeticSearch, 200);
  });
  $('#cosmetic-cat-filter').addEventListener('change', runCosmeticSearch);

  $('#cosmetic-results-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.cosmetic-toggle');
    if (!btn) return;

    const cosmeticId = btn.dataset.cosmetic;
    const owned = btn.dataset.owned === '1';
    btn.disabled = true;
    btn.textContent = '...';

    const ok = owned
      ? await removeCosmetic(cosmeticId)
      : await addCosmetic(cosmeticId);

    if (!ok) {
      btn.disabled = false;
      btn.textContent = owned ? 'Remove' : 'Add';
    }
  });

  async function loadCosmetics() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/cosmetics`);
      unlockedCosmetics = new Set(data.cosmetics || []);
      updateCosmeticCount();
    } catch (e) {
      appendConsole('Failed to load cosmetics: ' + e.message + '\n');
    }
  }

  $('#btn-cosmetic-add').addEventListener('click', async () => {
    const input = $('#cosmetic-add-input');
    const cosmeticId = input.value.trim();
    if (!cosmeticId) { alert('Enter a cosmetic ID.'); return; }
    const ok = await addCosmetic(cosmeticId);
    if (ok) input.value = '';
  });

  $('#btn-cosmetic-unlock-all').addEventListener('click', async () => {
    if (!charData) { alert('Load a character first.'); return; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Unlock ALL cosmetics and swatches from the catalog on this character?')) return;

    showOverlay('Unlocking all cosmetics...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/cosmetics/unlock-all`);
      appendConsole(`Unlocked ${res.total} cosmetics (${res.added} newly added).\n`);
      await loadCosmetics();
      runCosmeticSearch();
    } catch (e) {
      const needsFallback = /404|endpoint not found|manager needs restart/i.test(e.message);
      if (needsFallback && cosmeticArr.length) {
        if (!confirm(
          'Bulk unlock API is unavailable (Server Manager needs a restart).\n\n' +
          'Use slower one-by-one unlock instead? (~621 requests, may take a few minutes)'
        )) {
          hideOverlay();
          return;
        }
        const missing = cosmeticArr.filter(c => !unlockedCosmetics.has(c.id));
        let added = 0;
        for (let i = 0; i < missing.length; i++) {
          overlayText.textContent = `Unlocking ${i + 1} / ${missing.length}...`;
          try {
            await api('POST', `characters/${charData.actorId}/cosmetics/add`, { cosmeticId: missing[i].id });
            unlockedCosmetics.add(missing[i].id);
            added++;
          } catch { /* skip failures / duplicates */ }
        }
        appendConsole(`Unlocked ${unlockedCosmetics.size} cosmetics (${added} newly added via fallback).\n`);
        updateCosmeticCount();
        runCosmeticSearch();
      } else {
        alert('Failed: ' + e.message + '\n\nStop and restart the Server Manager (start_as_admin.bat), then try again.');
      }
    }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Tech Tree
  // -----------------------------------------------------------------------
  let techCatalogTotal = null;

  async function loadTechCatalogTotal() {
    if (techCatalogTotal != null) return techCatalogTotal;
    try {
      const res = await fetch('/data/tech-recipe-catalog.json');
      const data = await res.json();
      techCatalogTotal = data.total || Object.keys(data.recipes || {}).length;
    } catch {
      techCatalogTotal = null;
    }
    return techCatalogTotal;
  }

  async function refreshTechCount() {
    if (!charData) return;
    try {
      const d = await api('GET', `characters/${charData.actorId}`);
      const tree = d.properties?.TechKnowledgePlayerComponent?.m_TechKnowledge?.m_TechKnowledgeData || [];
      const purchased = tree.filter(i => i.UnlockedState === 'Purchased').length;
      const catalogTotal = await loadTechCatalogTotal();
      if (catalogTotal != null) {
        $('#tech-count').textContent = `${purchased} purchased / ${tree.length} in save / ${catalogTotal} in game`;
      } else {
        $('#tech-count').textContent = `${purchased} / ${tree.length} unlocked`;
      }
    } catch { /* silent */ }
  }

  $('#btn-tech-unlock-all').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Unlock ALL tech tree recipes? This adds every game recipe node to your save.')) return;
    showOverlay('Unlocking all recipes...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/tech/unlock-all`);
      appendConsole(`Tech tree: ${res.total} recipes unlocked (+${res.added} added to save, was ${res.previous}).\n`);
      techCatalogTotal = res.catalogTotal ?? techCatalogTotal;
      await refreshTechCount();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  $('#btn-tech-lock-all').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Lock ALL tech tree recipes? This resets your entire tech tree.')) return;
    showOverlay('Locking all recipes...');
    try {
      await api('POST', `characters/${charData.actorId}/tech/lock-all`);
      appendConsole('All tech tree recipes locked.\n');
      await refreshTechCount();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Specializations
  // -----------------------------------------------------------------------
  const SPEC_TRACKS = [
    { type: 'Combat', label: 'Combat' },
    { type: 'Crafting', label: 'Crafting' },
    { type: 'Exploration', label: 'Exploration' },
    { type: 'Gathering', label: 'Gathering' },
    { type: 'Sabotage', label: 'Sabotage' },
  ];

  async function loadSpecializations() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/specializations`);
      const grid = $('#spec-tracks-grid');
      grid.innerHTML = '';

      SPEC_TRACKS.forEach(spec => {
        const track = (data.tracks || []).find(t => t.track_type === spec.type);
        const xp = track ? track.xp_amount : 0;
        const lvl = track ? track.level : 0;

        const div = document.createElement('div');
        div.className = 'config-item';
        div.innerHTML = `
          <label>${spec.label} <span class="field-hint-inline">current: Lv${Math.floor(lvl)}, ${xp} XP</span></label>
          <div class="input-with-unit">
            <input type="number" class="select-input spec-level" data-track="${spec.type}" value="${Math.floor(lvl)}" min="0" max="100" step="1" placeholder="Level" style="width:70px" title="Level">
            <input type="number" class="select-input spec-xp" data-track="${spec.type}" value="${xp}" min="0" step="1000" placeholder="XP" style="width:100px" title="XP">
            <button class="btn btn-green btn-sm spec-save" data-track="${spec.type}">Set</button>
          </div>
        `;
        grid.appendChild(div);
      });
    } catch (e) {
      appendConsole('Failed to load specializations: ' + e.message + '\n');
    }
  }

  document.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('.spec-save');
    if (!saveBtn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const track = saveBtn.dataset.track;
    const row = saveBtn.closest('.config-item');
    const level = parseFloat(row.querySelector('.spec-level').value);
    const xp = parseInt(row.querySelector('.spec-xp').value);

    showOverlay(`Setting ${track}...`);
    try {
      await api('POST', `characters/${charData.actorId}/specializations/track`, {
        trackType: track, xp, level,
      });
      appendConsole(`${track} set to level ${level}, ${xp} XP.\n`);
      await loadSpecializations();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Keystone unlock buttons
  $('#spec-keystone-btns').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-prefix]');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const prefix = btn.dataset.prefix;
    const trackName = prefix.replace('_', '');
    if (!confirm(`Unlock ALL ${trackName} keystones (perks)?`)) return;

    showOverlay(`Unlocking ${trackName} keystones...`);
    try {
      await api('POST', `characters/${charData.actorId}/specializations/unlock-keystones`, { trackPrefix: prefix });
      appendConsole(`All ${trackName} keystones unlocked.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Economy (Currency + Faction Rep)
  // -----------------------------------------------------------------------
  async function loadEconomy() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/economy`);

      (data.currency || []).forEach(c => {
        const el = $(`#econ-currency-${c.currency_id}`);
        if (el) el.value = c.balance;
      });

      const grid = $('#faction-rep-grid');
      grid.innerHTML = '';
      (data.factions || []).forEach(f => {
        if (f.name === 'None') return;
        const rep = (data.factionRep || []).find(r => r.faction_id === f.id);
        const amount = rep ? rep.reputation_amount : 0;

        const div = document.createElement('div');
        div.className = 'config-item';
        div.innerHTML = `
          <label>${f.name} Reputation</label>
          <div class="input-with-unit">
            <input type="number" class="select-input faction-rep" data-faction="${f.id}" value="${amount}" min="0" step="500">
            <button class="btn btn-green btn-sm faction-rep-save" data-faction="${f.id}">Set</button>
          </div>
        `;
        grid.appendChild(div);
      });
    } catch (e) {
      appendConsole('Failed to load economy: ' + e.message + '\n');
    }
  }

  // Currency set buttons
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-currency]');
    if (!btn || btn.tagName !== 'BUTTON' || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const cid = parseInt(btn.dataset.currency);
    const balance = parseInt($(`#econ-currency-${cid}`).value);
    if (isNaN(balance)) { alert('Enter a valid amount.'); return; }

    showOverlay('Setting currency...');
    try {
      await api('POST', `characters/${charData.actorId}/economy/currency`, { currencyId: cid, balance });
      appendConsole(`Currency ${cid} set to ${balance}.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Faction rep set buttons
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.faction-rep-save');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const fid = parseInt(btn.dataset.faction);
    const row = btn.closest('.config-item');
    const amount = parseInt(row.querySelector('.faction-rep').value);
    if (isNaN(amount)) { alert('Enter a valid amount.'); return; }

    showOverlay('Setting reputation...');
    try {
      await api('POST', `characters/${charData.actorId}/economy/reputation`, { factionId: fid, amount });
      appendConsole(`Faction ${fid} reputation set to ${amount}.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Load all sections when a character is loaded
  // -----------------------------------------------------------------------
  const origLoadCharacter = loadCharacter;
  loadCharacter = async function(actorId) {
    await origLoadCharacter(actorId);
    if (charData) {
      refreshTechCount();
      loadSpecializations();
      loadEconomy();
      await loadCosmetics();
      runCosmeticSearch();
    }
  };

  // -----------------------------------------------------------------------
  // Experimental: Multi-Sietch
  // -----------------------------------------------------------------------
  let sietchLoaded = false;

  async function loadSietches() {
    const statusEl = $('#sietch-status');
    const controlsEl = $('#sietch-controls');

    try {
      const data = await api('GET', 'sietches');
      if (data.error) throw new Error(data.error);

      const count = data.sietchCount;
      const ramEst = (count * 12) + 6;

      statusEl.innerHTML =
        `<div style="display:flex;gap:2rem;align-items:center;flex-wrap:wrap">` +
        `<div><strong style="font-size:1.8rem;color:var(--accent)">${count}</strong> <span style="color:var(--text-dim)">sietch${count !== 1 ? 'es' : ''} configured</span></div>` +
        `<div style="font-size:.85rem;color:var(--text-dim)">Partitions: ${data.sietches.map(s => '#' + s.partitions[0]).join(', ')} &middot; Est. RAM: ~${ramEst} GB</div>` +
        `</div>`;

      $('#btn-remove-sietch').disabled = count <= 1;
      controlsEl.style.display = '';
      sietchLoaded = true;
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">Failed to load sietch info: ${e.message}</span>`;
      controlsEl.style.display = 'none';
    }
  }

  $('#btn-add-sietch').addEventListener('click', async () => {
    const msg = 'Add a new sietch to the battlegroup?\n\n' +
      'This adds another Hagga Basin instance (~12 GB RAM).\n' +
      'You must restart the battlegroup after for it to take effect.\n\n' +
      'This feature is EXPERIMENTAL and has not been fully tested.';
    if (!confirm(msg)) return;

    showOverlay('Adding sietch...');
    try {
      const result = await api('POST', 'sietches/add');
      if (result.error) throw new Error(result.error);
      appendConsole(`Sietch ${result.sietchNumber} added (partition ${result.partitionId}). Restart the battlegroup to apply.\n`);
      await loadSietches();
    } catch (e) {
      alert('Failed to add sietch: ' + e.message);
    }
    hideOverlay();
  });

  $('#btn-remove-sietch').addEventListener('click', async () => {
    const msg = 'Remove the last added sietch?\n\n' +
      'WARNING: Player bases and progress in this sietch may become inaccessible.\n' +
      'Take a database backup first!\n\n' +
      'You must restart the battlegroup after for it to take effect.';
    if (!confirm(msg)) return;

    showOverlay('Removing sietch...');
    try {
      const result = await api('POST', 'sietches/remove');
      if (result.error) throw new Error(result.error);
      appendConsole(`Sietch removed (partition ${result.removedPartition}). ${result.remainingSietches} sietch${result.remainingSietches !== 1 ? 'es' : ''} remaining. Restart the battlegroup to apply.\n`);
      await loadSietches();
    } catch (e) {
      alert('Failed to remove sietch: ' + e.message);
    }
    hideOverlay();
  });

  document.querySelector('.tab[data-tab="experimental"]').addEventListener('click', () => {
    if (!sietchLoaded) loadSietches();
  });
})();
