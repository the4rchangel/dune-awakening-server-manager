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
    return res.json();
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

  async function runAction(path, label) {
    if (busy) return;
    showOverlay(label + '...');
    appendConsole(`\n> ${label}\n`);
    try {
      await api('POST', path);
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
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
    vmMemory.textContent = vm.memoryMB ? `${Math.round(vm.memoryMB)} MB` : '—';
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
  }

  async function refreshStatus() {
    try {
      const s = await api('GET', 'status');
      applyStatus(s);
    } catch { /* silent */ }
  }

  refreshStatus();
  setInterval(refreshStatus, 8000);

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

  $('#btn-preflight').addEventListener('click', async () => {
    $('#btn-preflight').disabled = true;
    $('#btn-preflight').textContent = 'Checking...';
    try {
      const data = await api('GET', 'setup/preflight');
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

      if (preflightPassed) {
        // Populate drive select
        const sel = $('#setup-drive');
        sel.innerHTML = '';
        data.drives.forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d.name;
          opt.textContent = `${d.name}: — ${d.freeGB} GB free`;
          sel.appendChild(opt);
        });

        // Populate NIC select
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
    } catch (e) {
      appendConsole(`Preflight error: ${e.message}\n`);
    }
    $('#btn-preflight').disabled = false;
    $('#btn-preflight').textContent = 'Run Checks';
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
        if (!confirm(`A VM named "dune-awakening" already exists (${preflightData.vmState}). It will be removed and re-created. Continue?`)) return;
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
  $('#btn-vm-start').addEventListener('click', () => runAction('vm/start', 'Starting VM'));
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
      let val = el.value;

      // Wrap string values that need quotes (ServerDisplayName, ServerLoginPassword)
      if (key === 'Bgd.ServerDisplayName' || key === 'Bgd.ServerLoginPassword') {
        val = `"${val}"`;
      }

      changes[file][key] = val;
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
        appendConsole(`Saved ${count} config change(s). Restart battlegroup to apply.\n`);
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
})();
