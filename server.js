require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD; // strict password, .env se aata hai
const MONGODB_URI = process.env.MONGODB_URI;

if (!UPLOAD_PASSWORD) {
  console.error('ERROR: UPLOAD_PASSWORD .env file me set nahi hai. Server band ho raha hai.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

// ---------- DB MODEL ----------
const videoSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  videoUrl: { type: String, required: true },
  publicId: { type: String, required: true },
  thumbnailUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});
const Video = mongoose.model('Video', videoSchema);

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upload attempts par rate limit -> password brute force se bachne ke liye (strict security)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute
  max: 20, // 15 min me max 20 attempts
  message: { error: 'Bahut zyada attempts. 15 minute baad try karo.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max per video
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Sirf video files allowed hain'));
  },
});

// ---------- ROUTES ----------

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Public: sab videos list karo (naya sabse pehle)
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 });
    res.json(videos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Videos load nahi ho paayi' });
  }
});

// Protected: upload video + description (sirf sahi password ke saath)
app.post('/api/upload', uploadLimiter, upload.single('video'), async (req, res) => {
  try {
    const { password, description } = req.body;

    if (!password || password !== UPLOAD_PASSWORD) {
      return res.status(401).json({ error: 'Galat password' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Description zaroori hai' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Video file zaroori hai' });
    }

    // Cloudinary par video upload (stream se, memory buffer se seedha)
    const uploadFromBuffer = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: 'user-uploads',
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });

    const result = await uploadFromBuffer();

    const thumbnailUrl = cloudinary.url(result.public_id, {
      resource_type: 'video',
      format: 'jpg',
      transformation: [{ width: 400, crop: 'scale' }],
    });

    const video = await Video.create({
      description: description.trim(),
      videoUrl: result.secure_url,
      publicId: result.public_id,
      thumbnailUrl,
    });

    res.status(201).json(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Upload fail hua' });
  }
});

// Protected: video delete karo (optional, galti se upload hone par)
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password !== UPLOAD_PASSWORD) {
      return res.status(401).json({ error: 'Galat password' });
    }
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video nahi mili' });

    await cloudinary.uploader.destroy(video.publicId, { resource_type: 'video' });
    await video.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete fail hua' });
  }
});

app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
