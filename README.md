# Video Transcoder Service

Unified video upload registration and transcoding service for OpSyncPro.

## Endpoints

### Health Check
```
GET /health
```
Returns service status.

### Register Video (NEW)
```
POST /api/video/register
Authorization: Bearer <supabase_jwt>
Content-Type: application/json

{
  "storagePath": "userId/productId/video.mp4",
  "productId": "uuid",
  "asin": "B0XXXXXXXX",
  "title": "Optional title"
}
```

Registers a video after it's been uploaded to Supabase Storage. Saves metadata to `product_videos` table and triggers async transcoding.

**Response:**
```json
{
  "success": true,
  "videoId": "uuid",
  "jobId": "job_uuid",
  "status": "processing",
  "message": "Video registered, transcoding started"
}
```

### Check Status (NEW)
```
GET /api/video/status/:jobId
```

Returns transcoding job status.

**Response:**
```json
{
  "success": true,
  "jobId": "job_uuid",
  "status": "completed",
  "step": "done",
  "progress": 100,
  "transcodedUrl": "https://..."
}
```

Status values: `processing`, `completed`, `failed`

### Legacy Transcode
```
POST /transcode
Content-Type: application/json

{
  "videoUrl": "https://..."
}
```

Downloads video from URL, transcodes, and uploads to `social-media-temp` bucket.
Kept for backward compatibility.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | JWT secret for token verification |

## Flow

1. Frontend uploads video directly to Supabase Storage (tus protocol)
2. Frontend calls `/api/video/register` with storage path
3. Service creates `product_videos` record with status `processing`
4. Service downloads video, transcodes with FFmpeg, uploads transcoded version
5. Service updates `product_videos` with `completed` status and transcoded URL
6. Frontend can poll `/api/video/status/:jobId` for progress

## FFmpeg Settings

Optimized for social media platforms:
- H.264 video codec
- AAC audio at 128kbps
- CRF 23 (balanced quality/size)
- Max 1080p resolution
- faststart flag for streaming

## Deployment

Railway with FFmpeg buildpack. See DEPLOYMENT.md for details.

### Environments
- **Staging:** Points to UAT Supabase
- **Production:** Points to Production Supabase
