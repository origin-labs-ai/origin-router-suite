# Cài đặt

Hướng dẫn cài đặt chi tiết cho OriginRouter với mẹo troubleshooting.

---

## Yêu cầu

### Yêu cầu hệ thống

- **Node.js**: Phiên bản 20.0.0 trở lên
- **npm**: Phiên bản 10.0.0 trở lên (đi kèm Node.js)
- **OS**: macOS, Linux, Windows (khuyên dùng WSL)
- **Dung lượng**: ~200MB để cài đặt

### Kiểm tra Phiên bản

```bash
node --version
# Should show v20.x.x or higher

npm --version
# Should show 10.x.x or higher
```

**Chưa có Node.js?** Cài đặt từ [nodejs.org](https://nodejs.org/)

---

## Phương thức Cài đặt

### Cách 1: Cài Global (Khuyên dùng)

Cài OriginRouter toàn cục để dùng ở bất kỳ đâu:

```bash
curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
```

**Khởi động OriginRouter:**

```bash
originrouter
```

**Lợi ích:**
- ✅ Chạy từ mọi thư mục
- ✅ Lệnh đơn giản: `originrouter`
- ✅ Auto-update với the launcher's own update check (it reads the GitHub release feed)

### Cách 2: Cài Local

Cài trong project cụ thể:

```bash
docker run -d --name origin-router \
  -p 20128:20128 \
  -v "$HOME/.or:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/origin-labs-ai/origin-router:latest
```

**Open the dashboard:**

```
http://localhost:20128/dashboard
```

**Lợi ích:**
- ✅ Cô lập mỗi project
- ✅ Version control mỗi project
- ✅ Không làm bẩn global namespace

### Cách 3: Từ Source (Development)

Clone và build từ GitHub:

```bash
cd originrouter/app
npm install
npm run build
npm start
```

**Lợi ích:**
- ✅ Tính năng phát triển mới nhất
- ✅ Đóng góp cho dự án
- ✅ Tùy chỉnh

---

## Lần chạy Đầu tiên

### Khởi động Server

```bash
originrouter
```

**Điều gì xảy ra:**
1. Server khởi động tại `http://localhost:20128`
2. Dashboard tự động mở trong browser
3. Data directory được tạo tại `~/.originrouter`
4. API key được tạo tự động

### Đăng nhập Dashboard

**Credentials mặc định:**
- Mật khẩu: `123456`

**⚠️ Đổi mật khẩu ngay:**
1. Đăng nhập dashboard
2. Settings → Change Password
3. Dùng mật khẩu mạnh

### Lấy API Key

```
Dashboard → Settings → API Keys
→ Copy your API key
→ Use in CLI tools
```

**Ví dụ format API key:**
```
9r_1234567890abcdef1234567890abcdef
```

---

## Xác minh Cài đặt

### Kiểm tra trạng thái Server

```bash
curl http://localhost:20128/health
```

**Phản hồi dự kiến:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

### Liệt kê Model khả dụng

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer your-api-key"
```

**Phản hồi dự kiến:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "cc/claude-opus-4-5-20251101",
      "object": "model",
      "created": 1234567890,
      "owned_by": "claude-code"
    }
  ]
}
```

### Test Chat Completion

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cc/claude-opus-4-5-20251101",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

---

## Cấu hình

### Biến môi trường

Tạo file `.env` hoặc set biến môi trường:

```bash
# Security (REQUIRED in production)
export JWT_SECRET="your-secure-secret-change-this"
export INITIAL_PASSWORD="your-password"

# Storage
export DATA_DIR="~/.originrouter"

# Server
export PORT="20128"
export NODE_ENV="production"

# Logging
export ENABLE_REQUEST_LOGS="false"
```

### Data Directory

**Vị trí mặc định:** `~/.originrouter`

**Nội dung:**
```
~/.originrouter/
  ├── db.json           # Database (providers, combos, usage)
  ├── api-keys.json     # API keys
  └── logs/             # Request logs (if enabled)
```

**Đổi vị trí:**

```bash
export DATA_DIR="/custom/path"
originrouter
```

### Cấu hình Port

**Port mặc định:** `20128`

**Đổi port:**

```bash
export PORT="3000"
originrouter
```

**Hoặc dùng command line:**

```bash
originrouter --port 3000
```

---

## Troubleshooting

### Port đã được dùng

**Lỗi:**
```
Error: listen EADDRINUSE: address already in use :::20128
```

**Giải pháp 1: Kill process hiện có**

```bash
# Find process using port 20128
lsof -i :20128

# Kill process
kill -9 <PID>
```

**Giải pháp 2: Dùng port khác**

```bash
originrouter --port 3000
```

### Permission Denied

**Lỗi:**
```
Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/originrouter'
```

**Giải pháp: Dùng sudo (không khuyến nghị) hoặc fix npm permissions**

```bash
# Fix npm permissions (recommended)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Then install again
curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
```

### Node.js Phiên bản quá cũ

**Lỗi:**
```
Error: The engine "node" is incompatible with this module
```

**Giải pháp: Cập nhật Node.js**

```bash
# Using nvm (recommended)
nvm install 20
nvm use 20

# Or download from nodejs.org
```

### Dashboard không mở

**Vấn đề:** Dashboard không tự mở

**Giải pháp 1: Mở thủ công**

```
http://localhost:20128
```

**Giải pháp 2: Kiểm tra firewall**

```bash
# macOS: Allow Node.js in System Preferences → Security
# Linux: Check iptables
# Windows: Check Windows Firewall
```

### Không kết nối được Provider

**Vấn đề:** OAuth login thất bại hoặc API key không hợp lệ

**Giải pháp 1: Kiểm tra kết nối internet**

```bash
ping google.com
```

**Giải pháp 2: Kiểm tra trạng thái provider**

- Claude Code: [status.anthropic.com](https://status.anthropic.com)
- OpenAI: [status.openai.com](https://status.openai.com)
- Gemini: [status.cloud.google.com](https://status.cloud.google.com)

**Giải pháp 3: Tạo lại API key**

```
Dashboard → Provider → Disconnect → Reconnect
```

### Sử dụng RAM cao

**Vấn đề:** OriginRouter dùng quá nhiều RAM

**Giải pháp: Khởi động lại server**

```bash
# Stop
pkill -f originrouter

# Start
originrouter
```

**Hoặc dùng PM2 để auto-restart:**

```bash
npm install -g pm2
pm2 start originrouter --name originrouter
pm2 save
```

---

## Tùy chọn Deployment

### Phát triển cục bộ

```bash
curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
originrouter
```

**Use case:** Code cá nhân, testing

### VPS/Cloud Server

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash

# Configure
export JWT_SECRET="your-secure-secret"
export INITIAL_PASSWORD="your-password"
export NODE_ENV="production"

# Start with PM2
npm install -g pm2
pm2 start originrouter --name originrouter
pm2 save
pm2 startup
```

**Use case:** Team access, remote coding

### Docker

```bash
docker pull originrouter/originrouter:latest

docker run -d \
  -p 20128:20128 \
  -e JWT_SECRET="your-secure-secret" \
  -e INITIAL_PASSWORD="your-password" \
  -v originrouter-data:/root/.originrouter \
  --name originrouter \
  originrouter/originrouter:latest
```

**Use case:** Containerized deployment, Kubernetes

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:20128;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        
        # SSE support for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

**Use case:** HTTPS, custom domain, load balancing

---

## Gỡ cài đặt

### Gỡ cài đặt

| Nền tảng | Cách làm |
|---|---|
| **Windows** | *Ứng dụng → Ứng dụng đã cài → OriginRouter*, hoặc chạy `%LOCALAPPDATA%\Programs\OriginRouter\unins000.exe` |
| **macOS / Linux** | `rm -rf ~/Applications/OriginRouter` (macOS) hoặc `~/.local/opt/origin-router` (Linux) |

Bản zip portable không có trình gỡ cài đặt — chỉ cần xóa thư mục bạn đã giải nén.

### Xóa Data Directory

```bash
rm -rf ~/.or
```

### Xóa Cấu hình

```bash
# Remove environment variables from shell config
nano ~/.bashrc  # or ~/.zshrc
# Delete originrouter-related exports
```

---

## Bước tiếp theo

- [Hướng dẫn Bắt đầu](../getting-started.md) - Kết nối provider và bắt đầu code
- [Tính năng](../features/) - Khám phá quota tracking, combos, deployment
- [Troubleshooting](../troubleshooting.md) - Sửa các vấn đề thường gặp

---

## Cần trợ giúp?

- **Website**: [originrouter.com](https://originrouter.com)
