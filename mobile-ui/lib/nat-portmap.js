/**
 * Albatross — UPnP port mapping helper
 *
 * Thin wrapper around `nat-upnp` for requesting and releasing router
 * port forwards so our torrent-stream listener is reachable from outside
 * peers. Without this, the Jetson's incoming listener only sees the LAN;
 * remote peers can only be reached by us dialing out, which caps the
 * effective swarm size at whatever the tracker and DHT hand back.
 *
 * Design notes:
 *   - All operations are best-effort. If UPnP isn't available (home router
 *     doesn't support it, it's disabled, network is IPv6-only), every call
 *     resolves to `false` and logs a warning. Callers never throw.
 *   - We intentionally do NOT fall back to PCP or NAT-PMP here. Most consumer
 *     routers that support any automatic port mapping support UPnP, and the
 *     extra libs pull in fairly heavy deps for a marginal win on the rare
 *     PCP-only router.
 *   - Opt-out: set UPNP_ENABLED=0 in the environment. Some ISPs / enterprise
 *     networks don't want unsolicited port-forward requests, and shared /
 *     cloud deployments shouldn't poke their host NAT. Defaults to enabled
 *     because a standalone home Jetson is the primary target.
 *   - Port mapping has a TTL; we request `ttl: 0` (forever) which some
 *     routers honor and others silently downgrade to a few hours. Either is
 *     fine — torrent-stream's listener stays up across the whole process
 *     lifetime and we unmap on shutdown via `unmapAll()`.
 *
 * Usage pattern from LibraryManager:
 *   const nat = new NatPortMap();
 *   await nat.mapPort(engine.port);    // after engine.listen() succeeds
 *   ...
 *   await nat.unmapPort(engine.port);  // when engine is destroyed
 *   await nat.unmapAll();              // on server shutdown
 */

let natUpnp = null;
try { natUpnp = require('nat-upnp'); }
catch { /* handled in _ensureClient */ }

const ENABLED = (process.env.UPNP_ENABLED || '1') !== '0';

class NatPortMap {
  constructor() {
    this._client = null;
    this._mappedPorts = new Set();
    this._initFailed = false;
  }

  enabled() {
    return ENABLED && !!natUpnp;
  }

  _ensureClient() {
    if (!this.enabled()) return null;
    if (this._initFailed) return null;
    if (!this._client) {
      try {
        this._client = natUpnp.createClient();
      } catch (err) {
        console.warn(`[NAT] UPnP client init failed: ${err.message}`);
        this._initFailed = true;
        return null;
      }
    }
    return this._client;
  }

  /**
   * Request a port forward on the router for `port` (TCP). Resolves to true
   * on success, false on any failure. Idempotent — calling twice for the
   * same port in a session is a no-op for the second call.
   */
  mapPort(port) {
    return new Promise((resolve) => {
      if (!port || typeof port !== 'number') return resolve(false);
      if (this._mappedPorts.has(port)) return resolve(true);
      const client = this._ensureClient();
      if (!client) return resolve(false);
      try {
        client.portMapping(
          {
            public: port,
            private: port,
            ttl: 0,
            description: 'alabtross-bt',
          },
          (err) => {
            if (err) {
              // Most common causes: router doesn't support UPnP, or it does
              // but the port is already claimed by another device on the LAN.
              // Either way we can still download; outbound connections work.
              console.warn(`[NAT] portMapping(${port}) failed: ${err.message}`);
              return resolve(false);
            }
            this._mappedPorts.add(port);
            console.log(`[NAT] mapped TCP port ${port} via UPnP`);
            resolve(true);
          }
        );
      } catch (err) {
        console.warn(`[NAT] portMapping(${port}) threw: ${err.message}`);
        resolve(false);
      }
    });
  }

  /**
   * Release a previously-mapped port. Safe to call on ports that were never
   * mapped; resolves cleanly in all cases.
   */
  unmapPort(port) {
    return new Promise((resolve) => {
      if (!port || !this._mappedPorts.has(port)) return resolve();
      const client = this._client;
      if (!client) { this._mappedPorts.delete(port); return resolve(); }
      try {
        client.portUnmapping({ public: port }, (err) => {
          this._mappedPorts.delete(port);
          if (err) console.warn(`[NAT] portUnmapping(${port}) failed: ${err.message}`);
          else console.log(`[NAT] unmapped port ${port}`);
          resolve();
        });
      } catch (err) {
        console.warn(`[NAT] portUnmapping(${port}) threw: ${err.message}`);
        this._mappedPorts.delete(port);
        resolve();
      }
    });
  }

  /**
   * Release every port we've mapped in this process. Called from
   * LibraryManager.destroy() so we don't leave stale forwards on the
   * router across server restarts.
   */
  async unmapAll() {
    for (const port of [...this._mappedPorts]) {
      await this.unmapPort(port);
    }
    try { if (this._client) this._client.close(); } catch { /* ignore */ }
    this._client = null;
  }
}

module.exports = { NatPortMap };
