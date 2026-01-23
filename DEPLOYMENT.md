# Deployment Instructions

## Manual Railway Deployment (Recommended)

Since Railway OAuth requires manual authentication, follow these steps:

### 1. Push to GitHub (Already Done ✓)
The code is already pushed to: https://github.com/peternelson131/video-transcoder

### 2. Deploy to Railway Manually

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose `peternelson131/video-transcoder`
5. Railway will auto-detect the Dockerfile and deploy

### 3. Set Environment Variables

In Railway project settings, add:
- `SUPABASE_URL`: `https://zxcdkanccbdeqebnabgg.supabase.co`
- `SUPABASE_SERVICE_KEY`: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4Y2RrYW5jY2JkZXFlYm5hYmdnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTAwNDA3MCwiZXhwIjoyMDc0NTgwMDcwfQ.r44KVS4730gbXbpkaW10wm4xJTX9imGi8sxOC64u2PU`

### 4. Get the Deployment URL

After deployment, Railway will give you a URL like: `https://video-transcoder-production-xxxx.up.railway.app`

Copy this URL and use it in the next step.

### 5. Update Netlify Environment Variable

Add to Netlify (ebay-price-reducer site):
- `TRANSCODER_URL`: `<your-railway-url>` (e.g., `https://video-transcoder-production-xxxx.up.railway.app`)

## Testing

Test the deployed service:

```bash
curl -X POST https://your-railway-url/transcode \\
  -H "Content-Type: application/json" \\
  -d '{"videoUrl": "https://example.com/test-video.mp4"}'
```

Expected response:
```json
{
  "transcodedUrl": "https://zxcdkanccbdeqebnabgg.supabase.co/storage/v1/object/public/social-media-temp/transcoded-xxxxx.mp4",
  "fileName": "transcoded-xxxxx.mp4"
}
```

## Alternative: Use Railway CLI

If you prefer CLI deployment:

```bash
# Login to Railway (opens browser)
railway login

# Link to the project
cd /Users/jcsdirect/clawd/projects/video-transcoder
railway link

# Add environment variables
railway variables set SUPABASE_URL=https://zxcdkanccbdeqebnabgg.supabase.co
railway variables set SUPABASE_SERVICE_KEY=<the-key>

# Deploy
railway up
```

## Troubleshooting

- **FFmpeg not found**: Railway should install it via Dockerfile. Check logs if missing.
- **Supabase upload fails**: Verify the `social-media-temp` bucket exists and is public.
- **Large videos timeout**: Consider increasing Railway's timeout or adding a job queue.
