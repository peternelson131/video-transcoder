# Video Transcoder Service

FFmpeg-based video transcoding service for Instagram compatibility.

## Features
- Transcodes videos to H.264/AAC MP4 format
- Uses FFmpeg with `+faststart` flag for streaming optimization
- Uploads transcoded videos to Supabase Storage
- Returns public URL for transcoded video

## API

### POST /transcode
```json
{
  "videoUrl": "https://example.com/video.mp4"
}
```

Response:
```json
{
  "transcodedUrl": "https://supabase-storage-url/transcoded-video.mp4",
  "fileName": "transcoded-1234567890-abc123.mp4"
}
```

### GET /health
Health check endpoint.

## Environment Variables
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `PORT` - Server port (default: 3000)

## Deployment
Deployed to Railway. Service automatically scales based on usage.

## Storage
Transcoded videos are stored in the `social-media-temp` Supabase Storage bucket.
