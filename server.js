require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { S3Client, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { unlink } = require('fs/promises');
const { pipeline } = require('stream/promises');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.UPLOAD_PASSWORD;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const B2_BUCKET = process.env.B2_BUCKET;
const PROCESSING_VERSION = 3;
const SIGNED_URL_TTL = Math.min(86400, Math.max(300, Number(process.env.SIGNED_URL_TTL_SECONDS) || 14400));
const B2_CACHE_CONTROL = `private, max-age=${SIGNED_URL_TTL}, immutable`;
const required = ['UPLOAD_PASSWORD', 'MONGODB_URI', 'B2_ENDPOINT', 'B2_REGION', 'B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) { console.error(`Missing required environment variables: ${missing.join(', ')}`); process.exit(1); }

const b2 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APPLICATION_KEY },
  forcePathStyle: true,
});
const extensionFor = (name, mime, fallback) => {
  const ext = path.extname(name || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (ext && ext.length <= 8) return ext;
  const subtype = String(mime || '').split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/g, '');
  return subtype ? `.${subtype}` : fallback;
};
const putB2Object = async ({ key, body, contentType }) => {
  const operation = new Upload({ client: b2, params: { Bucket: B2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: B2_CACHE_CONTROL }, queueSize: 4, partSize: 10 * 1024 * 1024, leavePartsOnError: false });
  await operation.done();
  return { key };
};
const signedObjectUrl = key => getSignedUrl(b2, new GetObjectCommand({ Bucket: B2_BUCKET, Key: key }), { expiresIn: SIGNED_URL_TTL });
const withSignedUrls = async video => {
  const value = video?.toObject ? video.toObject() : { ...video };
  if (!value.videoKey || !value.thumbnailKey) return value;
  const storedSources = value.sources?.length ? value.sources : [{ label: 'Original', key: value.videoKey }];
  const [thumbnailUrl, sources] = await Promise.all([
    signedObjectUrl(value.thumbnailKey),
    Promise.all(storedSources.map(async source => ({ label: source.label, url: await signedObjectUrl(source.key) }))),
  ]);
  return { ...value, videoUrl: sources[0].url, thumbnailUrl, sources };
};
const deleteB2Objects = async keys => {
  const Objects = keys.filter(Boolean).map(Key => ({ Key }));
  if (Objects.length) await b2.send(new DeleteObjectsCommand({ Bucket: B2_BUCKET, Delete: { Objects, Quiet: true } }));
};
const placeholderThumbnail = title => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#111318"/><circle cx="480" cy="240" r="58" fill="#ff4d36"/><path d="M462 205v70l58-35z" fill="white"/><text x="480" y="360" fill="white" font-family="Arial,sans-serif" font-size="30" text-anchor="middle">${String(title).replace(/[&<>"']/g, '')}</text></svg>`);
const transcodeVideo = (input, output, height, maxRate, audioRate, crf) => new Promise((resolve, reject) => {
  const args = ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-maxrate', maxRate, '-bufsize', `${parseInt(maxRate, 10) * 2}k`, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', audioRate, '-movflags', '+faststart', output];
  const process = spawn(ffmpegPath, args, { windowsHide: true });
  let details = '';
  process.stderr.on('data', chunk => { details = `${details}${chunk}`.slice(-4000); });
  process.on('error', reject);
  process.on('close', code => code === 0 ? resolve() : reject(new Error(`Video optimization failed (${code}): ${details}`)));
});

const videoSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  category: { type: String, required: true, trim: true, maxlength: 60, index: true },
  tags: [{ type: String, trim: true, maxlength: 40 }], duration: { type: Number, default: 0, min: 0 },
  videoKey: { type: String, required: true }, thumbnailKey: { type: String, required: true },
  sources: [{ label: { type: String, required: true }, key: { type: String, required: true } }],
  views: { type: Number, default: 0, min: 0, index: true }, likes: { type: Number, default: 0, min: 0 },
  uploadDate: { type: Date, default: Date.now, index: true }, createdBy: { type: String, default: 'Admin' },
  processingStatus: { type: String, enum: ['queued', 'processing', 'ready', 'failed'], default: 'queued' },
  processingError: { type: String, default: '' }, processingStartedAt: Date,
  processingAttempts: { type: Number, default: 0, min: 0 },
  processingVersion: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['draft', 'published'], default: 'published', index: true },
}, { timestamps: true });
videoSchema.index({ title: 'text', description: 'text', category: 'text', tags: 'text' });
const Video = mongoose.model('Video', videoSchema);
const activeProcessing = new Set();
const processVideoVariants = async ({ videoId, inputPath: suppliedInputPath, id }) => {
  const lockId = String(videoId);
  if (activeProcessing.size || activeProcessing.has(lockId)) return;
  activeProcessing.add(lockId);
  let inputPath = suppliedInputPath;
  const output480 = path.join(os.tmpdir(), `${id}-480p.mp4`), output720 = path.join(os.tmpdir(), `${id}-720p.mp4`);
  const key480 = `videos/${id}-480p.mp4`, key720 = `videos/${id}-720p.mp4`;
  const createdKeys = [];
  try {
    const video = await Video.findById(videoId).lean();
    if (!video) return;
    if (!inputPath) {
      inputPath = path.join(os.tmpdir(), `${id}-source${path.extname(video.videoKey) || '.mp4'}`);
      const object = await b2.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: video.videoKey }));
      await pipeline(object.Body, fs.createWriteStream(inputPath));
    }
    const processingAttempts = video.processingVersion === PROCESSING_VERSION ? (video.processingAttempts || 0) + 1 : 1;
    await Video.updateOne({ _id: videoId }, { $set: { processingStatus: 'processing', processingError: '', processingStartedAt: new Date(), processingAttempts, processingVersion: PROCESSING_VERSION } });
    const existing480 = (video.sources || []).find(source => source.label === '480p');
    const final480Key = existing480?.key || key480;
    if (!existing480) {
      await transcodeVideo(inputPath, output480, 480, '900k', '64k', 29);
      await putB2Object({ key: key480, body: fs.createReadStream(output480), contentType: 'video/mp4' }); createdKeys.push(key480);
      await Video.updateOne({ _id: videoId }, { $set: { sources: [{ label: '480p', key: key480 }, { label: 'Original', key: video.videoKey }] } });
    }
    await transcodeVideo(inputPath, output720, 720, '1800k', '96k', 27);
    await putB2Object({ key: key720, body: fs.createReadStream(output720), contentType: 'video/mp4' }); createdKeys.push(key720);
    await Video.updateOne({ _id: videoId }, { $set: { sources: [{ label: '480p', key: final480Key }, { label: '720p', key: key720 }, { label: 'Original', key: video.videoKey }], processingStatus: 'ready' } });
    const staleVariantKeys = (video.sources || []).map(source => source.key).filter(key => key !== video.videoKey && key !== final480Key && !createdKeys.includes(key));
    await deleteB2Objects(staleVariantKeys).catch(() => {});
  } catch (error) {
    console.error(`Background video processing failed for ${videoId}:`, error.message);
    await Video.updateOne({ _id: videoId }, { $set: { processingStatus: 'failed', processingError: clean(error.message, 500) } }).catch(() => {});
  } finally {
    await Promise.all([inputPath, output480, output720].map(file => unlink(file).catch(() => {})));
    activeProcessing.delete(lockId);
  }
};
const resumePendingProcessing = async () => {
  if (activeProcessing.size) return;
  const missing720 = { $not: { $elemMatch: { label: '720p' } } };
  let video = await Video.findOne({ sources: missing720, processingStatus: { $in: ['queued', 'processing'] } }).sort({ uploadDate: 1 }).lean();
  if (!video) video = await Video.findOne({
    sources: missing720,
    $or: [
      { processingStatus: { $exists: false } },
      { processingStatus: 'failed', processingVersion: { $ne: PROCESSING_VERSION } },
      { processingStatus: 'failed', processingVersion: PROCESSING_VERSION, processingAttempts: { $lt: 3 } },
    ],
  }).sort({ uploadDate: 1 }).lean();
  if (video) processVideoVariants({ videoId: video._id, id: randomUUID() });
};

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
mongoose.set('strictQuery', true);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://www.googletagmanager.com'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], mediaSrc: ["'self'", 'https:'], connectSrc: ["'self'", 'https:', 'https://www.google-analytics.com', 'https://region1.google-analytics.com'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
const clean = (value, max = 2000) => String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
const escapeRegex = value => clean(value, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAdmin = req => (req.get('x-admin-password') || req.body?.password || req.query?.password) === ADMIN_PASSWORD;
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Admin authentication required' });
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const b2UploadStorage = {
  _handleFile(_req, file, cb) {
    const id = randomUUID();
    const folder = file.fieldname === 'video' ? 'videos' : 'thumbnails';
    const fallback = file.fieldname === 'video' ? '.mp4' : '.jpg';
    const key = `${folder}/${id}${file.fieldname === 'video' ? '-original' : ''}${extensionFor(file.originalname, file.mimetype, fallback)}`;
    let size = 0;
    file.stream.on('data', chunk => { size += chunk.length; });
    const operation = new Upload({ client: b2, params: { Bucket: B2_BUCKET, Key: key, Body: file.stream, ContentType: file.mimetype, CacheControl: B2_CACHE_CONTROL }, queueSize: 4, partSize: 10 * 1024 * 1024, leavePartsOnError: false });
    operation.done().then(() => cb(null, { key, size })).catch(cb);
  },
  _removeFile(_req, file, cb) { deleteB2Objects([file.key]).then(() => cb()).catch(cb); },
};
const upload = multer({ storage: b2UploadStorage, limits: { fileSize: 500 * 1024 * 1024, files: 2 }, fileFilter: (_req, file, cb) => { const valid = file.fieldname === 'video' ? file.mimetype.startsWith('video/') : file.mimetype.startsWith('image/'); cb(valid ? null : new Error('Only valid video and image files are allowed'), valid); } });
const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: 'b2', uploadMode: 'resumable-processing', activeProcessing: activeProcessing.size }));
app.get('/api/videos', async (req, res, next) => { try {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
  const filter = { status: 'published' };
  if (req.query.category) filter.category = new RegExp(`^${escapeRegex(req.query.category)}$`, 'i');
  if (req.query.q) { const q = new RegExp(escapeRegex(req.query.q), 'i'); filter.$or = [{ title: q }, { description: q }, { category: q }, { tags: q }]; }
  const sort = req.query.sort === 'trending' ? { views: -1, uploadDate: -1 } : { uploadDate: -1 };
  const [items, total] = await Promise.all([Video.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Video.countDocuments(filter)]);
  res.json({ items: await Promise.all(items.map(withSignedUrls)), page, pages: Math.ceil(total / limit), total });
} catch (error) { next(error); } });
app.get('/api/videos/:id/status', async (req, res, next) => { try {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' });
  const video = await Video.findOne({ _id: req.params.id, status: 'published' }).select('videoKey thumbnailKey sources processingStatus').lean();
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const signed = await withSignedUrls(video);
  res.json({ processingStatus: video.processingStatus, sources: signed.sources });
} catch (error) { next(error); } });
app.get('/api/videos/:id', async (req, res, next) => { try {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' });
  const video = await Video.findOneAndUpdate({ _id: req.params.id, status: 'published' }, { $inc: { views: 1 } }, { new: true }).lean();
  if (!video) return res.status(404).json({ error: 'Video not found' });
  let related = await Video.find({ _id: { $ne: video._id }, status: 'published', $or: [{ category: video.category }, { tags: { $in: video.tags || [] } }] }).sort({ uploadDate: -1 }).limit(8).lean();
  if (!related.length) related = await Video.find({ _id: { $ne: video._id }, status: 'published' }).sort({ uploadDate: -1 }).limit(8).lean();
  res.json({ video: await withSignedUrls(video), related: await Promise.all(related.map(withSignedUrls)) });
} catch (error) { next(error); } });
app.get('/api/categories', async (_req, res, next) => { try {
  const items = await Video.aggregate([{ $match: { status: 'published' } }, { $group: { _id: '$category', count: { $sum: 1 }, views: { $sum: '$views' }, thumbnailKey: { $first: '$thumbnailKey' } } }, { $sort: { count: -1 } }]);
  res.json(await Promise.all(items.map(async x => ({ name: x._id, slug: String(x._id).toLowerCase().replace(/[^a-z0-9]+/g, '-'), count: x.count, views: x.views, thumbnailUrl: x.thumbnailKey ? await signedObjectUrl(x.thumbnailKey) : '' }))));
} catch (error) { next(error); } });
app.get('/api/admin/videos/:id', requireAdmin, async (req, res) => { try { const video = await Video.findById(req.params.id).lean(); if (!video) return res.status(404).json({ error: 'Video not found' }); res.json({ video: await withSignedUrls(video) }); } catch (_error) { res.status(400).json({ error: 'Invalid video id' }); } });
app.get('/api/admin/stats', requireAdmin, async (_req, res, next) => { try { const [totalVideos, views, latest] = await Promise.all([Video.countDocuments(), Video.aggregate([{ $group: { _id: null, totalViews: { $sum: '$views' } } }]), Video.find().sort({ uploadDate: -1 }).limit(12).lean()]); res.json({ totalVideos, totalViews: views[0]?.totalViews || 0, latest: await Promise.all(latest.map(withSignedUrls)), storage: 'Private Backblaze B2' }); } catch (error) { next(error); } });

app.post('/api/upload', uploadLimiter, requireAdmin, uploadFields, async (req, res, next) => {
  let uploadedKeys = [];
  try {
    const videoFile = req.files?.video?.[0], thumbnailFile = req.files?.thumbnail?.[0];
    uploadedKeys = [videoFile?.key, thumbnailFile?.key].filter(Boolean);
    if (!videoFile || !req.body.title?.trim() || !req.body.description?.trim() || !req.body.category?.trim()) {
      await deleteB2Objects(uploadedKeys).catch(() => {});
      return res.status(400).json({ error: 'Title, description, category and video are required' });
    }
    const id = randomUUID(), originalKey = videoFile.key;
    let thumbKey = thumbnailFile?.key;
    if (!thumbKey) {
      thumbKey = `thumbnails/${id}.svg`;
      await putB2Object({ key: thumbKey, body: placeholderThumbnail(req.body.title), contentType: 'image/svg+xml' });
      uploadedKeys.push(thumbKey);
    }
    const video = await Video.create({ title: clean(req.body.title, 140), description: clean(req.body.description), category: clean(req.body.category, 60), tags: String(req.body.tags || '').split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20), duration: Math.max(0, Number(req.body.duration) || 0), videoKey: originalKey, thumbnailKey: thumbKey, sources: [{ label: 'Original', key: originalKey }], processingStatus: 'queued', status: req.body.status === 'draft' ? 'draft' : 'published' });
    res.status(201).json(await withSignedUrls(video));
    processVideoVariants({ videoId: video._id, id });
  } catch (error) { await deleteB2Objects(uploadedKeys).catch(() => {}); next(error); }
});
app.put('/api/videos/:id', requireAdmin, async (req, res) => { try { const update = {}; ['title', 'description', 'category', 'status'].forEach(key => { if (req.body[key] != null) update[key] = clean(req.body[key], key === 'description' ? 2000 : 140); }); if (req.body.tags != null) update.tags = String(req.body.tags).split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20); const video = await Video.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }); if (!video) return res.status(404).json({ error: 'Video not found' }); res.json(video); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete('/api/videos/:id', requireAdmin, async (req, res, next) => { try { const video = await Video.findById(req.params.id); if (!video) return res.status(404).json({ error: 'Video not found' }); await deleteB2Objects([...new Set([video.videoKey, video.thumbnailKey, ...(video.sources || []).map(source => source.key)])]); await video.deleteOne(); res.json({ ok: true }); } catch (error) { next(error); } });

app.get('/robots.txt', (_req, res) => res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_URL}/sitemap.xml`));
app.get('/sitemap.xml', async (_req, res) => { const videos = await Video.find({ status: 'published' }).select('_id').lean(); const urls = ['', '/latest', '/trending', '/categories', ...videos.map(v => `/watch/${v._id}`)]; res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/sitemap/0.9">${urls.map(url => `<url><loc>${SITE_URL}${url}</loc></url>`).join('')}</urlset>`); });
const appRoutes = ['/', '/latest', '/trending', '/categories', '/category/:slug', '/watch/:videoId', '/search', '/admin', '/admin/upload', '/admin/video/:id', '/404'];
app.get(appRoutes, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' })); app.get('*', (_req, res) => res.redirect('/404'));
app.use((error, _req, res, _next) => { console.error(error); const status = error instanceof multer.MulterError ? 400 : 500; res.status(status).json({ error: status === 400 ? error.message : 'Something went wrong' }); });
let server;
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => {
  server = app.listen(PORT, () => {
    console.log(`Server running at ${SITE_URL} with private Backblaze B2 storage`);
    resumePendingProcessing().catch(error => console.error('Processing recovery failed:', error.message));
  });
  setInterval(() => resumePendingProcessing().catch(error => console.error('Processing recovery failed:', error.message)), 60000).unref();
}).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
const shutdown = signal => { console.log(`${signal} received; shutting down`); server?.close(async () => { await mongoose.connection.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
