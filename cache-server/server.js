require('dotenv').config();

const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { LRUCache } = require('lru-cache');

const app = express();
app.set('trust proxy', 1); // Respect Apache's X-Forwarded-For headers
const PORT = process.env.PORT || 3000;

// ==========================================
// Configuration
// ==========================================
const DEBUG_MODE = false; 
const LOG_FILE = path.join(__dirname, 'server.log');

// Target Server Setup
const BOORU_DOMAIN = 'https://vrfg.eu';
const OUTBOUND_USER_AGENT = 'SkyeCA/VRCWorld/BooruBrowser';

// Post IDs are only ever used to build on-disk cache paths and outbound API
// URLs, so they're restricted to a safe charset to prevent path traversal
// (e.g. id=../../../../etc/passwd) reaching fs calls in the endpoints below.
const VALID_ID_REGEX = /^[A-Za-z0-9_-]+$/;

// Auth Setup
const BOORU_USERNAME = process.env.BOORU_USERNAME || '';
const BOORU_API_TOKEN = process.env.BOORU_API_TOKEN || '';

// Image Cache Setup
const CACHE_DIR = path.join(__dirname, 'image_cache');
const MAX_CACHE_SIZE_BYTES = 1000 * 1024 * 1024; 
const TARGET_CACHE_SIZE_BYTES = 950 * 1024 * 1024; 

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Info Cache Setup
const INFO_CACHE_DIR = path.join(__dirname, 'info_cache');
const INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; 

if (!fs.existsSync(INFO_CACHE_DIR)) {
    fs.mkdirSync(INFO_CACHE_DIR, { recursive: true });
}

// Stats Cache Setup
const STATS_CACHE_DIR = path.join(__dirname, 'stats_cache');
const STATS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // matches the Cache-Control max-age sent below

if (!fs.existsSync(STATS_CACHE_DIR)) {
    fs.mkdirSync(STATS_CACHE_DIR, { recursive: true });
}

// User Check-in Persistence Setup
const CHECKIN_FILE = path.join(__dirname, 'checkins.json');
let checkinData = {};

if (fs.existsSync(CHECKIN_FILE)) {
    try {
        checkinData = JSON.parse(fs.readFileSync(CHECKIN_FILE, 'utf8'));
    } catch (err) {
        console.error("Error reading checkins file:", err);
    }
}

// Memory Maps & Cache
const apiCache = new LRUCache({ max: 5000 }); // Fix 1: Caps RAM usage
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

// Debounced Disk Writing for Data Integrity
let writeTimeout = null;

const saveCheckins = () => {
    if (writeTimeout) clearTimeout(writeTimeout);
    
    writeTimeout = setTimeout(() => {
        fs.writeFile(CHECKIN_FILE, JSON.stringify(checkinData), (err) => {
            if (err) console.error("Error saving checkins:", err);
        });
    }, 2000); 
};

const getDirectorySize = async (dirPath) => {
    let totalSize = 0;
    try {
        if (fs.existsSync(dirPath)) {
            const files = await fs.promises.readdir(dirPath);
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stats = await fs.promises.stat(filePath);
                if (stats.isFile()) totalSize += stats.size;
            }
        }
    } catch (err) {
        console.error("Error calculating cache size:", err);
    }
    return totalSize;
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

    if (!res.headersSent) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store'); 
        const stream = canvas.createJPEGStream();
        stream.pipe(res);
    }
};

const getAuthHeaders = () => {
    if (!BOORU_USERNAME || !BOORU_API_TOKEN) {
        return { 
            'Accept': 'application/json', 
            'User-Agent': OUTBOUND_USER_AGENT 
        };
    }
    
    const encodedCredentials = Buffer.from(`${BOORU_USERNAME}:${BOORU_API_TOKEN}`).toString('base64');
    
    return { 
        'Accept': 'application/json',
        'User-Agent': OUTBOUND_USER_AGENT,
        'Authorization': `Token ${encodedCredentials}` 
    };
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
    if (!userAgent.startsWith('VRChat') && !userAgent.startsWith("UnityWebRequest") && !userAgent.startsWith("UnityPlayer")) {
        logToFile(`DENIED | Invalid User-Agent: ${userAgent} | IP: ${req.ip}`);
        return res.status(403).send('DENIED');
    }
    next();
};

// Rejects malformed/malicious 'id' values before they ever reach the rate
// limiters or fs/path.join calls (those trust postId is a bare filename).
const validatePostId = (errorResponder) => (req, res, next) => {
    const postId = req.query.id;
    if (postId !== undefined && !VALID_ID_REGEX.test(postId)) {
        logToFile(`DENIED | Invalid 'id' parameter: ${postId} | IP: ${req.ip}`);
        res.status(200);
        return errorResponder(res, "Invalid 'id' parameter");
    }
    next();
};

const imageRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 3,
    // Fix 2: Asynchronous skip handler to prevent event loop blocking
    skip: async (req, res) => {
        const postId = req.query.id;
        if (!postId) return false; 
        try {
            await fs.promises.access(path.join(CACHE_DIR, postId));
            return true;
        } catch {
            return false;
        }
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
    // Fix 2: Asynchronous skip handler to prevent event loop blocking
    skip: async (req, res) => {
        const postId = req.query.id;
        if (!postId) return false; 
        
        const localFilePath = path.join(INFO_CACHE_DIR, `${postId}.json`);
        try {
            const stats = await fs.promises.stat(localFilePath);
            return (Date.now() - stats.mtimeMs < INFO_CACHE_TTL_MS);
        } catch {
            return false;
        }
    },
    handler: (req, res) => {
        logToFile(`RATE LIMIT EXCEEDED (/info) | IP: ${req.ip}`);
        res.status(200).json({ error: "Rate Limit Exceeded: Too many requests. Please wait 5 seconds." });
    }
});

const statsRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 3,
    handler: (req, res) => {
        logToFile(`RATE LIMIT EXCEEDED (/stats) | IP: ${req.ip}`);
        res.status(200).json({ error: "Rate Limit Exceeded: Too many requests. Please wait 5 seconds." });
    }
});

const checkinRateLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 3,
    handler: (req, res) => {
        logToFile(`RATE LIMIT EXCEEDED (/checkin) | IP: ${req.ip}`);
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
app.get('/image', enforceVRChatAgent, validatePostId((res, msg) => sendErrorImage(res, msg)), imageRateLimiter, async (req, res) => {
    const postId = req.query.id;

    if (!postId) {
        logToFile(`ERROR | Missing 'id' parameter | IP: ${req.ip}`);
        return sendErrorImage(res, "Missing 'id' parameter in URL");
    }

    const localFilePath = path.join(CACHE_DIR, postId);

    try {
        if (fs.existsSync(localFilePath)) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return fs.createReadStream(localFilePath).pipe(res);
        }

        if (activeDownloads.has(postId)) {
            const success = await activeDownloads.get(postId);
            if (!success) throw new Error("Previous download attempt failed.");
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return fs.createReadStream(localFilePath).pipe(res);
        }

        // Fix 4: Ensure downloadProcess always resolves to a boolean
        const downloadProcess = (async () => {
            try {
                let absoluteImageUrl;

                if (apiCache.has(postId)) {
                    absoluteImageUrl = apiCache.get(postId);
                } else {
                    const apiUrl = `${BOORU_DOMAIN}/api/post/${postId}`;
                    const apiResponse = await axios.get(apiUrl, {
                        headers: getAuthHeaders()
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
                    headers: getAuthHeaders()
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

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    transformer.on('error', reject);
                });
                return true;
            } catch (err) {
                // Remove the failed partial file if it exists
                if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                logToFile(`ERROR | /image ID: ${postId} | Msg: ${err.message}`);
                return false;
            }
        })();

        activeDownloads.set(postId, downloadProcess);
        const success = await downloadProcess;
        activeDownloads.delete(postId);

        if (!success) throw new Error("Failed to process and cache image.");

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(localFilePath).pipe(res);

    } catch (error) {
        activeDownloads.delete(postId);
        res.status(200);
        sendErrorImage(res, error.message);
    }
});

// --- INFO ENDPOINT ---
app.get('/info', enforceVRChatAgent, validatePostId((res, msg) => res.json({ error: msg })), infoRateLimiter, async (req, res) => {
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
                headers: getAuthHeaders()
            }).catch(err => {
                throw new Error(`API Error (HTTP ${err.response?.status || err.message})`);
            });

            const data = apiResponse.data;
            
            // Fix 5: JSON safety check
            if (!data || typeof data !== 'object') throw new Error("Invalid response payload from Booru API");

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

// --- STATS ENDPOINT ---
app.get('/stats', enforceVRChatAgent, statsRateLimiter, async (req, res) => {
    const localFilePath = path.join(STATS_CACHE_DIR, `booru_stats.json`);

    try {
        if (fs.existsSync(localFilePath)) {
            const stats = await fs.promises.stat(localFilePath);
            if (Date.now() - stats.mtimeMs < STATS_CACHE_TTL_MS) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return fs.createReadStream(localFilePath).pipe(res);
            } else {
                await fs.promises.unlink(localFilePath).catch(() => {});
            }
        }

        const fetchStatsProcess = (async () => {
            const apiUrl = `${BOORU_DOMAIN}/api/info`;
            const apiResponse = await axios.get(apiUrl, {
                headers: getAuthHeaders()
            }).catch(err => {
                throw new Error(`API Error (HTTP ${err.response?.status || err.message})`);
            });

            const data = apiResponse.data;
            const metadata = {
                postCount: data.postCount || "Unknown",
                diskUsage: data.diskUsage ?  (Math.round((data.diskUsage / 1073741824) * 100) / 100) : "Unknown"
            };

            await fs.promises.writeFile(localFilePath, JSON.stringify(metadata, null, 2));
        })();

        await fetchStatsProcess;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(localFilePath).pipe(res);

    } catch (error) {
        logToFile(`ERROR | /stats | Msg: ${error.message}`);
        res.status(200).json({ error: error.message });
    }
});

// --- CHECKIN ENDPOINT ---
app.get('/checkin', enforceVRChatAgent, checkinRateLimiter, (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    if (!checkinData[ip]) {
        checkinData[ip] = 0;
    }
    
    checkinData[ip] += 5;
    saveCheckins();

    res.status(200).json({ success: true, timeLoggedMinutes: checkinData[ip] });
});

// --- SYSTEM ENDPOINT ---
app.get('/system', enforceVRChatAgent, async (req, res) => {
    const uniqueUsers = Object.keys(checkinData).length;
    const totalTimeMinutes = Object.values(checkinData).reduce((sum, time) => sum + time, 0);
    
    const cacheSizeBytes = await getDirectorySize(CACHE_DIR);
    const cacheSizeMB = (cacheSizeBytes / (1024 * 1024)).toFixed(2);

    res.status(200).json({
        uniqueUsers: uniqueUsers,
        totalTimeMinutes: totalTimeMinutes,
        imageServerCacheSizeMB: parseFloat(cacheSizeMB)
    });
});

// ==========================================
// Scheduled Tasks & Server Start
// ==========================================

// Fix 3: Run cache cleanup every 10 minutes independently of the endpoints
setInterval(enforceCacheLimit, 10 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Debug Mode is: ${DEBUG_MODE ? 'ON' : 'OFF'}`);
    console.log(`Target Booru: ${BOORU_DOMAIN}`);
});