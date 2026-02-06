const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tus = require('tus-js-client');
const jwt = require('jsonwebtoken');

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// In-memory job status tracking (for simple status endpoint)
// In production, this would be stored in Redis or the database
const jobStatus = new Map();

/**
 * Verify JWT token from Supabase Auth
 */
function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { success: false, error: 'Missing authorization header' };
  }

  const token = authHeader.substring(7);
  
  try {
    // If we have JWT secret, verify the token
    if (SUPABASE_JWT_SECRET) {
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);
      return { success: true, userId: decoded.sub, token };
    }
    
    // Fallback: decode without verification (less secure, but works without secret)
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.sub) {
      return { success: false, error: 'Invalid token' };
    }
    return { success: true, userId: decoded.sub, token };
  } catch (err) {
    return { success: false, error: 'Token verification failed: ' + err.message };
  }
}

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
        'x-upsert': 'true',
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

/**
 * Transcode video using FFmpeg
 * Returns path to transcoded file
 */
async function transcodeVideo(inputPath, outputPath) {
  // FFmpeg settings optimized for social media platforms:
  // - H.264 codec (universal compatibility)
  // - AAC audio
  // - CRF 23 (good quality without huge file size)
  // - 1080p max (scale down if larger)
  // - faststart for streaming
  const ffmpegCmd = `ffmpeg -i "${inputPath}" \
    -c:v libx264 \
    -preset medium \
    -crf 23 \
    -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" \
    -c:a aac \
    -b:a 128k \
    -movflags +faststart \
    -y "${outputPath}"`;
  
  await execAsync(ffmpegCmd);
  return outputPath;
}

/**
 * Process video: download, transcode, upload, update DB
 */
async function processVideo(jobId, videoRecord, userId) {
  const tempDir = path.join('/tmp', crypto.randomBytes(16).toString('hex'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    jobStatus.set(jobId, { status: 'processing', step: 'downloading', progress: 0 });

    // Create temp directory
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Get the storage URL for the uploaded video
    const { data: { publicUrl: sourceUrl } } = supabase.storage
      .from('product-videos')
      .getPublicUrl(videoRecord.storage_path);

    console.log(`[${jobId}] Downloading video from: ${sourceUrl}`);
    
    // Download video
    const response = await axios({
      method: 'get',
      url: sourceUrl,
      responseType: 'stream',
      timeout: 300000, // 5 minute timeout for large files
    });

    const writer = fs.createWriteStream(inputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const inputSize = fs.statSync(inputPath).size;
    console.log(`[${jobId}] Downloaded ${(inputSize / 1024 / 1024).toFixed(1)}MB, transcoding...`);
    jobStatus.set(jobId, { status: 'processing', step: 'transcoding', progress: 30 });

    // Transcode
    await transcodeVideo(inputPath, outputPath);

    const outputSize = fs.statSync(outputPath).size;
    console.log(`[${jobId}] Transcoded: ${(inputSize / 1024 / 1024).toFixed(1)}MB → ${(outputSize / 1024 / 1024).toFixed(1)}MB`);
    jobStatus.set(jobId, { status: 'processing', step: 'uploading', progress: 70 });

    // Upload transcoded video
    const transcodedFileName = `transcoded/${videoRecord.storage_path}`;
    await tusUpload('product-videos', outputPath, transcodedFileName, 'video/mp4');

    // Get public URL of transcoded video
    const { data: { publicUrl: transcodedUrl } } = supabase.storage
      .from('product-videos')
      .getPublicUrl(transcodedFileName);

    // Update database record
    const { error: updateError } = await supabase
      .from('product_videos')
      .update({
        upload_status: 'completed',
        transcoded_url: transcodedUrl,
        transcoded_at: new Date().toISOString(),
        file_size: outputSize,
      })
      .eq('id', videoRecord.id);

    if (updateError) {
      throw new Error(`Failed to update DB: ${updateError.message}`);
    }

    console.log(`[${jobId}] Processing complete: ${transcodedUrl}`);
    jobStatus.set(jobId, { 
      status: 'completed', 
      step: 'done', 
      progress: 100,
      transcodedUrl 
    });

    // Cleanup temp files
    await fs.promises.rm(tempDir, { recursive: true, force: true });

  } catch (error) {
    console.error(`[${jobId}] Processing error:`, error.message);
    
    // Update DB with error status
    await supabase
      .from('product_videos')
      .update({
        upload_status: 'failed',
        error_message: error.message,
      })
      .eq('id', videoRecord.id)
      .catch(err => console.error('Failed to update error status:', err));

    jobStatus.set(jobId, { 
      status: 'failed', 
      step: 'error', 
      error: error.message 
    });

    // Cleanup on error
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'video-transcoder', version: '2.0.0' });
});

/**
 * POST /api/video/register
 * Register a video after it's been uploaded to Supabase Storage
 * Saves metadata and triggers transcoding
 * 
 * Body: {
 *   storagePath: string,  // Path in product-videos bucket
 *   productId: string,    // UUID of sourced_product
 *   asin?: string,        // Optional ASIN
 *   title?: string        // Optional title
 * }
 */
app.post('/api/video/register', async (req, res) => {
  const auth = verifyAuth(req);
  if (!auth.success) {
    return res.status(401).json({ success: false, error: auth.error });
  }

  const { storagePath, productId, asin, title } = req.body;

  if (!storagePath) {
    return res.status(400).json({ success: false, error: 'storagePath is required' });
  }

  try {
    // Get storage URL
    const { data: { publicUrl: storageUrl } } = supabase.storage
      .from('product-videos')
      .getPublicUrl(storagePath);

    // Create video record in database
    const { data: videoRecord, error: insertError } = await supabase
      .from('product_videos')
      .insert({
        user_id: auth.userId,
        product_id: productId || null,
        asin: asin || null,
        title: title || null,
        storage_path: storagePath,
        storage_url: storageUrl,
        upload_status: 'processing',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to create video record: ${insertError.message}`);
    }

    // Generate job ID
    const jobId = `job_${videoRecord.id}`;

    // Start async transcoding (don't await)
    processVideo(jobId, videoRecord, auth.userId).catch(err => {
      console.error(`Background processing failed for ${jobId}:`, err);
    });

    res.json({
      success: true,
      videoId: videoRecord.id,
      jobId: jobId,
      status: 'processing',
      message: 'Video registered, transcoding started'
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/video/status/:jobId
 * Get transcoding job status
 */
app.get('/api/video/status/:jobId', async (req, res) => {
  const { jobId } = req.params;

  // Check in-memory status first
  const memStatus = jobStatus.get(jobId);
  if (memStatus) {
    return res.json({
      success: true,
      jobId,
      ...memStatus
    });
  }

  // Fallback: check database
  const videoId = jobId.replace('job_', '');
  const { data: video, error } = await supabase
    .from('product_videos')
    .select('id, upload_status, transcoded_url, error_message')
    .eq('id', videoId)
    .single();

  if (error || !video) {
    return res.status(404).json({ 
      success: false, 
      error: 'Job not found' 
    });
  }

  res.json({
    success: true,
    jobId,
    status: video.upload_status,
    transcodedUrl: video.transcoded_url,
    error: video.error_message
  });
});

// Legacy transcode endpoint (keep for backward compatibility)
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
    await transcodeVideo(inputPath, outputPath);

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
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
