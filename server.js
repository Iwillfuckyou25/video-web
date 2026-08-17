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
const { randomUUID, createHmac, createHash, timingSafeEqual } = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.UPLOAD_PASSWORD;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const B2_BUCKET = process.env.B2_BUCKET;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY = createHash('sha256').update(`${process.env.ADMIN_SESSION_SECRET || ''}:${ADMIN_PASSWORD || ''}:s3x-video-admin`).digest();
const PROCESSING_VERSION = 4;
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
const createVideoThumbnail = (input, output) => new Promise((resolve, reject) => {
  const args = ['-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=960:540:force_original_aspect_ratio=increase,crop=960:540', '-q:v', '3', output];
  const process = spawn(ffmpegPath, args, { windowsHide: true });
  let details = '';
  process.stderr.on('data', chunk => { details = `${details}${chunk}`.slice(-4000); });
  process.on('error', reject);
  process.on('close', code => code === 0 ? resolve() : reject(new Error(`Thumbnail generation failed (${code}): ${details}`)));
});
const probeVideoDuration = input => new Promise((resolve, reject) => {
  const process = spawn(ffmpegPath, ['-i', input], { windowsHide: true });
  let details = '';
  process.stderr.on('data', chunk => { details = `${details}${chunk}`.slice(-12000); });
  process.on('error', reject);
  process.on('close', () => {
    const match = details.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
    if (!match) return reject(new Error('Video duration could not be detected'));
    resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
  });
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
  autoThumbnailPending: { type: Boolean, default: false },
  targetStatus: { type: String, enum: ['draft', 'published'], default: 'published' },
  status: { type: String, enum: ['draft', 'published'], default: 'published', index: true },
}, { timestamps: true });
videoSchema.index({ title: 'text', description: 'text', category: 'text', tags: 'text' });
const Video = mongoose.model('Video', videoSchema);
const visitSchema = new mongoose.Schema({
  visitorId: { type: String, required: true, maxlength: 80, index: true },
  ip: { type: String, required: true, maxlength: 64, index: true },
  page: { type: String, required: true, maxlength: 300 },
  referrer: { type: String, default: '', maxlength: 500 },
  userAgent: { type: String, default: '', maxlength: 500 },
  browser: { type: String, default: 'Unknown', maxlength: 40 },
  os: { type: String, default: 'Unknown', maxlength: 40 },
  device: { type: String, default: 'Desktop', maxlength: 20 },
  language: { type: String, default: '', maxlength: 20 },
  screen: { type: String, default: '', maxlength: 20 },
  visitedAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { versionKey: false });
visitSchema.index({ visitorId: 1, visitedAt: -1 });
const Visit = mongoose.model('Visit', visitSchema);
const clientIp = req => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
const userAgentInfo = value => { const ua = String(value || ''); let browser = 'Other'; if (/Edg\//i.test(ua)) browser = 'Edge'; else if (/OPR\//i.test(ua)) browser = 'Opera'; else if (/Chrome\//i.test(ua)) browser = 'Chrome'; else if (/Firefox\//i.test(ua)) browser = 'Firefox'; else if (/Safari\//i.test(ua)) browser = 'Safari'; let os = 'Other'; if (/Windows/i.test(ua)) os = 'Windows'; else if (/Android/i.test(ua)) os = 'Android'; else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS'; else if (/Mac OS/i.test(ua)) os = 'macOS'; else if (/Linux/i.test(ua)) os = 'Linux'; const device = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobile|Android|iPhone|iPod/i.test(ua) ? 'Mobile' : 'Desktop'; return { browser, os, device }; };
const activeProcessing = new Set();
const processVideoVariants = async ({ videoId, inputPath: suppliedInputPath, id }) => {
  const lockId = String(videoId);
  if (activeProcessing.size || activeProcessing.has(lockId)) return;
  activeProcessing.add(lockId);
  let inputPath = suppliedInputPath;
  const output480 = path.join(os.tmpdir(), `${id}-480p.mp4`), output720 = path.join(os.tmpdir(), `${id}-720p.mp4`), outputThumbnail = path.join(os.tmpdir(), `${id}-thumbnail.jpg`);
  const key480 = `videos/${id}-480p.mp4`, key720 = `videos/${id}-720p.mp4`, autoThumbnailKey = `thumbnails/${id}-auto.jpg`;
  const createdKeys = [];
  try {
    const video = await Video.findById(videoId).lean();
    if (!video) return;
    if (!inputPath) {
      inputPath = path.join(os.tmpdir(), `${id}-source${path.extname(video.videoKey) || '.mp4'}`);
      const object = await b2.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: video.videoKey }));
      await pipeline(object.Body, fs.createWriteStream(inputPath));
    }
    const detectedDuration = await probeVideoDuration(inputPath).catch(() => Number(video.duration) || 0);
    const processingAttempts = video.processingVersion === PROCESSING_VERSION ? (video.processingAttempts || 0) + 1 : 1;
    const targetStatus = video.targetStatus || video.status || 'published';
    await Video.updateOne({ _id: videoId }, { $set: { processingStatus: 'processing', processingError: '', processingStartedAt: new Date(), processingAttempts, processingVersion: PROCESSING_VERSION, targetStatus, status: 'draft' } });
    const needsAutoThumbnail = video.autoThumbnailPending || /\.svg$/i.test(video.thumbnailKey || '');
    let finalThumbnailKey = video.thumbnailKey;
    if (needsAutoThumbnail) {
      await createVideoThumbnail(inputPath, outputThumbnail);
      await putB2Object({ key: autoThumbnailKey, body: fs.createReadStream(outputThumbnail), contentType: 'image/jpeg' }); createdKeys.push(autoThumbnailKey);
      finalThumbnailKey = autoThumbnailKey;
      await Video.updateOne({ _id: videoId }, { $set: { thumbnailKey: autoThumbnailKey, autoThumbnailPending: false } });
      await deleteB2Objects([video.thumbnailKey]).catch(() => {});
    }
    const existing480 = (video.sources || []).find(source => source.label === '480p');
    const existing720 = (video.sources || []).find(source => source.label === '720p');
    const final480Key = existing480?.key || key480;
    if (!existing480) {
      await transcodeVideo(inputPath, output480, 480, '900k', '64k', 29);
      await putB2Object({ key: key480, body: fs.createReadStream(output480), contentType: 'video/mp4' }); createdKeys.push(key480);
      await Video.updateOne({ _id: videoId }, { $set: { sources: [{ label: '480p', key: key480 }, { label: 'Original', key: video.videoKey }] } });
    }
    const final720Key = existing720?.key || key720;
    if (!existing720) {
      await transcodeVideo(inputPath, output720, 720, '1800k', '96k', 27);
      await putB2Object({ key: key720, body: fs.createReadStream(output720), contentType: 'video/mp4' }); createdKeys.push(key720);
    }
    await Video.updateOne({ _id: videoId }, { $set: { thumbnailKey: finalThumbnailKey, sources: [{ label: '480p', key: final480Key }, { label: '720p', key: final720Key }, { label: 'Original', key: video.videoKey }], duration: detectedDuration, processingStatus: 'ready', status: targetStatus, autoThumbnailPending: false } });
    const staleVariantKeys = (video.sources || []).map(source => source.key).filter(key => key !== video.videoKey && key !== final480Key && key !== final720Key && !createdKeys.includes(key));
    await deleteB2Objects(staleVariantKeys).catch(() => {});
  } catch (error) {
    console.error(`Background video processing failed for ${videoId}:`, error.message);
    await Video.updateOne({ _id: videoId }, { $set: { processingStatus: 'failed', processingError: clean(error.message, 500) } }).catch(() => {});
  } finally {
    await Promise.all([inputPath, output480, output720, outputThumbnail].map(file => unlink(file).catch(() => {})));
    activeProcessing.delete(lockId);
    setTimeout(() => resumePendingProcessing().catch(error => console.error('Queued processing failed:', error.message)), 0).unref();
  }
};
const resumePendingProcessing = async () => {
  if (activeProcessing.size) return;
  const incompleteMedia = { $or: [{ sources: { $not: { $elemMatch: { label: '720p' } } } }, { autoThumbnailPending: true }, { thumbnailKey: /\.svg$/i }] };
  let video = await Video.findOne({ ...incompleteMedia, processingStatus: { $in: ['queued', 'processing'] } }).sort({ uploadDate: 1 }).lean();
  if (!video) video = await Video.findOne({
    $and: [
      incompleteMedia,
      { $or: [
        { processingStatus: { $exists: false } },
        { processingStatus: 'failed', processingVersion: { $ne: PROCESSING_VERSION } },
        { processingStatus: 'failed', processingVersion: PROCESSING_VERSION, processingAttempts: { $lt: 3 } },
      ] },
    ],
  }).sort({ uploadDate: 1 }).lean();
  if (!video) video = await Video.findOne({ ...incompleteMedia, processingStatus: 'ready' }).sort({ uploadDate: 1 }).lean();
  if (video) processVideoVariants({ videoId: video._id, id: randomUUID() });
};
let durationBackfillActive = false;
const backfillMissingDuration = async () => {
  if (durationBackfillActive || activeProcessing.size) return;
  const video = await Video.findOne({ processingStatus: 'ready', duration: { $lte: 0 } }).sort({ uploadDate: 1 }).lean();
  if (!video) return;
  durationBackfillActive = true;
  const source = (video.sources || []).find(item => item.label === '480p') || (video.sources || [])[0] || { key: video.videoKey };
  const inputPath = path.join(os.tmpdir(), `${video._id}-duration${path.extname(source.key) || '.mp4'}`);
  try {
    const object = await b2.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: source.key }));
    await pipeline(object.Body, fs.createWriteStream(inputPath));
    const duration = await probeVideoDuration(inputPath);
    if (duration > 0) await Video.updateOne({ _id: video._id }, { $set: { duration } });
  } catch (error) {
    console.error(`Duration backfill failed for ${video._id}:`, error.message);
  } finally {
    await unlink(inputPath).catch(() => {});
    durationBackfillActive = false;
  }
};

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
mongoose.set('strictQuery', true);
app.use((req, res, next) => { const canonicalHost = new URL(SITE_URL).host.toLowerCase(), requestHost = String(req.get('host') || '').toLowerCase(); if (IS_PRODUCTION && ['GET', 'HEAD'].includes(req.method) && !req.path.startsWith('/api/') && requestHost && requestHost !== canonicalHost) return res.redirect(301, `${SITE_URL}${req.originalUrl}`); next(); });
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://www.googletagmanager.com'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], mediaSrc: ["'self'", 'https:'], connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com'], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, strictTransportSecurity: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false }));
app.use(compression());
app.use(express.json({ limit: '128kb', strict: true })); app.use(express.urlencoded({ extended: false, limit: '128kb', parameterLimit: 30 }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true, dotfiles: 'deny', index: false }));
const clean = (value, max = 2000) => String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
const escapeRegex = value => clean(value, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeEqual = (a, b) => { const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || '')); return left.length === right.length && timingSafeEqual(left, right); };
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || '')]));
const signSession = payload => { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${encoded}.${createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url')}`; };
const readSession = req => { try { const token = parseCookies(req).s3x_admin; if (!token) return null; const [encoded, signature] = token.split('.'); const expected = createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url'); if (!safeEqual(signature, expected)) return null; const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); return payload.exp > Date.now() && typeof payload.csrf === 'string' ? payload : null; } catch { return null; } };
const requireAdmin = (req, res, next) => { const session = readSession(req); if (!session) return res.status(401).json({ error: 'Admin authentication required' }); req.adminSession = session; next(); };
const requireSameOrigin = (req, res, next) => { const origin = req.get('origin'); let allowed=false; try { const supplied=new URL(origin); const configured=new URL(SITE_URL); const requestHost=String(req.get('host')||'').toLowerCase(); allowed=supplied.protocol==='https:'&&(supplied.host.toLowerCase()===requestHost||supplied.origin===configured.origin); if (!IS_PRODUCTION) allowed=allowed||(supplied.protocol==='http:'&&supplied.host.toLowerCase()===requestHost); } catch {} if (!allowed) return res.status(403).json({ error: 'Request origin rejected' }); next(); };
const requireCsrf = (req, res, next) => safeEqual(req.get('x-csrf-token'), req.adminSession?.csrf) ? next() : res.status(403).json({ error: 'Security token expired. Please log in again.' });
const rejectUnsafeKeys = (value, depth = 0) => { if (depth > 8 || value == null || typeof value !== 'object') return false; return Object.entries(value).some(([key, child]) => key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key) || rejectUnsafeKeys(child, depth + 1)); };
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (rejectUnsafeKeys(req.body) || rejectUnsafeKeys(req.query) || rejectUnsafeKeys(req.params)) return res.status(400).json({ error: 'Invalid request data' }); next(); });
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const adminWriteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many admin changes. Try again later.' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Upload limit reached. Try again later.' } });
const visitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Visit limit reached.' } });
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
const allowedVideoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']);
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({ storage: b2UploadStorage, limits: { fileSize: 500 * 1024 * 1024, files: 2, fields: 8, parts: 10, fieldSize: 32 * 1024 }, fileFilter: (_req, file, cb) => { const ext=path.extname(file.originalname||'').toLowerCase(); const videoExts=new Set(['.mp4','.webm','.mov','.mkv']), imageExts=new Set(['.jpg','.jpeg','.png','.webp']); const valid = file.fieldname === 'video' ? (allowedVideoTypes.has(file.mimetype)||((file.mimetype==='application/octet-stream'||!file.mimetype)&&videoExts.has(ext))) : file.fieldname === 'thumbnail' && (allowedImageTypes.has(file.mimetype)||((file.mimetype==='application/octet-stream'||!file.mimetype)&&imageExts.has(ext))); if(!valid){const error=new multer.MulterError('LIMIT_UNEXPECTED_FILE',file.fieldname);error.message='Unsupported file type. Use MP4, WebM, MOV, MKV, JPG, PNG or WebP.';return cb(error)}cb(null,true); } });
const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: 'b2', uploadMode: 'resumable-processing', activeProcessing: activeProcessing.size }));
app.get('/api/site-info', (_req, res) => res.json({ legalContactEmail: clean(process.env.LEGAL_CONTACT_EMAIL, 254) }));
app.post('/api/admin/login', loginLimiter, requireSameOrigin, (req, res) => {
  if (!safeEqual(req.body?.password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Invalid admin password' });
  const csrf = randomUUID();
  res.cookie('s3x_admin', signSession({ exp: Date.now() + ADMIN_SESSION_TTL_MS, csrf }), { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'strict', maxAge: ADMIN_SESSION_TTL_MS, path: '/' });
  res.json({ ok: true, csrf });
});
app.post('/api/admin/logout', requireAdmin, requireSameOrigin, requireCsrf, (_req, res) => { res.clearCookie('s3x_admin', { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'strict', path: '/' }); res.json({ ok: true }); });
app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ ok: true, csrf: req.adminSession.csrf }));
app.post('/api/visits', visitLimiter, requireSameOrigin, async (req, res, next) => { try {
  const page = clean(req.body?.page, 300);
  if (!page.startsWith('/') || page.startsWith('/admin')) return res.status(204).end();
  const visitorId = clean(req.body?.visitorId, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  if (visitorId.length < 10) return res.status(400).json({ error: 'Invalid visitor id' });
  const agent = clean(req.get('user-agent'), 500), info = userAgentInfo(agent);
  await Visit.create({ visitorId, ip: clientIp(req), page, referrer: clean(req.body?.referrer, 500), userAgent: agent, ...info, language: clean(req.body?.language, 20), screen: clean(req.body?.screen, 20), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  res.status(204).end();
} catch (error) { next(error); } });
app.get('/api/videos', async (req, res, next) => { try {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(48, Math.max(1, Number(req.query.limit) || 12));
  const filter = { status: 'published', processingStatus: 'ready' };
  if (req.query.category) filter.category = new RegExp(`^${escapeRegex(req.query.category)}$`, 'i');
  if (req.query.q) { const q = new RegExp(escapeRegex(req.query.q), 'i'); filter.$or = [{ title: q }, { description: q }, { category: q }, { tags: q }]; }
  const sort = req.query.sort === 'trending' ? { views: -1, uploadDate: -1 } : { uploadDate: -1 };
  const [items, total] = await Promise.all([Video.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Video.countDocuments(filter)]);
  res.json({ items: await Promise.all(items.map(withSignedUrls)), page, pages: Math.ceil(total / limit), total });
} catch (error) { next(error); } });
app.get('/api/videos/:id/status', async (req, res, next) => { try {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' });
  const video = await Video.findOne({ _id: req.params.id, status: 'published', processingStatus: 'ready' }).select('videoKey thumbnailKey sources processingStatus').lean();
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const signed = await withSignedUrls(video);
  res.json({ processingStatus: video.processingStatus, sources: signed.sources });
} catch (error) { next(error); } });
app.get('/api/videos/:id', async (req, res, next) => { try {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' });
  const video = await Video.findOneAndUpdate({ _id: req.params.id, status: 'published', processingStatus: 'ready' }, { $inc: { views: 1 } }, { new: true }).lean();
  if (!video) return res.status(404).json({ error: 'Video not found' });
  let related = await Video.find({ _id: { $ne: video._id }, status: 'published', processingStatus: 'ready', $or: [{ category: video.category }, { tags: { $in: video.tags || [] } }] }).sort({ uploadDate: -1 }).limit(8).lean();
  if (!related.length) related = await Video.find({ _id: { $ne: video._id }, status: 'published', processingStatus: 'ready' }).sort({ uploadDate: -1 }).limit(8).lean();
  res.json({ video: await withSignedUrls(video), related: await Promise.all(related.map(withSignedUrls)) });
} catch (error) { next(error); } });
app.get('/api/categories', async (_req, res, next) => { try {
  const items = await Video.aggregate([{ $match: { status: 'published', processingStatus: 'ready' } }, { $group: { _id: '$category', count: { $sum: 1 }, views: { $sum: '$views' }, thumbnailKey: { $first: '$thumbnailKey' } } }, { $sort: { count: -1 } }]);
  res.json(await Promise.all(items.map(async x => ({ name: x._id, slug: String(x._id).toLowerCase().replace(/[^a-z0-9]+/g, '-'), count: x.count, views: x.views, thumbnailUrl: x.thumbnailKey ? await signedObjectUrl(x.thumbnailKey) : '' }))));
} catch (error) { next(error); } });
app.get('/api/admin/videos/:id', requireAdmin, async (req, res) => { try { const video = await Video.findById(req.params.id).lean(); if (!video) return res.status(404).json({ error: 'Video not found' }); res.json({ video: await withSignedUrls(video) }); } catch (_error) { res.status(400).json({ error: 'Invalid video id' }); } });
app.get('/api/admin/stats', requireAdmin, async (_req, res, next) => { try { const ready = { processingStatus: 'ready' }; const [totalVideos, readyVideos, views, latest] = await Promise.all([Video.countDocuments({}), Video.countDocuments(ready), Video.aggregate([{ $match: ready }, { $group: { _id: null, totalViews: { $sum: '$views' } } }]), Video.find({}).sort({ uploadDate: -1 }).limit(20).lean()]); res.json({ totalVideos, readyVideos, totalViews: views[0]?.totalViews || 0, latest: await Promise.all(latest.map(withSignedUrls)), storage: 'Private Backblaze B2' }); } catch (error) { next(error); } });
app.get('/api/admin/visits', requireAdmin, async (req, res, next) => { try {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7)), since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const match = { visitedAt: { $gte: since } };
  const [totalVisits, uniqueIds, recent, daily, topPages] = await Promise.all([
    Visit.countDocuments(match), Visit.distinct('visitorId', match), Visit.find(match).sort({ visitedAt: -1 }).limit(100).lean(),
    Visit.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt' } }, visits: { $sum: 1 }, visitors: { $addToSet: '$visitorId' } } }, { $project: { _id: 0, date: '$_id', visits: 1, uniqueVisitors: { $size: '$visitors' } } }, { $sort: { date: 1 } }]),
    Visit.aggregate([{ $match: match }, { $group: { _id: '$page', visits: { $sum: 1 } } }, { $sort: { visits: -1 } }, { $limit: 8 }, { $project: { _id: 0, page: '$_id', visits: 1 } }]),
  ]);
  res.json({ days, totalVisits, uniqueVisitors: uniqueIds.length, recent, daily, topPages, retentionDays: 30 });
} catch (error) { next(error); } });

app.post('/api/upload', uploadLimiter, requireAdmin, requireSameOrigin, uploadFields, async (req, res, next) => {
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
    const targetStatus = req.body.status === 'draft' ? 'draft' : 'published';
    const video = await Video.create({ title: clean(req.body.title, 140), description: clean(req.body.description), category: clean(req.body.category, 60), tags: String(req.body.tags || '').split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20), duration: Math.max(0, Number(req.body.duration) || 0), videoKey: originalKey, thumbnailKey: thumbKey, sources: [{ label: 'Original', key: originalKey }], processingStatus: 'queued', autoThumbnailPending: !thumbnailFile, targetStatus, status: 'draft' });
    res.status(201).json(await withSignedUrls(video));
    processVideoVariants({ videoId: video._id, id });
  } catch (error) { await deleteB2Objects(uploadedKeys).catch(() => {}); next(error); }
});
app.put('/api/videos/:id', adminWriteLimiter, requireAdmin, requireSameOrigin, requireCsrf, async (req, res) => { try { if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' }); const current = await Video.findById(req.params.id); if (!current) return res.status(404).json({ error: 'Video not found' }); const update = {}; ['title', 'description', 'category'].forEach(key => { if (req.body[key] != null) update[key] = clean(req.body[key], key === 'description' ? 2000 : key === 'category' ? 60 : 140); }); if (req.body.status != null) { update.targetStatus = req.body.status === 'draft' ? 'draft' : 'published'; if (current.processingStatus === 'ready') update.status = update.targetStatus; } if (req.body.tags != null) update.tags = String(req.body.tags).split(',').map(t => clean(t, 40)).filter(Boolean).slice(0, 20); const video = await Video.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true }); res.json(video); } catch (_error) { res.status(400).json({ error: 'Invalid video data' }); } });
app.delete('/api/videos/:id', adminWriteLimiter, requireAdmin, requireSameOrigin, requireCsrf, async (req, res, next) => { try { if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ error: 'Invalid video id' }); const video = await Video.findById(req.params.id); if (!video) return res.status(404).json({ error: 'Video not found' }); await deleteB2Objects([...new Set([video.videoKey, video.thumbnailKey, ...(video.sources || []).map(source => source.key)])]); await video.deleteOne(); res.json({ ok: true }); } catch (error) { next(error); } });

const seoTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const STATIC_LAST_MODIFIED = fs.statSync(path.join(__dirname, 'public', 'index.html')).mtime.toISOString();
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const xmlEscape = value => htmlEscape(value);
const absoluteUrl = pathname => `${SITE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
const seoPage = ({ title, description, canonical, type = 'website', image = '', body = '', robots = 'index,follow,max-image-preview:large,max-video-preview:-1', schema }) => {
  const safeTitle = htmlEscape(title), safeDescription = htmlEscape(description), safeCanonical = htmlEscape(canonical), safeImage = htmlEscape(image);
  let html = seoTemplate
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${safeDescription}">`)
    .replace(/<meta name="robots"[^>]*>/i, `<meta name="robots" content="${htmlEscape(robots)}">`)
    .replace(/<meta property="og:type"[^>]*>/i, `<meta property="og:type" content="${htmlEscape(type)}">`)
    .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${safeTitle}">`)
    .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${safeDescription}">`)
    .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${safeCanonical}">`)
    .replace(/<meta name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${safeTitle}">`)
    .replace(/<meta name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${safeDescription}">`)
    .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" id="canonical" href="${safeCanonical}">`);
  if (image) html = html.replace('</head>', `<meta property="og:image" content="${safeImage}"><meta name="twitter:image" content="${safeImage}"></head>`);
  if (schema) html = html.replace('</head>', `<script id="serverSeoSchema" type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script></head>`);
  if (body) html = html.replace(/<main id="app" tabindex="-1">[\s\S]*?<\/main>/i, `<main id="app" tabindex="-1">${body}</main>`);
  return html;
};
const staticSeo = {
  '/': ['S3X Video — Latest and trending videos', 'Discover newly added and trending adult videos on S3X Video. Browse categories and watch videos in multiple quality options.'],
  '/latest': ['Latest videos — S3X Video', 'Browse the newest adult videos recently added to S3X Video.'],
  '/trending': ['Trending videos — S3X Video', 'Discover the adult videos currently trending on S3X Video.'],
  '/categories': ['Video categories — S3X Video', 'Browse S3X Video by category and find videos that match your interests.'],
  '/privacy': ['Privacy Policy — S3X Video', 'Read how S3X Video handles visitor information, analytics, storage and privacy requests.'],
  '/terms': ['Terms of Service — S3X Video', 'Read the terms and acceptable-use rules for accessing S3X Video.'],
  '/copyright': ['Copyright and takedown policy — S3X Video', 'Learn how to submit copyright reports and takedown requests to S3X Video.'],
  '/18-plus': ['18+ Disclaimer — S3X Video', 'S3X Video is intended only for adults who meet the legal age requirement in their location.'],
  '/contact': ['Contact and grievance — S3X Video', 'Contact S3X Video about privacy, safety, copyright or access concerns.'],
};
const seoVideoList = videos => videos.length
  ? `<ul>${videos.map(video => `<li><a href="/watch/${video._id}">${htmlEscape(video.title)}</a>${video.category ? ` — <a href="/category/${encodeURIComponent(String(video.category).toLowerCase().replace(/\s+/g, '-'))}">${htmlEscape(video.category)}</a>` : ''}${video.description ? `<p>${htmlEscape(clean(video.description, 180))}</p>` : ''}</li>`).join('')}</ul>`
  : '<p>New videos are being prepared. Check back soon.</p>';

app.get('/media/:id/thumbnail', async (req, res, next) => { try { if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.sendStatus(404); const video = await Video.findOne({ _id: req.params.id, status: 'published', processingStatus: 'ready' }).select('thumbnailKey').lean(); if (!video) return res.sendStatus(404); res.set('Cache-Control', 'public, max-age=3600').redirect(302, await signedObjectUrl(video.thumbnailKey)); } catch (error) { next(error); } });
app.get('/media/:id/video', async (req, res, next) => { try { if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.sendStatus(404); const video = await Video.findOne({ _id: req.params.id, status: 'published', processingStatus: 'ready' }).select('videoKey sources').lean(); if (!video) return res.sendStatus(404); const key = video.sources?.find(source => source.label === '480p')?.key || video.videoKey; res.set('Cache-Control', 'public, max-age=900').redirect(302, await signedObjectUrl(key)); } catch (error) { next(error); } });

app.get('/watch/:videoId', async (req, res, next) => { try {
  if (!mongoose.isObjectIdOrHexString(req.params.videoId)) return res.status(404).send(seoPage({ title: 'Video not found — S3X Video', description: 'The requested video could not be found.', canonical: absoluteUrl('/404'), robots: 'noindex,follow' }));
  const video = await Video.findOne({ _id: req.params.videoId, status: 'published', processingStatus: 'ready' }).lean();
  if (!video) return res.status(404).send(seoPage({ title: 'Video not found — S3X Video', description: 'The requested video could not be found.', canonical: absoluteUrl('/404'), robots: 'noindex,follow' }));
  const canonical = absoluteUrl(`/watch/${video._id}`), thumbnail = absoluteUrl(`/media/${video._id}/thumbnail`), contentUrl = absoluteUrl(`/media/${video._id}/video`);
  const description = clean(video.description, 155) || `Watch ${video.title} on S3X Video.`;
  const schema = { '@context': 'https://schema.org', '@type': 'VideoObject', name: video.title, description, thumbnailUrl: [thumbnail], uploadDate: new Date(video.uploadDate || video.createdAt).toISOString(), contentUrl, embedUrl: canonical, isFamilyFriendly: false };
  if (video.duration > 0) schema.duration = `PT${Math.round(video.duration)}S`;
  const body = `<article class="seo-video-summary"><h1>${htmlEscape(video.title)}</h1><p>${htmlEscape(description)}</p><p>${htmlEscape(video.category)} · ${new Date(video.uploadDate || video.createdAt).toLocaleDateString('en-US')}</p><noscript><p>JavaScript is required to play this video.</p></noscript></article>`;
  res.type('html').send(seoPage({ title: `${video.title} — S3X Video`, description, canonical, type: 'video.other', image: thumbnail, body, schema }));
} catch (error) { next(error); } });

app.get('/robots.txt', (_req, res) => res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\nSitemap: ${SITE_URL}/video-sitemap.xml`));
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));
app.get('/sitemap.xml', async (_req, res, next) => { try { const videos = await Video.find({ status: 'published', processingStatus: 'ready' }).select('_id updatedAt').lean(); const fixed = Object.keys(staticSeo); const urls = [...fixed.map(url => ({ url, lastmod: STATIC_LAST_MODIFIED })), ...videos.map(video => ({ url: `/watch/${video._id}`, lastmod: new Date(video.updatedAt || STATIC_LAST_MODIFIED).toISOString() }))]; res.set('Cache-Control', 'public, max-age=3600').type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/sitemap/0.9">${urls.map(item => `<url><loc>${xmlEscape(absoluteUrl(item.url))}</loc><lastmod>${item.lastmod}</lastmod></url>`).join('')}</urlset>`); } catch (error) { next(error); } });
app.get('/video-sitemap.xml', async (_req, res, next) => { try { const videos = await Video.find({ status: 'published', processingStatus: 'ready' }).sort({ uploadDate: -1 }).limit(1000).lean(); res.set('Cache-Control', 'public, max-age=3600').type('xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${videos.map(video => `<url><loc>${xmlEscape(absoluteUrl(`/watch/${video._id}`))}</loc><video:video><video:thumbnail_loc>${xmlEscape(absoluteUrl(`/media/${video._id}/thumbnail`))}</video:thumbnail_loc><video:title>${xmlEscape(video.title)}</video:title><video:description>${xmlEscape(clean(video.description, 1800) || video.title)}</video:description><video:content_loc>${xmlEscape(absoluteUrl(`/media/${video._id}/video`))}</video:content_loc><video:publication_date>${new Date(video.uploadDate || video.createdAt).toISOString()}</video:publication_date><video:family_friendly>no</video:family_friendly></video:video></url>`).join('')}</urlset>`); } catch (error) { next(error); } });
app.get('/category/:slug', async (req, res, next) => { try { const rawLabel = clean(req.params.slug, 60).replace(/-/g, ' '); const label = rawLabel.replace(/\b\w/g, character => character.toUpperCase()); const videos = await Video.find({ status: 'published', processingStatus: 'ready', category: new RegExp(`^${escapeRegex(rawLabel)}$`, 'i') }).sort({ uploadDate: -1 }).limit(24).select('_id title description category').lean(); res.type('html').send(seoPage({ title: `${label} videos — S3X Video`, description: `Browse ${label} adult videos on S3X Video.`, canonical: absoluteUrl(`/category/${encodeURIComponent(req.params.slug)}`), body: `<section class="seo-video-summary"><h1>${htmlEscape(label)} videos</h1><p>Browse recently added videos in the ${htmlEscape(label)} category.</p>${seoVideoList(videos)}</section>` })); } catch (error) { next(error); } });
app.get('/search', (req, res) => { const query = clean(req.query.q, 80); res.type('html').send(seoPage({ title: query ? `Search results for ${query} — S3X Video` : 'Search — S3X Video', description: 'Search videos, categories and tags on S3X Video.', canonical: absoluteUrl('/search'), robots: 'noindex,follow' })); });
app.get(['/admin', '/admin/upload', '/admin/video/:id', '/404'], (req, res) => res.type('html').send(seoPage({ title: req.path.startsWith('/admin') ? 'Admin — S3X Video' : 'Page not found — S3X Video', description: 'S3X Video', canonical: absoluteUrl(req.path), robots: 'noindex,nofollow' })));
app.get(Object.keys(staticSeo), async (req, res, next) => { try { const [title, description] = staticSeo[req.path]; const schema = req.path === '/' ? { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: 'S3X Video', url: SITE_URL, publisher: { '@id': `${SITE_URL}/#organization` }, potentialAction: { '@type': 'SearchAction', target: `${SITE_URL}/search?q={search_term_string}`, 'query-input': 'required name=search_term_string' } }, { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: 'S3X Video', url: SITE_URL, logo: { '@type': 'ImageObject', url: `${SITE_URL}/favicon.svg`, width: 512, height: 512 } }] } : undefined; let body = `<section class="seo-video-summary"><h1>${htmlEscape(title.replace(/ — S3X Video$/, ''))}</h1><p>${htmlEscape(description)}</p>`; if (['/', '/latest', '/trending'].includes(req.path)) { const sort = req.path === '/trending' ? { views: -1, uploadDate: -1 } : { uploadDate: -1 }; const videos = await Video.find({ status: 'published', processingStatus: 'ready' }).sort(sort).limit(12).select('_id title description category').lean(); body += `<h2>${req.path === '/trending' ? 'Popular videos' : 'Recently added videos'}</h2>${seoVideoList(videos)}`; } else if (req.path === '/categories') { const categories = await Video.distinct('category', { status: 'published', processingStatus: 'ready' }); body += `<h2>Browse categories</h2><ul>${categories.filter(Boolean).sort().map(category => `<li><a href="/category/${encodeURIComponent(String(category).toLowerCase().replace(/\s+/g, '-'))}">${htmlEscape(category)} videos</a></li>`).join('')}</ul>`; } body += '</section>'; res.type('html').send(seoPage({ title, description, canonical: absoluteUrl(req.path), body, schema })); } catch (error) { next(error); } });
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' })); app.get('*', (_req, res) => res.redirect('/404'));
app.use((error, _req, res, _next) => { console.error(error); const status = error instanceof multer.MulterError || error?.type === 'entity.too.large' || error instanceof SyntaxError ? 400 : 500; res.status(status).json({ error: status === 400 ? 'Invalid or oversized request' : 'Something went wrong' }); });
let server;
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(async () => {
  await Video.updateMany({ thumbnailKey: /\.svg$/i }, { $set: { autoThumbnailPending: true, processingStatus: 'queued' } });
  server = app.listen(PORT, () => {
    console.log(`Server running at ${SITE_URL} with private Backblaze B2 storage`);
    resumePendingProcessing().catch(error => console.error('Processing recovery failed:', error.message));
    backfillMissingDuration().catch(error => console.error('Duration recovery failed:', error.message));
  });
  setInterval(() => resumePendingProcessing().catch(error => console.error('Processing recovery failed:', error.message)), 60000).unref();
  setInterval(() => backfillMissingDuration().catch(error => console.error('Duration recovery failed:', error.message)), 60000).unref();
}).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
const shutdown = signal => { console.log(`${signal} received; shutting down`); server?.close(async () => { await mongoose.connection.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
