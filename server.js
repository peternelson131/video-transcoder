const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tus = require('tus-js-client');

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

/**
 * Upload file to Supabase Storage using tus resumable upload protocol.
 * No file size limit — handles any video size reliably.
 */
function tusUpload(bucketName, filePath, fileName, contentType) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;

    const upload = new tus.Upload(fileStream, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000],
      headers: {
        authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucketName,
        objectName: fileName,
        contentType: contentType,
        cacheControl: '3600',
      },
      uploadSize: fileSize,
      onError: (error) => {
        console.error('tus upload error:', error.message);
        reject(new Error(`tus upload failed: ${error.message}`));
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
        console.log(`Upload progress: ${pct}% (${(bytesUploaded / 1024 / 1024).toFixed(1)}MB / ${(bytesTotal / 1024 / 1024).toFixed(1)}MB)`);
      },
      onSuccess: () => {
        console.log(`tus upload complete: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
        resolve();
      },
    });

    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length) {
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    });
  });
}

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

    // Download video (with optional Authorization header for OneDrive)
    console.log('Downloading video...');
    const headers = {};
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }
    
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000, // 2 minute timeout
      headers
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

    const outputSize = fs.statSync(outputPath).size;
    console.log(`Transcoding complete (${(outputSize / 1024 / 1024).toFixed(1)}MB), uploading to Supabase via tus...`);

    const fileName = `transcoded-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;

    // Upload via tus resumable protocol — no file size limit
    await tusUpload('social-media-temp', outputPath, fileName, 'video/mp4');

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('social-media-temp')
      .getPublicUrl(fileName);

    console.log(`Upload complete: ${publicUrl}`);

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
