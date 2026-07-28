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
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.UPLOAD_PASSWORD;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const B2_BUCKET = process.env.B2_BUCKET;
const SIGNED_URL_TTL = Math.min(86400, Math.max(300, Number(process.env.SIGNED_URL_TTL_SECONDS) || 14400));
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
  const operation = new Upload({ client: b2, params: { Bucket: B2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=3600' }, queueSize: 4, partSize: 10 * 1024 * 1024, leavePartsOnError: false });
  await operation.done();
  return { key };
};
const signedObjectUrl = key => getSignedUrl(b2, new GetObjectCommand({ Bucket: B2_BUCKET, Key: key }), { expiresIn: SIGNED_URL_TTL });
const withSignedUrls = async video => {
  const value = video?.toObject ? video.toObject() : { ...video };
  if (!value.videoKey || !value.thumbnailKey) return value;
  const [videoUrl, thumbnailUrl] = await Promise.all([signedObjectUrl(value.videoKey), signedObjectUrl(value.thumbnailKey)]);
  return { ...value, videoUrl, thumbnailUrl };
};
const deleteB2Objects = async keys => {
  const Objects = keys.filter(Boolean).map(Key => ({ Key }));
  if (Objects.length) await b2.send(new DeleteObjectsCommand({ Bucket: B2_BUCKET, Delete: { Objects, Quiet: true } }));
};
const placeholderThumbnail = title => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#111318"/><circle cx="480" cy="240" r="58" fill="#ff4d36"/><path d="M462 205v70l58-35z" fill="white"/><text x="480" y="360" fill="white" font-family="Arial,sans-serif" font-size="30" text-anchor="middle">${String(title).replace(/[&<>"']/g, '')}</text></svg>`);

const videoSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  category: { type: String, required: true, trim: true, maxlength: 60, index: true },
  tags: [{ type: String, trim: true, maxlength: 40 }], duration: { type: Number, default: 0, min: 0 },
  videoKey: { type: String, required: true }, thumbnailKey: { type: String, required: true },
  views: { type: Number, default: 0, min: 0, index: true }, likes: { type: Number, default: 0, min: 0 },
  uploadDate: { type: Date, default: Date.now, index: true }, createdBy: { type: String, default: 'Admin' },
  status: { type: String, enum: ['draft', 'published'], default: 'published', index: true },
}, { timestamps: true });
videoSchema.index({ title: 'text', description: 'text', category: 'text', tags: 'text' });
const Video = mongoose.model('Video', videoSchema);

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
mongoose.set('strictQuery', true);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], mediaSrc: ["'self'", 'https:'], connectSrc: ["'self'", 'https:'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
const clean = (value, max = 2000) => String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
const escapeRegex = value => clean(value, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAdmin = req => (req.get('x-admin-password') || req.body?.password || req.query?.password) === ADMIN_PASSWORD;
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Admin authentication required' });
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const upload = multer({ storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensionFor(file.originalname, file.mimetype, '.bin')}`) }), limits: { fileSize: 500 * 1024 * 1024, files: 2 }, fileFilter: (_req, file, cb) => { const valid = file.fieldname === 'video' ? file.mimetype.startsWith('video/') : file.mimetype.startsWith('image/'); cb(valid ? null : new Error('Only valid video and image files are allowed'), valid); } });
const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: 'b2' }));
app.get('/api/videos', async (req, res, next) => { try {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
  const filter = { status: 'published' };
  if (req.query.category) filter.category = new RegExp(`^${escapeRegex(req.query.category)}$`, 'i');
  if (req.query.q) { const q = new RegExp(escapeRegex(req.query.q), 'i'); filter.$or = [{ title: q }, { description: q }, { category: q }, { tags: q }]; }
  const sort = req.query.sort === 'trending' ? { views: -1, uploadDate: -1 } : { uploadDate: -1 };
  const [items, total] = await Promise.all([Video.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Video.countDocuments(filter)]);
  res.json({ items: await Promise.all(items.map(withSignedUrls)), page, pages: Math.ceil(total / limit), total });
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

app.post('/api/upload', uploadLimiter, uploadFields, requireAdmin, async (req, res, next) => {
  let uploadedKeys = [];
  try {
    const videoFile = req.files?.video?.[0], thumbnailFile = req.files?.thumbnail?.[0];
    if (!videoFile || !req.body.title?.trim() || !req.body.description?.trim() || !req.body.category?.trim()) return res.status(400).json({ error: 'Title, description, category and video are required' });
    const id = randomUUID(), videoKey = `videos/${id}${extensionFor(videoFile.originalname, videoFile.mimetype, '.mp4')}`;
    const thumbKey = `thumbnails/${id}${thumbnailFile ? extensionFor(thumbnailFile.originalname, thumbnailFile.mimetype, '.jpg') : '.svg'}`;
    const videoObject = await putB2Object({ key: videoKey, body: fs.createReadStream(videoFile.path), contentType: videoFile.mimetype }); uploadedKeys.push(videoKey);
    const thumbObject = await putB2Object({ key: thumbKey, body: thumbnailFile ? fs.createReadStream(thumbnailFile.path) : placeholderThumbnail(req.body.title), contentType: thumbnailFile?.mimetype || 'image/svg+xml' }); uploadedKeys.push(thumbKey);
    const video = await Video.create({ title: clean(req.body.title, 140), description: clean(req.body.description), category: clean(req.body.category, 60), tags: String(req.body.tags || '').split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20), duration: Math.max(0, Number(req.body.duration) || 0), videoKey: videoObject.key, thumbnailKey: thumbObject.key, status: req.body.status === 'draft' ? 'draft' : 'published' });
    res.status(201).json(await withSignedUrls(video));
  } catch (error) { await deleteB2Objects(uploadedKeys).catch(() => {}); next(error); }
  finally { await Promise.all(Object.values(req.files || {}).flat().map(file => file.path ? unlink(file.path).catch(() => {}) : null)); }
});
app.put('/api/videos/:id', requireAdmin, async (req, res) => { try { const update = {}; ['title', 'description', 'category', 'status'].forEach(key => { if (req.body[key] != null) update[key] = clean(req.body[key], key === 'description' ? 2000 : 140); }); if (req.body.tags != null) update.tags = String(req.body.tags).split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20); const video = await Video.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }); if (!video) return res.status(404).json({ error: 'Video not found' }); res.json(video); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete('/api/videos/:id', requireAdmin, async (req, res, next) => { try { const video = await Video.findById(req.params.id); if (!video) return res.status(404).json({ error: 'Video not found' }); await deleteB2Objects([video.videoKey, video.thumbnailKey]); await video.deleteOne(); res.json({ ok: true }); } catch (error) { next(error); } });

app.get('/robots.txt', (_req, res) => res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_URL}/sitemap.xml`));
app.get('/sitemap.xml', async (_req, res) => { const videos = await Video.find({ status: 'published' }).select('_id').lean(); const urls = ['', '/latest', '/trending', '/categories', ...videos.map(v => `/watch/${v._id}`)]; res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/sitemap/0.9">${urls.map(url => `<url><loc>${SITE_URL}${url}</loc></url>`).join('')}</urlset>`); });
const appRoutes = ['/', '/latest', '/trending', '/categories', '/category/:slug', '/watch/:videoId', '/search', '/admin', '/admin/upload', '/admin/video/:id', '/404'];
app.get(appRoutes, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' })); app.get('*', (_req, res) => res.redirect('/404'));
app.use((error, _req, res, _next) => { console.error(error); const status = error instanceof multer.MulterError ? 400 : 500; res.status(status).json({ error: status === 400 ? error.message : 'Something went wrong' }); });
let server;
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => { server = app.listen(PORT, () => console.log(`Server running at ${SITE_URL} with private Backblaze B2 storage`)); }).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
const shutdown = signal => { console.log(`${signal} received; shutting down`); server?.close(async () => { await mongoose.connection.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
