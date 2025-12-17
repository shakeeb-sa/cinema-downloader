const urlParams = new URLSearchParams(window.location.search);
const targetUrl = urlParams.get("url");
const targetReferer = urlParams.get("referer");

const statusEl = document.getElementById("status");
const barEl = document.getElementById("bar");
const filenameEl = document.getElementById("filename");
const downloadBtn = document.getElementById("downloadBtn");

// UI for Controls
const controlsDiv = document.createElement("div");
controlsDiv.innerHTML = `
    <button id="pauseBtn" style="display:none; background:#f1c40f; margin-top:10px; margin-right:5px;">⏸ Pause</button>
    <button id="resumeBtn" style="display:none; background:#2ecc71; margin-top:10px; margin-right:5px;">▶ Resume</button>
    <button id="reviveBtn" style="display:none; background:#e17055; margin-top:10px;">⚡ Revive Stuck</button>
`;
document.querySelector(".container").appendChild(controlsDiv);

const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const reviveBtn = document.getElementById("reviveBtn");

let blobs = [];
let isPaused = false;
let activeDownloads = 0;
let totalDownloadedBytes = 0;
// ⚡ NEW: Track active requests so we can kill them manually
let activeControllers = new Set();
let isManualRevive = false;

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
    e.returnValue = "Download in progress...";
    return "Download in progress...";
  }
};

async function start() {
  if (!targetUrl) return fail("No URL provided.");

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

    if (text.includes("#EXT-X-STREAM-INF")) {
      statusEl.textContent = "⚡ Picking Best Quality...";
      const lines = text.split("\n");
      let bestUrl = "",
        maxBw = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("BANDWIDTH=")) {
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          if (bwMatch) {
            const bw = parseInt(bwMatch[1]);
            if (bw > maxBw) {
              maxBw = bw;
              bestUrl = lines[i + 1].trim();
            }
          }
        }
      }
      if (bestUrl) {
        if (!bestUrl.startsWith("http")) {
          const baseUrl = targetUrl.substring(
            0,
            targetUrl.lastIndexOf("/") + 1
          );
          bestUrl = baseUrl + bestUrl;
        }
        processSegments(bestUrl);
        return;
      }
    }
    processSegments(targetUrl, text);
  } catch (err) {
    fail(err.message);
  }
}

async function processSegments(url, preLoadedText = null) {
  try {
    let text = preLoadedText;
    if (!text) {
      const res = await fetch(url);
      text = await res.text();
    }

    if (text.includes("#EXT-X-KEY"))
      return fail("⚠️ DRM Encrypted Stream. Cannot Download.");

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

    if (segments.length === 0) return fail("No video segments found.");

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
    reviveBtn.style.display = "inline-block"; // Show Revive Button

    await downloadLoop(segments);
  } catch (e) {
    fail(e.message);
  }
}

async function downloadLoop(segments) {
  let completed = 0;
  const CONCURRENCY = 5;
  let estimatedTotalSize = 0;

  const downloadSegment = async (url, index) => {
    let attempts = 0;
    const maxAttempts = 10; // Increased retry limit slightly for manual interventions

    while (attempts < maxAttempts) {
      try {
        while (isPaused) {
          statusEl.textContent = `⏸ Paused (${formatSize(
            totalDownloadedBytes
          )})`;
          await new Promise((r) => setTimeout(r, 1000));
        }

        const controller = new AbortController();
        const signal = controller.signal;

        // ⚡ Register Controller for Manual Revive
        activeControllers.add(controller);

        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s Auto-Timeout

        try {
          const response = await fetch(url, { signal });
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();

          blobs[index] = blob;
          totalDownloadedBytes += blob.size;
          completed++;

          // Smart Estimate
          if (completed === 5) {
            const avgChunkSize = totalDownloadedBytes / 5;
            estimatedTotalSize = avgChunkSize * segments.length;
          }

          const pct = (completed / segments.length) * 100;
          barEl.style.width = pct + "%";

          let sizeText = `Size: <b>${formatSize(totalDownloadedBytes)}</b>`;
          if (estimatedTotalSize > 0)
            sizeText += ` / ~${formatSize(estimatedTotalSize)}`;

          statusEl.innerHTML = `Downloading: <b>${completed}</b> / ${segments.length}<br>${sizeText}`;

          // Success: Remove controller and exit
          activeControllers.delete(controller);
          return;
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          activeControllers.delete(controller);
          throw fetchErr; // Re-throw to handle retry logic
        }
      } catch (e) {
        // If manual revive, do NOT count as a failed attempt (so we don't hit maxAttempts)
        if (isManualRevive && e.name === "AbortError") {
          console.log(`Chunk ${index} manually revived.`);
          attempts--; // Credit back the attempt
        } else {
          attempts++;
        }

        if (attempts >= maxAttempts) {
          blobs[index] = null;
          return; // Give up
        } else {
          // Backoff wait
          await new Promise((r) => setTimeout(r, 1000 * attempts));
        }
      }
    }
  };

  activeDownloads = segments.length;

  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    const promises = batch.map((url, offset) =>
      downloadSegment(url, i + offset)
    );
    await Promise.all(promises);
  }

  activeDownloads = 0;
  finalize();
}

function finalize() {
  const validBlobs = blobs.filter((b) => b);
  if (validBlobs.length === 0) return fail("Download failed.");

  statusEl.textContent = "✨ Stitching video...";
  pauseBtn.style.display = "none";
  resumeBtn.style.display = "none";
  reviveBtn.style.display = "none";

  const finalBlob = new Blob(validBlobs, { type: "video/mp4" });
  const url = URL.createObjectURL(finalBlob);
  const sizeStr = formatSize(finalBlob.size);

  statusEl.textContent = `✅ Complete! Final Size: ${sizeStr}`;
  barEl.style.backgroundColor = "#00cec9";

  downloadBtn.textContent = `💾 Save MP4 (${sizeStr})`;
  downloadBtn.style.display = "inline-block";

  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `faststream_${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.onbeforeunload = null;
  };

  downloadBtn.click();
}

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = "#ff7675";
}

// PAUSE / RESUME
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

// ⚡ REVIVE LOGIC
reviveBtn.onclick = () => {
  statusEl.textContent = "⚡ Reviving stuck chunks...";
  isManualRevive = true; // Set flag

  // Abort all currently running requests
  activeControllers.forEach((controller) => controller.abort());
  activeControllers.clear();

  // Reset flag after short delay so new requests aren't marked as manual
  setTimeout(() => {
    isManualRevive = false;
  }, 500);
};

start();
