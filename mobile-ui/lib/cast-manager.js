/**
 * Cast Manager
 *
 * Handles casting media to local network devices from the Jetson server.
 * Supports:
 *   - DLNA (UPnP AVTransport) — most smart TVs, speakers, media players
 *   - Chromecast (castv2 protocol) — Google Cast devices
 *
 * The phone controls everything via VPN → Jetson API, while the Jetson
 * streams directly to the cast device over the LAN.
 */

const http = require('http');
const { URL } = require('url');
const { getAVTransportControlURL, getLocalIP } = require('./local-discovery');

// ─── Active Sessions ─────────────────────────────────────────────────
// Tracks what's currently casting so the frontend can show status / stop
const activeSessions = new Map(); // deviceId → { device, mediaUrl, status, startedAt }

// ─── DLNA Casting (UPnP AVTransport SOAP) ─────────────────────────

const SOAP_ENVELOPE = (action, body) => [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
  '<s:Body>',
  `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">`,
  body,
  `</u:${action}>`,
  '</s:Body>',
  '</s:Envelope>',
].join('');

function soapAction(controlUrl, action, bodyXml) {
  return new Promise((resolve, reject) => {
    const envelope = SOAP_ENVELOPE(action, bodyXml);
    const parsed = new URL(controlUrl);

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout: 8000,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(envelope),
        'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`SOAP ${action} failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end(envelope);
  });
}

/**
 * Cast a media URL to a DLNA device
 * @param {object} device - Device from discoverDevices()
 * @param {string} mediaUrl - HTTP URL to the media (must be reachable from LAN)
 * @param {string} title - Display title for the media
 * @param {string} mimeType - MIME type (e.g. 'video/mp4')
 */
async function castToDLNA(device, mediaUrl, title = 'Albatross', mimeType = 'video/mp4') {
  const controlUrl = await getAVTransportControlURL(device.location);
  console.log(`[Cast] DLNA control URL: ${controlUrl}`);

  // Stop any current playback first
  try {
    await soapAction(controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
  } catch {
    // Ignore — might not be playing
  }

  // Set the media URI
  const didlMetadata = escapeXml([
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    `<res protocolInfo="http-get:*:${mimeType}:*">${escapeXml(mediaUrl)}</res>`,
    '<upnp:class>object.item.videoItem.movie</upnp:class>',
    '</item>',
    '</DIDL-Lite>',
  ].join(''));

  await soapAction(controlUrl, 'SetAVTransportURI', [
    '<InstanceID>0</InstanceID>',
    `<CurrentURI>${escapeXml(mediaUrl)}</CurrentURI>`,
    `<CurrentURIMetaData>${didlMetadata}</CurrentURIMetaData>`,
  ].join(''));

  // Play
  await soapAction(controlUrl, 'Play', [
    '<InstanceID>0</InstanceID>',
    '<Speed>1</Speed>',
  ].join(''));

  // Track session
  const session = {
    device,
    mediaUrl,
    controlUrl,
    type: 'dlna',
    status: 'playing',
    title,
    startedAt: Date.now(),
  };
  activeSessions.set(device.id, session);

  console.log(`[Cast] Now playing on ${device.friendlyName}: ${title}`);
  return session;
}

/**
 * Stop DLNA playback on a device
 */
async function stopDLNA(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'dlna') {
    throw new Error('No active DLNA session for this device');
  }

  await soapAction(session.controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
  session.status = 'stopped';
  activeSessions.delete(deviceId);
  console.log(`[Cast] Stopped playback on ${session.device.friendlyName}`);
}

/**
 * Pause/resume DLNA playback
 */
async function pauseDLNA(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'dlna') {
    throw new Error('No active DLNA session for this device');
  }

  if (session.status === 'playing') {
    await soapAction(session.controlUrl, 'Pause', '<InstanceID>0</InstanceID>');
    session.status = 'paused';
  } else if (session.status === 'paused') {
    await soapAction(session.controlUrl, 'Play', [
      '<InstanceID>0</InstanceID>',
      '<Speed>1</Speed>',
    ].join(''));
    session.status = 'playing';
  }

  return session.status;
}

/**
 * Seek DLNA playback to a position
 * @param {string} position - Time in HH:MM:SS format
 */
async function seekDLNA(deviceId, position) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'dlna') {
    throw new Error('No active DLNA session for this device');
  }

  await soapAction(session.controlUrl, 'Seek', [
    '<InstanceID>0</InstanceID>',
    '<Unit>REL_TIME</Unit>',
    `<Target>${position}</Target>`,
  ].join(''));
}

/**
 * Get current transport info (position, duration, state) for a DLNA session
 */
async function getDLNAStatus(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'dlna') {
    return null;
  }

  try {
    const posInfo = await soapAction(session.controlUrl, 'GetPositionInfo',
      '<InstanceID>0</InstanceID>');
    const transportInfo = await soapAction(session.controlUrl, 'GetTransportInfo',
      '<InstanceID>0</InstanceID>');

    // Parse position and duration from XML response
    const trackDuration = extractXmlValue(posInfo, 'TrackDuration') || '00:00:00';
    const relTime = extractXmlValue(posInfo, 'RelTime') || '00:00:00';
    const transportState = extractXmlValue(transportInfo, 'CurrentTransportState') || 'UNKNOWN';

    // Update session status based on transport state
    if (transportState === 'PLAYING') session.status = 'playing';
    else if (transportState === 'PAUSED_PLAYBACK') session.status = 'paused';
    else if (transportState === 'STOPPED') session.status = 'stopped';

    return {
      position: relTime,
      duration: trackDuration,
      state: transportState,
      status: session.status,
      title: session.title,
      device: session.device.friendlyName,
    };
  } catch (err) {
    console.error(`[Cast] Status check failed: ${err.message}`);
    return { status: session.status, title: session.title, device: session.device.friendlyName };
  }
}

// ─── Chromecast Casting (castv2-client) ──────────────────────────────

let castv2Available = false;
let Client, DefaultMediaReceiver;
try {
  Client = require('castv2-client').Client;
  DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
  castv2Available = true;
  console.log('[Cast] castv2-client available — Chromecast casting enabled');
} catch {
  console.log('[Cast] castv2-client not installed — Chromecast casting disabled, DLNA still available');
}

/**
 * Cast a media URL to a Chromecast device
 */
async function castToChromecast(device, mediaUrl, title = 'Albatross', mimeType = 'video/mp4') {
  if (!castv2Available) {
    throw new Error('castv2-client not installed — run: npm install castv2-client');
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    const connectTimeout = setTimeout(() => {
      client.close();
      reject(new Error('Chromecast connection timeout'));
    }, 10000);

    client.connect(device.host, () => {
      clearTimeout(connectTimeout);

      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) {
          client.close();
          return reject(err);
        }

        const media = {
          contentId: mediaUrl,
          contentType: mimeType,
          streamType: 'BUFFERED',
          metadata: {
            type: 0,
            metadataType: 0,
            title: title,
          },
        };

        player.load(media, { autoplay: true }, (err) => {
          if (err) {
            client.close();
            return reject(err);
          }

          const session = {
            device,
            mediaUrl,
            type: 'chromecast',
            status: 'playing',
            title,
            startedAt: Date.now(),
            _client: client,
            _player: player,
          };
          activeSessions.set(device.id, session);

          // Listen for status updates
          player.on('status', (status) => {
            if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
              session.status = 'finished';
              activeSessions.delete(device.id);
              client.close();
            } else if (status.playerState) {
              session.status = status.playerState.toLowerCase();
            }
          });

          console.log(`[Cast] Now casting to Chromecast ${device.friendlyName}: ${title}`);
          resolve(session);
        });
      });
    });

    client.on('error', (err) => {
      clearTimeout(connectTimeout);
      console.error(`[Cast] Chromecast error: ${err.message}`);
      activeSessions.delete(device.id);
      client.close();
      reject(err);
    });
  });
}

/**
 * Stop Chromecast playback
 */
async function stopChromecast(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'chromecast') {
    throw new Error('No active Chromecast session');
  }

  return new Promise((resolve) => {
    try {
      session._player.stop(() => {
        session._client.close();
        session.status = 'stopped';
        activeSessions.delete(deviceId);
        resolve();
      });
    } catch {
      activeSessions.delete(deviceId);
      resolve();
    }
  });
}

/**
 * Pause/resume Chromecast playback
 */
async function pauseChromecast(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session || session.type !== 'chromecast') {
    throw new Error('No active Chromecast session');
  }

  return new Promise((resolve, reject) => {
    if (session.status === 'playing') {
      session._player.pause(() => {
        session.status = 'paused';
        resolve('paused');
      });
    } else {
      session._player.play(() => {
        session.status = 'playing';
        resolve('playing');
      });
    }
  });
}

// ─── Unified API ─────────────────────────────────────────────────────

/**
 * Cast to a device (auto-detects DLNA vs Chromecast)
 */
async function castToDevice(device, mediaUrl, title, mimeType) {
  if (device.type === 'chromecast') {
    return castToChromecast(device, mediaUrl, title, mimeType);
  }
  return castToDLNA(device, mediaUrl, title, mimeType);
}

/**
 * Stop playback on a device
 */
async function stopDevice(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session) throw new Error('No active session');

  if (session.type === 'chromecast') {
    return stopChromecast(deviceId);
  }
  return stopDLNA(deviceId);
}

/**
 * Pause/resume on a device
 */
async function pauseDevice(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session) throw new Error('No active session');

  if (session.type === 'chromecast') {
    return pauseChromecast(deviceId);
  }
  return pauseDLNA(deviceId);
}

/**
 * Get status of a cast session
 */
async function getDeviceStatus(deviceId) {
  const session = activeSessions.get(deviceId);
  if (!session) return null;

  if (session.type === 'dlna') {
    return getDLNAStatus(deviceId);
  }

  // Chromecast — return cached status
  return {
    status: session.status,
    title: session.title,
    device: session.device.friendlyName,
    type: 'chromecast',
  };
}

/**
 * Get all active sessions
 */
function getAllSessions() {
  const sessions = [];
  for (const [id, s] of activeSessions) {
    sessions.push({
      deviceId: id,
      deviceName: s.device.friendlyName,
      type: s.type,
      status: s.status,
      title: s.title,
      startedAt: s.startedAt,
    });
  }
  return sessions;
}

function isCastv2Available() {
  return castv2Available;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractXmlValue(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

module.exports = {
  castToDevice,
  stopDevice,
  pauseDevice,
  getDeviceStatus,
  getAllSessions,
  isCastv2Available,
  seekDLNA,
  getLocalIP,
};
