const express = require('express');
const path = require('path');
const dial = require('peer-dial');
const castv2 = require('castv2-client');
const mdns = require('multicast-dns')();

const { Client: CastClient, Application, RequestResponseController } = castv2;

const PORT = process.env.PORT || 3001;

const app = express();

// Simple in-memory registry of discovered devices (DIAL + Cast v2)
// Keyed by internal device id
const devices = new Map();

app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API: list currently known devices
app.get('/api/devices', (req, res) => {
  const list = Array.from(devices.values());
  res.json(list);
});

// API: trigger a refresh scan (non-blocking)
app.post('/api/devices/refresh', (req, res) => {
  try {
    dialClient.refresh();
  } catch (e) {
    // ignore, client may not be ready yet
  }
  try {
    triggerCastDiscovery();
  } catch (e) {
    // ignore
  }
  const list = Array.from(devices.values());
  res.json({ ok: true, devices: list });
});

// Helper to extract video ID from common YouTube URL formats
function extractYouTubeId(urlOrId) {
  if (!urlOrId) return null;

  // Already looks like an 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId.trim())) {
    return urlOrId.trim();
  }

  try {
    const u = new URL(urlOrId.trim());

    // Standard watch URL: https://www.youtube.com/watch?v=VIDEO_ID
    const vParam = u.searchParams.get('v');
    if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
      return vParam;
    }

    // Short URLs: https://youtu.be/VIDEO_ID
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return id;
      }
    }

    // Embedded URLs: https://www.youtube.com/embed/VIDEO_ID
    if (u.pathname.startsWith('/embed/')) {
      const id = u.pathname.split('/')[2];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return id;
      }
    }
  } catch {
    // not a valid URL, fall through
  }

  return null;
}

// --- Google Cast v2: minimal YouTube controller setup ---

const YOUTUBE_APP_ID = '233637DE';

class YoutubeController extends RequestResponseController {
  constructor(client, sourceId, destinationId) {
    super(client, sourceId, destinationId, 'urn:x-cast:com.google.youtube.mdx');
    this.once('close', () => {
      this.stop();
    });
  }

  load(videoId) {
    const data = {
      type: 'flingVideo',
      data: {
        currentTime: 0,
        videoId
      }
    };
    this.request(data);
  }
}

class YoutubeApp extends Application {
  constructor(client, session) {
    super(client, session);
    this.youtube = this.createController(YoutubeController);
  }

  load(videoId) {
    this.youtube.load(videoId);
  }
}

YoutubeApp.APP_ID = YOUTUBE_APP_ID;

// Internal helper: launch YouTube on a single device (DIAL or Cast v2)
function launchOnDevice(deviceInfo, videoId) {
  return new Promise((resolve) => {
    const baseResult = {
      ok: false,
      deviceId: deviceInfo.id,
      deviceName: deviceInfo.name || 'Unknown'
    };

    if (deviceInfo.kind === 'castv2') {
      if (!deviceInfo.host || !deviceInfo.port) {
        return resolve({
          ...baseResult,
          error: 'Missing host/port for Cast v2 device.'
        });
      }

      const client = new CastClient();
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        try {
          client.close();
        } catch {
          // ignore
        }
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish({
          ...baseResult,
          error: 'Timed out connecting to Cast v2 device.'
        });
      }, 10000);

      client.on('error', () => {
        clearTimeout(timeout);
        finish({
          ...baseResult,
          error: 'Error communicating with Cast v2 device.'
        });
      });

      client.connect(deviceInfo.host, { port: deviceInfo.port }, () => {
        client.launch(YoutubeApp, (err, player) => {
          if (err || !player) {
            clearTimeout(timeout);
            return finish({
              ...baseResult,
              error: 'Failed to launch YouTube app on Cast v2 device.'
            });
          }

          try {
            player.load(videoId);
            clearTimeout(timeout);
            finish({
              ...baseResult,
              ok: true
            });
          } catch {
            clearTimeout(timeout);
            finish({
              ...baseResult,
              error: 'Failed to send video to YouTube app on Cast v2 device.'
            });
          }
        });
      });
    } else {
      // Default: DIAL
      dialClient.getDialDevice(deviceInfo.descriptionUrl, (dialDevice, err) => {
        if (!dialDevice || err) {
          return resolve({
            ...baseResult,
            error: 'Failed to connect to DIAL device.'
          });
        }

        dialDevice.launchApp('YouTube', `v=${videoId}`, 'text/plain', (launchRes, launchErr) => {
          if (launchErr) {
            return resolve({
              ...baseResult,
              error: 'Failed to launch YouTube on DIAL device.'
            });
          }
          resolve({
            ...baseResult,
            ok: true
          });
        });
      });
    }
  });
}

// API: cast a YouTube video to selected devices (one or many)
app.post('/api/cast-many', (req, res) => {
  const { deviceIds, videoUrl } = req.body || {};

  if (!Array.isArray(deviceIds) || !deviceIds.length || !videoUrl) {
    return res.status(400).json({ error: 'deviceIds (non-empty array) and videoUrl are required' });
  }

  const videoId = extractYouTubeId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not parse YouTube video ID from input.' });
  }

  const selectedDevices = deviceIds
    .map((id) => devices.get(id))
    .filter(Boolean);

  if (!selectedDevices.length) {
    return res.status(404).json({ error: 'None of the selected devices are available. Try refreshing devices.' });
  }

  Promise.all(selectedDevices.map((d) => launchOnDevice(d, videoId))).then((results) => {
    const success = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    res.json({
      ok: success.length > 0,
      videoId,
      success,
      failed
    });
  });
});

// API: cast a YouTube video to all discovered devices
app.post('/api/cast-all', (req, res) => {
  const { videoUrl } = req.body || {};

  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  const allDevices = Array.from(devices.values());
  if (!allDevices.length) {
    return res.status(404).json({ error: 'No devices available to cast to.' });
  }

  const videoId = extractYouTubeId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not parse YouTube video ID from input.' });
  }

  Promise.all(allDevices.map((d) => launchOnDevice(d, videoId))).then((results) => {
    const success = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    res.json({
      ok: success.length > 0,
      videoId,
      success,
      failed
    });
  });
});

// Create and start DIAL client for SSDP/DIAL discovery
const dialClient = new dial.Client();

dialClient
  .on('ready', () => {
    console.log('DIAL client is ready, starting SSDP discovery...');
  })
  .on('found', (deviceDescriptionUrl, ssdpHeaders) => {
    console.log('Found DIAL device at', deviceDescriptionUrl);

    dialClient.getDialDevice(deviceDescriptionUrl, (dialDevice, err) => {
      if (!dialDevice || err) {
        console.error('Error getting DIAL device description for', deviceDescriptionUrl, err);
        return;
      }

      const id = dialDevice.descriptionUrl;
      const device = {
        id,
        kind: 'dial',
        name: dialDevice.friendlyName || 'Unnamed device',
        modelName: dialDevice.modelName || '',
        manufacturer: dialDevice.manufacturer || '',
        descriptionUrl: dialDevice.descriptionUrl,
        applicationUrl: dialDevice.applicationUrl
      };

      devices.set(id, device);
      console.log('Registered DIAL device:', device.name);
    });
  })
  .on('disappear', (deviceDescriptionUrl) => {
    console.log('DIAL device disappeared:', deviceDescriptionUrl);
    devices.delete(deviceDescriptionUrl);
  })
  .on('stop', () => {
    console.log('DIAL client stopped');
  })
  .start();

// --- Google Cast v2 discovery via mDNS (_googlecast._tcp.local) ---

const CAST_SERVICE = '_googlecast._tcp.local';

function handleCastMdnsResponse(packet) {
  const records = [...packet.answers, ...packet.additionals];
  const ptrs = records.filter((r) => r.type === 'PTR' && r.name === CAST_SERVICE);

  ptrs.forEach((ptr) => {
    const serviceName = ptr.data; // e.g. "Chromecast-...._googlecast._tcp.local"
    if (!serviceName) return;

    const srv = records.find((r) => r.type === 'SRV' && r.name === serviceName);
    const txt = records.find((r) => r.type === 'TXT' && r.name === serviceName);
    if (!srv || !srv.data) return;

    const host = srv.data.target;
    const port = srv.data.port;

    let ip = null;
    const aRecord = records.find((r) => (r.type === 'A' || r.type === 'AAAA') && r.name === host);
    if (aRecord && aRecord.data) {
      ip = aRecord.data;
    }

    let friendlyName = null;
    let modelName = null;
    let id = null;

    if (txt && Array.isArray(txt.data)) {
      txt.data.forEach((entry) => {
        const s = entry.toString();
        if (s.startsWith('fn=')) friendlyName = s.substring(3);
        if (s.startsWith('md=')) modelName = s.substring(3);
        if (s.startsWith('id=')) id = s.substring(3);
      });
    }

    const internalId = `castv2:${id || ip || host}:${port}`;
    const device = {
      id: internalId,
      kind: 'castv2',
      name: friendlyName || 'Cast device',
      modelName: modelName || '',
      manufacturer: 'Google Cast',
      host: ip || host,
      port
    };

    devices.set(internalId, device);
    console.log('Registered Cast v2 device:', device.name, device.host, device.port);
  });
}

mdns.on('response', handleCastMdnsResponse);

function triggerCastDiscovery() {
  mdns.query({
    questions: [
      {
        name: CAST_SERVICE,
        type: 'PTR'
      }
    ]
  });
}

// Kick off initial Cast v2 discovery
triggerCastDiscovery();

app.listen(PORT, () => {
  console.log(`Casting UI available at http://localhost:${PORT}`);
});

