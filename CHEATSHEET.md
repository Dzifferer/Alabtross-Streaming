# Albatross Streaming — Command Cheatsheet

## Docker Services

```bash
# Start services
sudo docker start stremio-server alabtross-mobile

# Stop services
sudo docker stop stremio-server alabtross-mobile

# Restart services
sudo docker restart stremio-server alabtross-mobile

# Check what's running
sudo docker ps

# View logs (last 30 lines)
sudo docker logs --tail 30 alabtross-mobile
sudo docker logs --tail 30 stremio-server

# Rebuild mobile UI (after code changes)
sudo docker stop alabtross-mobile
sudo docker build --no-cache -t alabtross-mobile mobile-ui/
sudo docker start alabtross-mobile
```

## Git / Updating Code

> **Note:** This is a private repo. SSH key or PAT auth must be configured first — see README.md "Private Repo Access".

```bash
cd ~/Alabtross-Streaming
git pull origin main
```

## USB Drive (1.8TB)

```bash
# Mount the drive
sudo mount /dev/sda1 /mnt/movies

# Check if drive is mounted
df -h /mnt/movies

# List drive contents
ls /mnt/movies/

# Find downloaded videos
find /mnt/movies -name "*.mp4" -o -name "*.mkv" -o -name "*.avi"
```

## Network / DNS

```bash
# Check network status
nmcli device status

# Fix DNS (if domains won't resolve)
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf

# Test DNS is working
ping -c 2 8.8.8.8
curl -s "https://apibay.org/q.php?q=test&cat=200" | head -c 200

# Check your IP address
hostname -I
```

## Tailscale VPN

```bash
# Check VPN status
tailscale status

# Show Tailscale IP
tailscale ip

# Check HTTPS proxy status
tailscale serve status

# Re-enable HTTPS proxy (if needed)
sudo tailscale serve --bg --https=443 http://localhost:8080

# Restart Tailscale
sudo systemctl restart tailscaled

# Access URL: https://albatross (short) or https://albatross.<tailnet>.ts.net (full)
```

## SSH

```bash
# Start SSH service
sudo systemctl start sshd
sudo systemctl enable sshd
```

## Full Setup (re-run)

```bash
cd ~/Alabtross-Streaming
sudo bash jetson_setup.sh
```
