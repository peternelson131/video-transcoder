const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'video-transcoder' });
});

// Transcode endpoint
app.post('/transcode', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  const tempDir = path.join('/tmp', crypto.randomBytes(16).toString('hex'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    console.log(`Transcoding request for: ${videoUrl}`);

    // Create temp directory
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download video
    console.log('Downloading video...');
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000, // 2 minute timeout
    });

    const writer = fs.createWriteStream(inputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('Video downloaded, transcoding...');

    // Transcode with FFmpeg
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libx264 -c:a aac -movflags +faststart -y "${outputPath}"`;
    const { stdout, stderr } = await execAsync(ffmpegCmd);

    console.log('Transcoding complete, uploading to Supabase...');

    // Read transcoded file
    const fileBuffer = await fs.promises.readFile(outputPath);
    const fileName = `transcoded-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('social-media-temp')
      .upload(fileName, fileBuffer, {
        contentType: 'video/mp4',
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      throw new Error(`Supabase upload error: ${error.message}`);
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('social-media-temp')
      .getPublicUrl(fileName);

    console.log(`Transcoding complete: ${publicUrl}`);

    // Cleanup temp files
    await fs.promises.rm(tempDir, { recursive: true, force: true });

    res.json({ 
      transcodedUrl: publicUrl,
      fileName: fileName 
    });

  } catch (error) {
    console.error('Transcoding error:', error);

    // Cleanup on error
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }

    res.status(500).json({ 
      error: 'Transcoding failed', 
      message: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Video transcoder service running on port ${PORT}`);
});
