const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const app = express();
app.set('trust proxy', 1); // Respect Apache's X-Forwarded-For headers
const PORT = process.env.PORT || 3000;

// ==========================================
// Configuration
// ==========================================
const DEBUG_MODE = true; 
const LOG_FILE = path.join(__dirname, 'server.log');

// Target Server Setup
const BOORU_DOMAIN = 'https://vrfg.eu';
const OUTBOUND_USER_AGENT = 'SkyeCA/VRCWorld/BooruBrowser';

// Image Cache Setup
const CACHE_DIR = path.join(__dirname, 'image_cache');
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024; 
const TARGET_CACHE_SIZE_BYTES = 450 * 1024 * 1024; 

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Info Cache Setup
const INFO_CACHE_DIR = path.join(__dirname, 'info_cache');
const INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; 

if (!fs.existsSync(INFO_CACHE_DIR)) {
    fs.mkdirSync(INFO_CACHE_DIR, { recursive: true });
}

// Memory Maps
const apiCache = new Map(); 
const activeDownloads = new Map(); 
const activeInfoRequests = new Map(); 

// ==========================================
// Helper Functions
// ==========================================

const logToFile = (message) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFile(LOG_FILE, logEntry, (err) => {
        if (err) console.error("Failed to write to log file:", err);
    });
};

const sendErrorImage = (res, errorMessage) => {
    const width = 800;
    const height = 450; 
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#222222';
    ctx.fillRect(0, 0, width, height);

    ctx.font = 'bold 30px Arial, sans-serif';
    ctx.fillStyle = '#ff5555';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText(`Error: ${errorMessage}`, width / 2, height / 2, width - 40);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store'); 

    const stream = canvas.createJPEGStream();
    stream.pipe(res);
};

const enforceCacheLimit = async () => {
    try {
        const files = await fs.promises.readdir(CACHE_DIR);
        let totalSize = 0;
        const fileStats = [];

        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = await fs.promises.stat(filePath);
            totalSize += stats.size;
            fileStats.push({ file, filePath, size: stats.size, mtime: stats.mtime.getTime() });
        }

        if (totalSize <= MAX_CACHE_SIZE_BYTES) return;

        logToFile(`CACHE LIMIT EXCEEDED | Current: ${(totalSize / 1024 / 1024).toFixed(2)}MB. Cleaning old files...`);
        fileStats.sort((a, b) => a.mtime - b.mtime);

        let bytesToRemove = totalSize - TARGET_CACHE_SIZE_BYTES;

        for (const fileInfo of fileStats) {
            if (bytesToRemove <= 0) break;
            if (activeDownloads.has(fileInfo.file)) continue;

            try {
                await fs.promises.unlink(fileInfo.filePath);
                bytesToRemove -= fileInfo.size;
            } catch (err) {
                console.error(`Failed to delete old cache file ${fileInfo.file}:`, err);
            }
        }
    } catch (error) {
        console.error("Error running cache cleanup:", error);
    }
};

// ==========================================
// Middlewares
// ==========================================

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || 'Unknown';
    logToFile(`REQUEST | IP: ${ip} | URL: ${req.originalUrl} | UA: ${userAgent}`);
    next();
});

const enforceVRChatAgent = (req, res, next) => {
    if (DEBUG_MODE) return next();

    const userAgent = req.get('User-Agent') || '';
    if (!userAgent.startsWith('VRChat')) {
        logToFile(`DENIED | Invalid User-Agent: ${userAgent} | IP: ${req.ip}`);
        return res.status(403).send('DENIED');
    }
    next();
};

const imageRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 3,
    skip: (req, res) => {
        const postId = req.query.id;
        if (!postId) return false; 
        return fs.existsSync(path.join(CACHE_DIR, postId));
    },
    handler: (req, res) => {
        logToFile(`RATE LIMIT EXCEEDED (/image) | IP: ${req.ip}`);
        res.status(200); 
        sendErrorImage(res, "Rate Limit Exceeded: Too many requests. Please wait 5 seconds.");
    }
});

const infoRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 3,
    skip: (req, res) => {
        const postId = req.query.id;
        if (!postId) return false; 
        
        const localFilePath = path.join(INFO_CACHE_DIR, `${postId}.json`);
        if (fs.existsSync(localFilePath)) {
            const stats = fs.statSync(localFilePath);
            if (Date.now() - stats.mtimeMs < INFO_CACHE_TTL_MS) return true;
        }
        return false;
    },
    handler: (req, res) => {
        logToFile(`RATE LIMIT EXCEEDED (/info) | IP: ${req.ip}`);
        res.status(200).json({ error: "Rate Limit Exceeded: Too many requests. Please wait 5 seconds." });
    }
});

// ==========================================
// Endpoints
// ==========================================

app.get('/health', (req, res) => {
    res.send('OK');
});

// --- IMAGE ENDPOINT ---
app.get('/image', enforceVRChatAgent, imageRateLimiter, async (req, res) => {
    const postId = req.query.id;

    if (!postId) {
        logToFile(`ERROR | Missing 'id' parameter | IP: ${req.ip}`);
        return sendErrorImage(res, "Missing 'id' parameter in URL");
    }

    const localFilePath = path.join(CACHE_DIR, postId);

    try {
        if (fs.existsSync(localFilePath)) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return fs.createReadStream(localFilePath).pipe(res);
        }

        if (activeDownloads.has(postId)) {
            await activeDownloads.get(postId); 
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return fs.createReadStream(localFilePath).pipe(res);
        }

        const downloadProcess = (async () => {
            let absoluteImageUrl;

            if (apiCache.has(postId)) {
                absoluteImageUrl = apiCache.get(postId);
            } else {
                const apiUrl = `${BOORU_DOMAIN}/api/post/${postId}`;
                const apiResponse = await axios.get(apiUrl, {
                    headers: { 'Accept': 'application/json', 'User-Agent': OUTBOUND_USER_AGENT }
                }).catch(err => {
                    throw new Error(`API Error (HTTP ${err.response?.status || err.message})`);
                });
                
                const postData = apiResponse.data;
                const contentType = postData.mimeType || ''; 

                if (!contentType) throw new Error("Could not determine media type");
                if (contentType.startsWith('video/') || contentType === 'image/gif') {
                     throw new Error(`Media type rejected: ${contentType}`);
                }
                if (!postData.contentUrl) throw new Error("JSON missing 'contentUrl'");
                
                absoluteImageUrl = new URL(postData.contentUrl, BOORU_DOMAIN).href;
                apiCache.set(postId, absoluteImageUrl); 
            }

            const imageResponse = await axios({
                url: absoluteImageUrl,
                method: 'GET',
                responseType: 'stream',
                headers: { 'User-Agent': OUTBOUND_USER_AGENT }
            });

            const transformer = sharp()
                .resize({
                    width: 1920,
                    height: 1080,
                    fit: sharp.fit.contain,
                    background: { r: 0, g: 0, b: 0, alpha: 1 } 
                })
                .jpeg({ quality: 90 }); 

            const writer = fs.createWriteStream(localFilePath);
            imageResponse.data.pipe(transformer).pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                transformer.on('error', reject);
            });
        })();

        activeDownloads.set(postId, downloadProcess);
        await downloadProcess;
        activeDownloads.delete(postId);

        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(localFilePath).pipe(res);

        enforceCacheLimit(); 

    } catch (error) {
        activeDownloads.delete(postId);
        logToFile(`ERROR | /image ID: ${postId} | Msg: ${error.message}`);
        // Ensure VRChat sees the error image by throwing a 200 OK
        res.status(200);
        sendErrorImage(res, error.message);
    }
});

// --- INFO ENDPOINT ---
app.get('/info', enforceVRChatAgent, infoRateLimiter, async (req, res) => {
    const postId = req.query.id;

    if (!postId) {
        logToFile(`ERROR | /info missing 'id' | IP: ${req.ip}`);
        return res.status(200).json({ error: "Missing 'id' parameter" });
    }

    const localFilePath = path.join(INFO_CACHE_DIR, `${postId}.json`);

    try {
        if (fs.existsSync(localFilePath)) {
            const stats = await fs.promises.stat(localFilePath);
            if (Date.now() - stats.mtimeMs < INFO_CACHE_TTL_MS) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'public, max-age=604800'); 
                return fs.createReadStream(localFilePath).pipe(res);
            } else {
                await fs.promises.unlink(localFilePath).catch(() => {});
            }
        }

        if (activeInfoRequests.has(postId)) {
            await activeInfoRequests.get(postId);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=604800');
            return fs.createReadStream(localFilePath).pipe(res);
        }

        const fetchInfoProcess = (async () => {
            const apiUrl = `${BOORU_DOMAIN}/api/post/${postId}`;
            const apiResponse = await axios.get(apiUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': OUTBOUND_USER_AGENT }
            }).catch(err => {
                throw new Error(`API Error (HTTP ${err.response?.status || err.message})`);
            });

            const data = apiResponse.data;
            const parsedTags = data.tags ? data.tags.map(t => t.names ? t.names[0] : t.name || t) : [];

            const metadata = {
                id: postId,
                uploader: data.user?.name || "Unknown",
                uploadDate: data.creationTime || "Unknown",
                tags: parsedTags.join(", ")
            };

            await fs.promises.writeFile(localFilePath, JSON.stringify(metadata, null, 2));
        })();

        activeInfoRequests.set(postId, fetchInfoProcess);
        await fetchInfoProcess;
        activeInfoRequests.delete(postId);

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        fs.createReadStream(localFilePath).pipe(res);

    } catch (error) {
        activeInfoRequests.delete(postId);
        logToFile(`ERROR | /info ID: ${postId} | Msg: ${error.message}`);
        res.status(200).json({ error: error.message });
    }
});

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Debug Mode is: ${DEBUG_MODE ? 'ON' : 'OFF'}`);
    console.log(`Target Booru: ${BOORU_DOMAIN}`);
});