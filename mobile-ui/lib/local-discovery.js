/**
 * Local Network Device Discovery
 *
 * Discovers Chromecast and DLNA/UPnP media renderers on the local network
 * using SSDP (Simple Service Discovery Protocol). Zero external dependencies —
 * uses Node.js built-in dgram and http modules.
 *
 * This runs on the Jetson server (which IS on the LAN), so it can find cast
 * devices even when the controlling phone is connected via VPN.
 */

const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');
const os = require('os');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TIMEOUT = 5000; // 5 seconds

// SSDP search targets for media renderers
const SEARCH_TARGETS = [
  'urn:dial-multiscreen-org:service:dial:1',           // Chromecast / DIAL devices
  'urn:schemas-upnp-org:device:MediaRenderer:1',       // DLNA media renderers
  'urn:schemas-upnp-org:service:AVTransport:1',        // UPnP AV Transport
];

/**
 * Parse an SSDP response into a key-value object
 */
function parseSSDPResponse(msg) {
  const headers = {};
  const lines = msg.toString().split('\r\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.substring(0, idx).trim().toLowerCase();
      const val = line.substring(idx + 1).trim();
      headers[key] = val;
    }
  }
  return headers;
}

/**
 * Fetch and parse a UPnP device description XML to extract friendly name and services
 */
function fetchDeviceDescription(locationUrl, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(locationUrl);
    const req = http.get({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          // Simple XML extraction (no dependency needed)
          const friendlyName = extractXmlTag(body, 'friendlyName') || 'Unknown Device';
          const manufacturer = extractXmlTag(body, 'manufacturer') || '';
          const modelName = extractXmlTag(body, 'modelName') || '';
          const deviceType = extractXmlTag(body, 'deviceType') || '';
          const udn = extractXmlTag(body, 'UDN') || '';

          // Check for AVTransport service (DLNA playback capability)
          const hasAVTransport = body.includes('AVTransport');
          // Check for DIAL (Chromecast-like)
          const hasDIAL = body.includes('dial-multiscreen');

          let type = 'unknown';
          if (hasDIAL || manufacturer.toLowerCase().includes('google') ||
              modelName.toLowerCase().includes('chromecast')) {
            type = 'chromecast';
          } else if (hasAVTransport) {
            type = 'dlna';
          }

          resolve({
            friendlyName,
            manufacturer,
            modelName,
            deviceType,
            udn,
            type,
            hasAVTransport,
            location: locationUrl,
            host: parsed.hostname,
          });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Extract text content from a simple XML tag (no attributes)
 */
function extractXmlTag(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Get the server's LAN IP address (non-VPN, non-loopback)
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  // Prefer eth0 / wlan0 over tailscale / tun / wg interfaces
  const preferred = ['eth0', 'wlan0', 'en0', 'en1', 'enp', 'wlp'];
  const vpnLike = ['tailscale', 'tun', 'wg', 'utun', 'ts'];

  let bestIP = null;

  for (const [name, addrs] of Object.entries(interfaces)) {
    // Skip VPN interfaces
    if (vpnLike.some(v => name.toLowerCase().includes(v))) continue;

    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        // If it's a preferred interface, return immediately
        if (preferred.some(p => name.toLowerCase().startsWith(p))) {
          return addr.address;
        }
        // Otherwise keep as fallback
        if (!bestIP) bestIP = addr.address;
      }
    }
  }

  return bestIP || '127.0.0.1';
}

/**
 * Discover media devices on the local network via SSDP
 * Returns a Map of unique devices keyed by UDN or host:port
 */
function discoverDevices(timeout = SEARCH_TIMEOUT) {
  return new Promise((resolve) => {
    const devices = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      resolve([...devices.values()]);
    }

    socket.on('error', (err) => {
      console.error('[Discovery] Socket error:', err.message);
      finish();
    });

    socket.on('message', (msg, rinfo) => {
      const headers = parseSSDPResponse(msg);
      const location = headers['location'];
      if (!location) return;

      // Deduplicate by location URL
      if (devices.has(location)) return;

      // Placeholder — will be enriched by fetchDeviceDescription
      devices.set(location, {
        id: location,
        host: rinfo.address,
        port: rinfo.port,
        location,
        st: headers['st'] || headers['nt'] || '',
        server: headers['server'] || '',
        usn: headers['usn'] || '',
        _pending: true,
      });
    });

    socket.bind(0, () => {
      // Send M-SEARCH for each target
      for (const st of SEARCH_TARGETS) {
        const msg = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          `MAN: "ssdp:discover"`,
          `MX: ${Math.ceil(timeout / 1000)}`,
          `ST: ${st}`,
          '',
          '',
        ].join('\r\n');

        socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDRESS);
      }

      // Also do a general search
      const generalMsg = [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        `MAN: "ssdp:discover"`,
        `MX: ${Math.ceil(timeout / 1000)}`,
        'ST: ssdp:all',
        '',
        '',
      ].join('\r\n');
      socket.send(generalMsg, 0, generalMsg.length, SSDP_PORT, SSDP_ADDRESS);
    });

    // After timeout, enrich discovered devices with description data
    setTimeout(async () => {
      const enrichPromises = [...devices.entries()].map(async ([loc, dev]) => {
        try {
          const info = await fetchDeviceDescription(loc, 3000);
          devices.set(loc, {
            id: info.udn || loc,
            friendlyName: info.friendlyName,
            manufacturer: info.manufacturer,
            modelName: info.modelName,
            type: info.type,
            host: info.host,
            location: loc,
            hasAVTransport: info.hasAVTransport,
          });
        } catch {
          // Keep raw device info if description fetch fails
          devices.set(loc, {
            id: loc,
            friendlyName: dev.server || `Device at ${dev.host}`,
            manufacturer: '',
            modelName: '',
            type: 'unknown',
            host: dev.host,
            location: loc,
            hasAVTransport: false,
          });
        }
      });

      await Promise.all(enrichPromises);

      // Filter to only castable devices (DLNA or Chromecast)
      for (const [loc, dev] of devices) {
        if (dev.type !== 'dlna' && dev.type !== 'chromecast') {
          devices.delete(loc);
        }
      }

      finish();
    }, timeout);
  });
}

/**
 * Find the AVTransport control URL from a DLNA device's description
 */
async function getAVTransportControlURL(locationUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(locationUrl);
    const req = http.get({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      timeout: 4000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        // Find AVTransport service and its controlURL
        const avMatch = body.match(
          /AVTransport[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i
        );
        if (avMatch) {
          let controlPath = avMatch[1];
          // Resolve relative path
          if (!controlPath.startsWith('http')) {
            controlPath = `http://${parsed.hostname}:${parsed.port || 80}${controlPath.startsWith('/') ? '' : '/'}${controlPath}`;
          }
          resolve(controlPath);
        } else {
          reject(new Error('AVTransport control URL not found'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = {
  discoverDevices,
  getLocalIP,
  getAVTransportControlURL,
  fetchDeviceDescription,
};
