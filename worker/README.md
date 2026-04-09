# Albatross GPU Conversion Worker

A small HTTP service that runs on a Windows PC with an NVIDIA RTX card and
takes over the CPU-expensive video transcoding work from the Jetson Orin Nano.
The Orin keeps doing torrents, library, and the web UI; this worker does
nothing but accept files and re-encode them with NVENC.

## Why this exists

The Jetson Orin Nano has no NVENC silicon (NVIDIA removed it from this SKU).
Transcoding a 2-hour HEVC source on the Orin's CPU with `libx264 -preset
veryfast` takes 2–4 hours. The same job on a desktop NVIDIA card with NVENC
takes 5–10 minutes. Even after the network round-trip over Tailscale, you save
hours per file.

## Hardware/software requirements

- Windows 10 or 11
- NVIDIA GPU with NVENC (anything Turing/Ampere/Ada — GTX 16xx and up,
  RTX 20xx, 30xx, 40xx)
- ~1 GB free for Node + ffmpeg + temp space (50 GB recommended for the
  scratch dir if you have big 4K sources)
- Tailscale already installed and logged in, with the same tailnet as the
  Orin

## Install

1. Copy the `worker/` directory from this repo onto the Windows PC.

2. Open **PowerShell as Administrator**, `cd` into that directory, and run:

   ```powershell
   .\install.ps1
   ```

   The script:
   - verifies `nvidia-smi` works (refuses to install if no NVIDIA driver)
   - installs Node.js LTS via `winget` if missing
   - installs the Gyan.dev "full" ffmpeg build via `winget` if missing
     (this is the one with `h264_nvenc` enabled — the chocolatey/regular
     ffmpeg builds don't include it)
   - copies `server.js` to `C:\Tools\alabtross-worker\`
   - opens TCP port 8090 on Windows Firewall
   - registers a Scheduled Task that runs the worker at boot under the
     SYSTEM account so it survives reboots and user logoff
   - starts the worker and probes its `/health` endpoint

3. Once it finishes, copy the printed `WORKER_URL` line and add it to the
   Orin's environment.

### Optional install flags

```powershell
.\install.ps1 -TempDir D:\alabtross-worker-temp -Port 9000 -NvencPreset p7 -NvencCq 19 -MaxWidth 1920 -Secret "long-random-string"
```

| Flag | Default | Notes |
|---|---|---|
| `-InstallDir` | `C:\Tools\alabtross-worker` | Where `server.js` lives |
| `-TempDir` | `%TEMP%\alabtross-worker` on C: | Scratch dir for in-flight uploads + ffmpeg output. **Point this at a drive with ≥100 GB free** — see note below. |
| `-Port` | `8090` | Listen port. Match this in `WORKER_URL` |
| `-NvencPreset` | `p6` | `p1`=fastest, `p7`=best quality. Sweet spot is p5–p6 |
| `-NvencCq` | `21` | Lower = bigger file, higher quality. Default ≈ libx264 crf 23 |
| `-MaxWidth` | `1920` | Output width cap. 4K sources downscale to fit |
| `-Secret` | empty | If set, requires `X-Worker-Secret` header on every call |

> **Scratch disk sizing.** Each in-flight job holds roughly **2× the source
> file size** on the temp drive at peak — the source file is uploaded to
> disk in full before ffmpeg runs, and ffmpeg writes a new MP4 next to it
> before streaming back. For a library with 4K HEVC sources (15–50 GB per
> file), the default `C:\WINDOWS\TEMP` on a small system drive will run
> out of space with a `ENOSPC: no space left on device` error. Use
> `-TempDir D:\alabtross-worker-temp` to put scratch on a larger drive.

## Configure the Orin

On the Orin, add to the environment used by the `alabtross-mobile` service
(e.g. in `alabtross-mobile.service` or your Docker `--env` flags):

```
WORKER_URL=http://<pc-tailnet-name>:8090
```

(Optional, if you set `-Secret` above:)

```
WORKER_SECRET=long-random-string
```

Then restart the service. On startup it will probe the worker; you'll see a
log line like:

```
[Library] Worker reachable: h264_nvenc preset=p6 maxWidth=1920 (NVIDIA GeForce RTX 3060, 552.41)
```

If the worker is unreachable for any reason, the Orin silently falls back to
local libx264 — nothing breaks, conversions just go back to taking hours.

## Verify it works

From the Windows PC:

```powershell
Invoke-RestMethod http://localhost:8090/health
```

Should return JSON with `ok: true`, encoder name, GPU info, etc.

From the Orin (over Tailscale):

```bash
curl http://<pc-tailnet-name>:8090/health
```

Same JSON. If this works, the Orin will start using the worker on its next
conversion.

To see live conversions, tail the log on the PC:

```powershell
Get-Content C:\Tools\alabtross-worker\logs\worker.log -Wait
```

## How it routes work

When the Orin's library manager decides a file needs full transcoding:

1. It probes the worker's `/health`. If reachable → goes remote.
2. It opens an HTTP POST to `/transcode` with the source file as the body.
3. The worker streams the upload to a temp file on its local disk.
4. Worker runs ffmpeg with `h264_nvenc` (and `hevc_cuvid` / `h264_cuvid`
   for the decode side, so HEVC and 4K sources never touch the CPU).
5. Worker streams the resulting MP4 back as the response body.
6. Orin writes it to its existing `*.converting.mp4` temp path and the
   normal "rename into place" code path takes over.

If anything fails — worker offline, GPU error, network drop, ffmpeg error
on a malformed source — the Orin logs the failure and **falls back to local
libx264** for that file, so a broken worker never blocks conversion entirely.

## Tailscale ACL recommendation

If you want to lock down which devices can hit the worker, add to your
tailnet ACL JSON:

```json
{
  "acls": [
    {
      "action": "accept",
      "src":    ["tag:orin"],
      "dst":    ["tag:gpu-worker:8090"]
    }
  ]
}
```

Tag the Orin as `orin` and the PC as `gpu-worker` and only that one node
can reach the worker port.

## Manual run / debugging

To run the worker in the foreground (e.g. while debugging):

```powershell
Stop-ScheduledTask -TaskName AlabtrossGPUWorker
cd C:\Tools\alabtross-worker
$env:WORKER_PORT='8090'
node server.js
```

Press Ctrl-C to stop, then `Start-ScheduledTask -TaskName AlabtrossGPUWorker`
to put it back under the scheduled task.

## Uninstall

```powershell
Stop-ScheduledTask -TaskName AlabtrossGPUWorker
Unregister-ScheduledTask -TaskName AlabtrossGPUWorker -Confirm:$false
Remove-NetFirewallRule -DisplayName 'Albatross GPU Worker'
Remove-Item -Recurse -Force C:\Tools\alabtross-worker
```

## What it does NOT do

- **Live `/stream/transcode`** — the on-the-fly transcode endpoint that
  fires when a client tries to play a not-yet-converted file is left on
  the Orin's CPU. Round-tripping a partial file across the network would
  add too much first-byte latency. The worker only handles background
  pre-conversion, which is where the wall-clock pain actually lives.
- **HDR tone mapping** — HDR sources go through with their HDR metadata.
  Browsers will display them in SDR with washed-out colors. Not a
  regression vs. the old libx264 path; same behavior.
- **Audio re-encoding when source is already AAC LC stereo @ ≤48 kHz** —
  the Orin detects this case and tells the worker to stream-copy audio,
  saving a few percent of wall clock and avoiding generation loss.
