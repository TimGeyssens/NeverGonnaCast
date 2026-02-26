const devicesContainer = document.getElementById('devicesContainer');
const refreshBtn = document.getElementById('refreshBtn');
const castBtn = document.getElementById('castBtn');
const castAllBtn = document.getElementById('castAllBtn');
const videoInput = document.getElementById('videoInput');
const statusBar = document.getElementById('statusBar');

let devices = [];
let selectedDeviceIds = new Set();

function setStatus(kind, message) {
  if (!message) {
    statusBar.className = 'status status-hidden';
    statusBar.textContent = '';
    return;
  }
  statusBar.textContent = message;
  statusBar.className = `status ${kind === 'error' ? 'status-error' : 'status-ok'}`;
}

function renderDevices() {
  devicesContainer.innerHTML = '';

  if (!devices.length) {
    const div = document.createElement('div');
    div.className = 'muted';
    div.textContent =
      'No devices discovered yet. Make sure your TV / receiver is on and on the same network, then press Refresh.';
    devicesContainer.appendChild(div);
    castBtn.disabled = true;
    castAllBtn.disabled = true;
    return;
  }

  devices.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    if (selectedDeviceIds.has(device.id)) {
      row.classList.add('selected');
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'device-radio';
    checkbox.checked = selectedDeviceIds.has(device.id);

    const meta = document.createElement('div');
    meta.className = 'device-meta';

    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name || 'Unnamed device';

    const sub = document.createElement('div');
    sub.className = 'device-sub';
    const bits = [];
    if (device.manufacturer) bits.push(device.manufacturer);
    if (device.modelName) bits.push(device.modelName);
    if (device.kind === 'castv2') {
      bits.push('Google Cast v2');
    } else if (device.kind === 'dial') {
      bits.push('DIAL');
    }
    sub.textContent = bits.join(' • ');

    meta.appendChild(name);
    meta.appendChild(sub);

    const toggleThis = () => {
      if (selectedDeviceIds.has(device.id)) {
        selectedDeviceIds.delete(device.id);
      } else {
        selectedDeviceIds.add(device.id);
      }
      renderDevices();
      updateCastButtonState();
    };

    row.addEventListener('click', toggleThis);
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleThis();
    });

    row.appendChild(checkbox);
    row.appendChild(meta);
    devicesContainer.appendChild(row);
  });

  updateCastButtonState();
}

function updateCastButtonState() {
  castBtn.disabled = selectedDeviceIds.size === 0;
  castAllBtn.disabled = !devices.length || !videoInput.value.trim();
}

async function fetchDevices({ withRefresh } = {}) {
  try {
    setStatus(null, '');

    if (withRefresh) {
      await fetch('/api/devices/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const res = await fetch('/api/devices');
    if (!res.ok) {
      throw new Error('Failed to load devices');
    }
    const data = await res.json();
    devices = Array.isArray(data) ? data : data.devices || [];

    // Drop selection for devices that disappeared
    selectedDeviceIds = new Set(
      Array.from(selectedDeviceIds).filter((id) => devices.some((d) => d.id === id))
    );

    renderDevices();
  } catch (err) {
    console.error(err);
    setStatus('error', 'Unable to discover devices. Check that you are on the same network.');
  }
}

async function castVideo() {
  const videoUrl = videoInput.value.trim();
  if (selectedDeviceIds.size === 0) {
    return;
  }

  if (!videoUrl) {
    setStatus('error', 'Please paste a YouTube link or video ID first.');
    return;
  }

  castBtn.disabled = true;
  castBtn.textContent = 'Casting…';
  setStatus(null, '');

  try {
    const res = await fetch('/api/cast-many', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: Array.from(selectedDeviceIds),
        videoUrl
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const failedNames = (data.failed || []).map((f) => `"${f.deviceName}"`).join(', ');
      const msg =
        data.error ||
        (failedNames
          ? `Casting failed for: ${failedNames}.`
          : 'Casting failed on all selected devices. The devices might not support YouTube via DIAL.');
      setStatus('error', msg);
    } else {
      const successNames = (data.success || []).map((s) => `"${s.deviceName}"`).join(', ');
      setStatus('ok', `Casting started on: ${successNames || 'selected devices'}.`);
    }
  } catch (err) {
    console.error(err);
    setStatus('error', 'Unexpected error while casting.');
  } finally {
    castBtn.textContent = 'Cast to selected devices';
    updateCastButtonState();
  }
}

async function castToAll() {
  const videoUrl = videoInput.value.trim();
  if (!videoUrl || !devices.length) return;

  castAllBtn.disabled = true;
  castAllBtn.textContent = 'Casting to all…';
  setStatus(null, '');

  try {
    const res = await fetch('/api/cast-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const failedNames = (data.failed || []).map((f) => `"${f.deviceName}"`).join(', ');
      const msg =
        data.error ||
        (failedNames
          ? `Casting failed for: ${failedNames}.`
          : 'Casting failed on all devices. The devices might not support YouTube via DIAL.');
      setStatus('error', msg);
    } else {
      const successNames = (data.success || []).map((s) => `"${s.deviceName}"`).join(', ');
      setStatus('ok', `Casting started on: ${successNames || 'multiple devices'}.`);
    }
  } catch (err) {
    console.error(err);
    setStatus('error', 'Unexpected error while casting to all devices.');
  } finally {
    castAllBtn.textContent = 'Cast to all devices';
    updateCastButtonState();
  }
}

refreshBtn.addEventListener('click', () => {
  devicesContainer.innerHTML = '<div class="muted">Scanning for devices…</div>';
  fetchDevices({ withRefresh: true });
});

castBtn.addEventListener('click', castVideo);
castAllBtn.addEventListener('click', castToAll);

videoInput.addEventListener('input', updateCastButtonState);

// Initial device load
fetchDevices();

