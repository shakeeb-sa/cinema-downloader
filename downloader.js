const urlParams = new URLSearchParams(window.location.search);
const targetUrl = urlParams.get("url");
const targetReferer = urlParams.get("referer");

const statusEl = document.getElementById("status");
const filenameEl = document.getElementById("filename");
const downloadBtn = document.getElementById("downloadBtn");
const multiBarContainer = document.getElementById("multi-bar-container");
const targetName = urlParams.get("name") || `faststream_${Date.now()}`;

// ⚡ Ensure the filename is fully visible and clean
const cleanDisplayName = decodeURIComponent(targetName).replace(/_/g, " ");
if (filenameEl) {
  filenameEl.textContent = cleanDisplayName;
  // Update the browser tab title as well
  document.title = `Downloading: ${cleanDisplayName}`;
}
// ⚡ Update the UI to show the movie name
filenameEl.textContent = targetName.replace(/_/g, " ");

// UI Controls
const controlsDiv = document.createElement("div");
controlsDiv.innerHTML = `
    <button id="pauseBtn" style="display:none; background:#f1c40f; margin-top:10px; margin-right:5px;">⏸ Pause</button>
    <button id="resumeBtn" style="display:none; background:#2ecc71; margin-top:10px; margin-right:5px;">▶ Resume</button>
    <button id="reviveBtn" style="display:none; background:#e17055; margin-top:10px;">⚡ Revive</button>
`;
document.querySelector(".container").appendChild(controlsDiv);

const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const reviveBtn = document.getElementById("reviveBtn");

let blobs = [];
let isPaused = false;
let activeDownloads = 0;
let totalDownloadedBytes = 0;
let activeControllers = new Set();
let isManualRevive = false;
let startTime = null;
let currentQualityLabel = "Unknown";
let timerInterval = null;
let lastByteCount = 0;
let heartbeatInterval = null;
// ⚡ CHUNK MAP DRAWING ENGINE
const chunkCanvas = document.getElementById("chunk-canvas");
const ctx = chunkCanvas ? chunkCanvas.getContext("2d") : null;

function updateChunkMap(totalSegments) {
  if (!ctx) return;

  const header = document.getElementById("chunk-map-header");
  if (header) header.style.display = "block";
  chunkCanvas.style.display = "block";

  // ⚡ IMPROVED: Better balance between size and density
  const cols = 65;
  const rows = Math.ceil(totalSegments / cols);
  const boxSize = 6; // Larger dots for better visibility
  const gap = 1;

  // Set canvas resolution to match our calculation
  chunkCanvas.width = cols * (boxSize + gap) + gap;
  chunkCanvas.height = rows * (boxSize + gap) + gap;

  ctx.clearRect(0, 0, chunkCanvas.width, chunkCanvas.height);

  for (let i = 0; i < totalSegments; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (boxSize + gap) + gap;
    const y = row * (boxSize + gap) + gap;

    if (blobs[i] === undefined) {
      ctx.fillStyle = "#1e293b";
    } else if (blobs[i] === null) {
      ctx.fillStyle = "#ef4444";
    } else {
      ctx.fillStyle = "#10b981";
    }

    ctx.fillRect(x, y, boxSize, boxSize);
  }
}

function createBar(id) {
  const wrapper = document.createElement("div");
  wrapper.className = "thread-row"; // ⚡ New CSS Class
  wrapper.innerHTML = `
        <div class="thread-label">Thread ${id + 1}</div>
        <div class="bar-bg">
            <div id="bar-${id}" class="bar-fill"></div>
        </div>
    `;
  return wrapper;
}

function formatSize(bytes) {
  if (bytes === 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(2) + " MB";
}

window.onbeforeunload = function (e) {
  if (
    activeDownloads > 0 ||
    (blobs.length > 0 && downloadBtn.style.display === "none")
  ) {
    e.preventDefault();
    e.returnValue = "Downloading...";
    return "Downloading...";
  }
};

async function start() {
  if (!targetUrl) return fail("No URL.");

  statusEl.textContent = "🛡️ Authenticating...";
  await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: "ENABLE_SPOOFING",
        videoUrl: targetUrl,
        referer: targetReferer || "https://google.com",
      },
      resolve
    );
  });
  await new Promise((r) => setTimeout(r, 500));

  try {
    statusEl.textContent = "🔍 Fetching Manifest...";
    const response = await fetch(targetUrl);
    if (!response.ok) throw new Error("Manifest fetch failed");
    const text = await response.text();

    // ⚡ CHECK: Is this a Master Playlist?
    if (text.includes("#EXT-X-STREAM-INF")) {
      statusEl.textContent = "⚡ Master List detected. Parsing qualities...";
      const lines = text.split("\n");
      const qualities = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.includes("#EXT-X-STREAM-INF")) {
          // 1. Get Resolution Label (e.g., 1080p)
          let label = "Quality";
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
          if (resMatch) {
            label = resMatch[1].split("x")[1] + "p";
          } else {
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            if (bwMatch)
              label = Math.round(parseInt(bwMatch[1]) / 1000000) + " Mbps";
          }

          // 2. Get the URL from the next valid line
          let urlLine = "";
          for (let j = i + 1; j < i + 4; j++) {
            if (lines[j] && !lines[j].startsWith("#")) {
              urlLine = lines[j].trim();
              break;
            }
          }

          if (urlLine) {
            // Handle relative URLs correctly
            const absoluteUrl = new URL(urlLine, targetUrl).href;
            qualities.push({ label: label, url: absoluteUrl });
          }
        }
      }

      // Deduplicate qualities
      const uniqueQualities = qualities.filter(
        (v, i, a) => a.findIndex((t) => t.label === v.label) === i
      );

      if (uniqueQualities.length > 1) {
        showQualityMenu(uniqueQualities); // Show buttons
        return; // Stop here and wait for click
      }
    }

    // ⚡ SMART QUALITY DETECTOR (Lookmovie Edition)
    const urlLower = targetUrl.toLowerCase();

    // Check for standard numbers OR Base64 encoded resolutions
    if (urlLower.includes("1080") || urlLower.includes("mta4ma")) {
      currentQualityLabel = "1080p";
    } else if (urlLower.includes("720") || urlLower.includes("nziw")) {
      currentQualityLabel = "720p";
    } else if (urlLower.includes("480") || urlLower.includes("ndgw")) {
      currentQualityLabel = "480p";
    } else if (urlLower.includes("360") || urlLower.includes("mzyw")) {
      currentQualityLabel = "360p";
    } else {
      currentQualityLabel = "HD Source"; // Better than "Original"
    }

    console.log("Detected Quality:", currentQualityLabel);
    processSegments(targetUrl, text);
  } catch (err) {
    fail(err.message);
  }
}

function showQualityMenu(qualities) {
  statusEl.textContent = "Please select your desired quality:";
  const container = document.getElementById("quality-container");
  const btns = document.getElementById("quality-buttons");

  if (!container || !btns) {
    console.error("Missing quality-container or quality-buttons in HTML");
    return;
  }

  // Sort High to Low (1080p first)
  qualities.sort((a, b) => parseInt(b.label) - parseInt(a.label));

  btns.innerHTML = "";
  qualities.forEach((q) => {
    const btn = document.createElement("button");
    btn.textContent = q.label;
    btn.style.cssText = `
            background: #0984e3;
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
            margin: 5px;
            box-shadow: 0 4px 0 #076bbd;
        `;

    btn.onclick = () => {
      // ⚡ ADD THIS LINE
      currentQualityLabel = q.label;

      container.style.display = "none";
      statusEl.textContent = `🚀 Quality Set: ${q.label}. Initializing Threads...`;
      processSegments(q.url);
    };
    btns.appendChild(btn);
  });

  container.style.display = "block";
}

async function processSegments(url, preLoadedText = null) {
  try {
    let text = preLoadedText;
    if (!text) {
      const res = await fetch(url);
      text = await res.text();
    }

    if (text.includes("#EXT-X-KEY")) return fail("⚠️ DRM Encrypted.");

    const lines = text.split("\n");
    const baseObj = new URL(url);
    let segments = [];

    lines.forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      if (/\.(html|css|js|png|jpg|ico)$/i.test(line)) return;
      try {
        segments.push(new URL(line, baseObj.href).href);
      } catch (e) {}
    });

    if (segments.length === 0) return fail("No segments.");

    if (new URL(segments[0]).hostname !== baseObj.hostname) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: "ENABLE_SPOOFING",
            videoUrl: segments[0],
            referer: targetReferer,
          },
          resolve
        );
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    filenameEl.textContent = `Found ${segments.length} chunks.`;
    pauseBtn.style.display = "inline-block";
    reviveBtn.style.display = "inline-block";

    await downloadLoop(segments);
  } catch (e) {
    fail(e.message);
  }
}

async function downloadLoop(segments) {
  updateChunkMap(segments.length);
  const PARTITIONS = 6;
  lastByteCount = 0; // Reset
  startHeartbeatMonitor(); // Start watching

  // ⚡ SETUP UI: Create 4 Bars
  multiBarContainer.innerHTML = ""; // Clear
  for (let i = 0; i < PARTITIONS; i++) {
    multiBarContainer.appendChild(createBar(i));
  }

  const chunksPerPartition = Math.ceil(segments.length / PARTITIONS);
  let globalCompleted = 0;

  const runPartition = async (partitionId) => {
    const startIndex = partitionId * chunksPerPartition;
    const endIndex = Math.min(startIndex + chunksPerPartition, segments.length);
    const totalForThisWorker = endIndex - startIndex;
    let localCompleted = 0;

    // Grab the specific bar element for this worker
    const localBar = document.getElementById(`bar-${partitionId}`);

    for (let i = startIndex; i < endIndex; i++) {
      const url = segments[i];
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        try {
          while (isPaused) {
            statusEl.textContent = `⏸ Paused`;
            await new Promise((r) => setTimeout(r, 1000));
          }

          const controller = new AbortController();
          activeControllers.add(controller);
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();

            // Save data
            blobs[i] = blob;
            totalDownloadedBytes += blob.size;
            localCompleted++;
            globalCompleted++;

            // ⚡ 1. HANDLE TIMER ON START
            if (!startTime) {
              startTime = Date.now();
              startTimerUI();
            }

            // ⚡ 2. CALCULATE ETA
            const currentTime = Date.now();
            const elapsedSeconds = (currentTime - startTime) / 1000;
            const chunksPerSecond = globalCompleted / elapsedSeconds;
            const remainingChunks = segments.length - globalCompleted;
            const etaSeconds = remainingChunks / chunksPerSecond;

            // ⚡ 3. UPDATE MODERN UI (DASHBOARD GRID)
            const liveSizeEl = document.getElementById("live-size");
            const liveQualityEl = document.getElementById("live-quality");
            const etaTimeEl = document.getElementById("eta-time");

            if (liveSizeEl)
              liveSizeEl.textContent = formatSize(totalDownloadedBytes);
            if (liveQualityEl) liveQualityEl.textContent = currentQualityLabel;
            if (etaTimeEl) etaTimeEl.textContent = formatTime(etaSeconds);

            statusEl.textContent = `Progress: ${globalCompleted} / ${segments.length} chunks`;

            // ⚡ 4. UPDATE INDIVIDUAL BAR
            if (localBar) {
              const localPct = (localCompleted / totalForThisWorker) * 100;
              localBar.style.width = localPct + "%";
            }

            // ⚡ 5. UPDATE MAP
            updateChunkMap(segments.length);

            activeControllers.delete(controller);
            break; // Success!
          } catch (fetchErr) {
            clearTimeout(timeoutId);
            activeControllers.delete(controller);
            throw fetchErr;
          }
        } catch (e) {
          if (isManualRevive && e.name === "AbortError") attempts--;
          else attempts++;

          if (attempts >= maxAttempts) {
            blobs[i] = null;
            break;
          } else {
            await new Promise((r) => setTimeout(r, 500 * attempts));
          }
        }
      }
    }
  };

  const workers = [];
  for (let p = 0; p < PARTITIONS; p++) {
    workers.push(runPartition(p));
  }

  activeDownloads = segments.length;
  await Promise.all(workers);
  activeDownloads = 0;
  finalize();
}

function finalize() {
  updateChunkMap(blobs.length); // Final render
  if (heartbeatInterval) clearInterval(heartbeatInterval); // Stop watching
  // 1. Stop the clock immediately
  if (timerInterval) clearInterval(timerInterval);
  const totalDuration = formatTime((Date.now() - startTime) / 1000);

  // 2. Filter nulls (failed chunks)
  const validBlobs = blobs.filter((b) => b);
  if (validBlobs.length === 0) return fail("Download failed.");

  // 3. Turn all bars blue to show success
  const PARTITIONS = 6; // Match your Nitro thread count
  for (let i = 0; i < PARTITIONS; i++) {
    const b = document.getElementById(`bar-${i}`);
    if (b) b.style.backgroundColor = "#00cec9";
  }

  statusEl.textContent = "✨ Stitching video...";
  pauseBtn.style.display = "none";
  resumeBtn.style.display = "none";
  reviveBtn.style.display = "none";

  // 4. Create the final file and calculate size (DO THIS BEFORE SETTING TEXT)
  const finalBlob = new Blob(validBlobs, { type: "video/mp2t" });
  const url = URL.createObjectURL(finalBlob);
  const sizeStr = formatSize(finalBlob.size); // ⚡ NOW sizeStr IS DEFINED

  // 5. Update UI with the final result
  statusEl.textContent = `✅ DONE! ${sizeStr} in ${totalDuration}`;
  document.getElementById("eta-time").textContent = "FINISHED";

  downloadBtn.textContent = `💾 Save Video (.ts) (${sizeStr})`;
  downloadBtn.style.display = "inline-block";

  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${targetName}.ts`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.onbeforeunload = null;
  };

  // Auto-trigger save
  downloadBtn.click();
}

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = "#ff7675";
}

pauseBtn.onclick = () => {
  isPaused = true;
  pauseBtn.style.display = "none";
  resumeBtn.style.display = "inline-block";
};
resumeBtn.onclick = () => {
  isPaused = false;
  pauseBtn.style.display = "inline-block";
  resumeBtn.style.display = "none";
};

// Function that does the actual work
function triggerReviveLogic() {
  statusEl.innerHTML += `<div style="color:#e17055;">⚡ Reviving...</div>`;
  isManualRevive = true;
  activeControllers.forEach((c) => c.abort());
  activeControllers.clear();
  setTimeout(() => {
    isManualRevive = false;
  }, 500);
}

// The button just calls the function
reviveBtn.onclick = triggerReviveLogic;

start();

// ⚡ FORMAT SECONDS TO MM:SS
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ⚡ LIVE ELAPSED TIMER
function startTimerUI() {
  timerInterval = setInterval(() => {
    if (isPaused || !startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    document.getElementById("elapsed-time").textContent = formatTime(elapsed);
  }, 1000);
}

// ⚡ CAPTURE QUALITY LABEL
// Add this inside your quality button click handler in showQualityMenu()
// Inside: btn.onclick = () => { ...
// ADD THIS LINE: currentQualityLabel = q.label;

// ⚡ HEARTBEAT MONITOR: Detects stalls and auto-revives
function startHeartbeatMonitor() {
  // Clear any existing monitor first
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  heartbeatInterval = setInterval(() => {
    // Don't revive if we are paused, finished, or haven't started
    if (isPaused || activeDownloads === 0) return;

    if (totalDownloadedBytes === lastByteCount && totalDownloadedBytes > 0) {
      console.log("Stall detected! Triggering Auto-Revive...");

      // Visual feedback for the user
      const notice = document.createElement("div");
      notice.style.cssText =
        "color:#e17055; font-size:10px; font-weight:bold; margin-top:5px;";
      notice.textContent = "⚠️ STALL DETECTED: Auto-Reviving...";
      statusEl.appendChild(notice);
      setTimeout(() => notice.remove(), 3000);

      // Execute the revive logic
      triggerReviveLogic();
    }

    // Update the marker for the next check
    lastByteCount = totalDownloadedBytes;
  }, 15000); // 15 Seconds is the sweet spot for HLS
}
