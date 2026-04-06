# Alabtross Streaming — Command Cheatsheet

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

## WireGuard VPN

```bash
# Start/Stop/Restart VPN
sudo systemctl start wg-quick@wg0
sudo systemctl stop wg-quick@wg0
sudo systemctl restart wg-quick@wg0

# Check VPN status
sudo systemctl status wg-quick@wg0
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
