const urlParams = new URLSearchParams(window.location.search);
const targetUrl = urlParams.get('url');
const targetReferer = urlParams.get('referer'); // <--- NEW PARAMETER

const statusEl = document.getElementById('status');
const barEl = document.getElementById('bar');
const filenameEl = document.getElementById('filename');
const downloadBtn = document.getElementById('downloadBtn');

let blobs = [];

async function start() {
    if (!targetUrl) {
        statusEl.textContent = "❌ Error: No URL provided.";
        return;
    }

    // ⚡ STEP 0: ENABLE SPOOFING
    statusEl.textContent = "🛡️ Bypassing security...";
    
    // Tell background to fake the headers
    await new Promise(resolve => {
        chrome.runtime.sendMessage({
            action: "ENABLE_SPOOFING",
            videoUrl: targetUrl,
            referer: targetReferer || "https://google.com"
        }, resolve);
    });

    // Short pause to ensure rules are active
    await new Promise(r => setTimeout(r, 500));

    try {
        statusEl.textContent = "🔍 Analyzing Stream...";
        
        // 1. Fetch the Manifest (Now with faked headers!)
        const response = await fetch(targetUrl);
        
        if (response.status === 403 || response.status === 401) {
             throw new Error("403 Forbidden - Spoofing failed. Try reloading page.");
        }

        const text = await response.text();

        // ... (The rest of your code remains EXACTLY the same from here down) ...
        // ... (Copy the rest of the file from the previous step) ...

        // 2. CHECK: Is this a Master Playlist? (Contains Quality Options)
        if (text.includes('#EXT-X-STREAM-INF')) {
            statusEl.textContent = "⚡ Master Playlist detected. finding best quality...";
            
            // Extract the URL of the highest bandwidth stream
            const lines = text.split('\n');
            let bestUrl = "";
            let maxBandwidth = 0;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('BANDWIDTH=')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    if (bwMatch) {
                        const bw = parseInt(bwMatch[1]);
                        if (bw > maxBandwidth) {
                            maxBandwidth = bw;
                            // The URL is usually the next line
                            bestUrl = lines[i+1].trim();
                        }
                    }
                }
            }

            if (bestUrl) {
                // Handle relative URLs
                if (!bestUrl.startsWith('http')) {
                    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                    bestUrl = baseUrl + bestUrl;
                }
                
                console.log("Redirecting to best quality:", bestUrl);
                // RESTART with the new URL
                processSegments(bestUrl);
                return;
            }
        }

        // If not a master playlist, just process it directly
        processSegments(targetUrl, text);

    } catch (err) {
        statusEl.textContent = "❌ Error fetching manifest: " + err.message;
    }
}

async function processSegments(url, preLoadedText = null) {
    try {
        let text = preLoadedText;
        if (!text) {
            const res = await fetch(url);
            text = await res.text();
        }

        if (text.includes('#EXT-X-KEY')) {
             statusEl.textContent = "🔒 Error: Encrypted Stream.";
             return;
        }

        const lines = text.split('\n');
        let segments = [];

        // ⚡ FIX 1: Use the URL API for smart parsing
        // This handles relative paths (../), root paths (/), and protocol relative (//) automatically.
        const baseObj = new URL(url);

        lines.forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;

            // ⚡ FIX 2: Filter out "Trap" segments
            // Real HLS segments are usually .ts, .m4s, or have no extension.
            // Lookmovie adds .html, .css, .js, .png to break downloaders.
            if (/\.(html|css|js|png|jpg|ico|webp|json)$/i.test(line)) {
                console.log("Skipping junk segment:", line);
                return;
            }

            try {
                // ⚡ FIX 3: Robust URL Construction
                // new URL(line, baseUrl) handles the math correctly.
                const absoluteUrl = new URL(line, baseObj.href).href;
                segments.push(absoluteUrl);
            } catch (e) {
                console.warn("Invalid URL in manifest:", line);
            }
        });

        if (segments.length === 0) {
            statusEl.textContent = "❌ No valid video segments found.";
            return;
        }

        // ⚡ FIX 4: Update Spoofing for the Segment Domain
        // Often segments live on a different domain than the manifest.
        // We need to ensure the spoofer works for them too.
        if (segments.length > 0) {
            const firstSegmentHost = new URL(segments[0]).hostname;
            const manifestHost = new URL(url).hostname;

            // If the video chunks are on a different server, tell background.js to spoof that too
            if (firstSegmentHost !== manifestHost) {
                console.log("Segments are on a different CDN. Updating spoofer...");
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: "ENABLE_SPOOFING",
                        videoUrl: segments[0], // Pass a segment URL so the rule updates
                        referer: targetReferer || "https://google.com"
                    }, resolve);
                });
                // Wait for rule to apply
                await new Promise(r => setTimeout(r, 500));
            }
        }

        filenameEl.textContent = `Found ${segments.length} valid chunks. Downloading...`;
        await downloadLoop(segments);

    } catch (e) {
        statusEl.textContent = "❌ Error processing segments: " + e.message;
    }
}

async function downloadLoop(segments) {
    let completed = 0;
    
    for (let i = 0; i < segments.length; i++) {
        try {
            statusEl.textContent = `Downloading chunk ${i + 1} of ${segments.length}`;
            
            const response = await fetch(segments[i]);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const blob = await response.blob();
            blobs.push(blob);

            completed++;
            const pct = (completed / segments.length) * 100;
            barEl.style.width = pct + "%";

        } catch (e) {
            console.warn(`Chunk ${i} failed:`, e);
            // We skip failed chunks to keep the video going, might glitch slightly
        }
    }

    if (blobs.length > 0) {
        statusEl.textContent = "✨ Stitching video...";
        saveToDisk();
    } else {
        statusEl.textContent = "❌ All downloads failed. Check Console.";
    }
}

function saveToDisk() {
    // Merge blobs
    const finalBlob = new Blob(blobs, { type: 'video/mp4' });
    const url = URL.createObjectURL(finalBlob);
    const sizeMB = (finalBlob.size / (1024 * 1024)).toFixed(2);

    statusEl.textContent = `✅ Complete! Size: ${sizeMB} MB`;
    barEl.style.backgroundColor = "#00cec9";
    
    downloadBtn.textContent = `💾 Save MP4 (${sizeMB} MB)`;
    downloadBtn.style.display = "inline-block";
    
    downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `faststream_video_${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    // Auto-trigger
    downloadBtn.click();
}

// Start the engine
start();