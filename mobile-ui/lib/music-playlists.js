/**
 * Albatross — Music Playlists Store
 *
 * Persists user-curated playlists in a separate JSON file so the hot-path
 * library-metadata save loop isn't triggered by playlist reorders.
 *
 * File: <LIBRARY_PATH>/_music-playlists.json
 *   { playlists: [{ id, name, createdAt, updatedAt, items: [{albumId, trackIndex}] }] }
 *
 * Atomic write with .bak backup, same pattern as library-manager's metadata save.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

class MusicPlaylists {
  constructor(libraryPath) {
    this._file = path.join(libraryPath, '_music-playlists.json');
    this._bak = this._file + '.bak';
    this._playlists = [];
    this._load();
  }

  _load() {
    for (const p of [this._file, this._bak]) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(raw);
          this._playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
          return;
        }
      } catch (e) {
        console.warn(`[Playlists] Failed to load ${p}: ${e.message}`);
      }
    }
    this._playlists = [];
  }

  _save() {
    const tmp = this._file + '.tmp';
    try {
      if (fs.existsSync(this._file)) {
        fs.copyFileSync(this._file, this._bak);
      }
      fs.writeFileSync(tmp, JSON.stringify({ playlists: this._playlists }, null, 2));
      fs.renameSync(tmp, this._file);
    } catch (e) {
      console.error(`[Playlists] Save failed: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  list() {
    return this._playlists.map(p => ({ ...p, items: p.items ? p.items.slice() : [] }));
  }

  get(id) {
    return this._playlists.find(p => p.id === id) || null;
  }

  create(name) {
    const trimmed = (name || '').toString().trim().slice(0, 120);
    if (!trimmed) throw new Error('Playlist name required');
    const pl = { id: uuid(), name: trimmed, createdAt: Date.now(), updatedAt: Date.now(), items: [] };
    this._playlists.push(pl);
    this._save();
    return pl;
  }

  rename(id, name) {
    const pl = this.get(id);
    if (!pl) return null;
    const trimmed = (name || '').toString().trim().slice(0, 120);
    if (!trimmed) throw new Error('Playlist name required');
    pl.name = trimmed;
    pl.updatedAt = Date.now();
    this._save();
    return pl;
  }

  remove(id) {
    const before = this._playlists.length;
    this._playlists = this._playlists.filter(p => p.id !== id);
    if (this._playlists.length !== before) {
      this._save();
      return true;
    }
    return false;
  }

  addItem(id, albumId, trackIndex) {
    const pl = this.get(id);
    if (!pl) return null;
    if (!albumId) throw new Error('albumId required');
    const idx = Number.isInteger(trackIndex) ? trackIndex : 0;
    pl.items.push({ albumId: String(albumId), trackIndex: idx });
    pl.updatedAt = Date.now();
    this._save();
    return pl;
  }

  removeItem(id, index) {
    const pl = this.get(id);
    if (!pl) return null;
    if (!Number.isInteger(index) || index < 0 || index >= pl.items.length) {
      throw new Error('Invalid index');
    }
    pl.items.splice(index, 1);
    pl.updatedAt = Date.now();
    this._save();
    return pl;
  }

  reorderItem(id, from, to) {
    const pl = this.get(id);
    if (!pl) return null;
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('from and to must be integers');
    if (from < 0 || from >= pl.items.length || to < 0 || to >= pl.items.length) {
      throw new Error('Index out of range');
    }
    const [moved] = pl.items.splice(from, 1);
    pl.items.splice(to, 0, moved);
    pl.updatedAt = Date.now();
    this._save();
    return pl;
  }
}

module.exports = MusicPlaylists;
