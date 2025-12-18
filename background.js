// STORAGE: Holds detected videos by Tab ID
let videoCache = {};

// 1. THE FILTER
// We listen for ANY video, plus specific stream formats
const TARGET_EXTENSIONS = [
  ".mp4",
  ".m3u8",
  ".mov",
  ".flv",
  ".webm",
  ".ts",
  ".mpd",
];

// 2. THE LISTENER
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // A. Ignore requests from our own extension
    if (details.initiator && details.initiator.startsWith("chrome-extension"))
      return;

    // B. Analyze Headers
    const typeHeader = details.responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const lenHeader = details.responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-length"
    );

    const mimeType = typeHeader ? typeHeader.value.toLowerCase() : "";
    const size = lenHeader ? parseInt(lenHeader.value) : 0;
    const url = details.url.toLowerCase();

    // C. DETECTION LOGIC
    let isVideo = false;
    let videoType = "unknown";

    // Rule 1: Is it an HLS Manifest? (Priority)
    // Manifests are TEXT files, so they are small. We MUST accept small files here.
    if (
      url.includes(".m3u8") ||
      mimeType.includes("application/x-mpegurl") ||
      mimeType.includes("application/vnd.apple.mpegurl")
    ) {
      isVideo = true;
      videoType = "stream";
    }
    // Rule 2: Is it a generic Video File?
    else if (mimeType.startsWith("video/")) {
      isVideo = true;
      videoType = "file";
    }
    // Rule 3: URL Pattern Fallback (If headers are masked)
    else if (TARGET_EXTENSIONS.some((ext) => url.includes(ext))) {
      // Exclude .ts segments to avoid flooding the list (we want the master .m3u8, not the chunks)
      if (url.includes(".ts")) return;

      isVideo = true;
      videoType = url.includes(".m3u8") ? "stream" : "file";
    }

    // D. FILTERING (Refined)
    if (!isVideo) return;

    // If it is a generic video file (mp4), filter out tiny files (ads/icons)
    // BUT if it is a STREAM (m3u8), allow ANY size.
    if (videoType === "file" && size > 0 && size < 10000) return;

    // E. SAVE IT
    addVideoToCache(details.tabId, details.url, videoType, size);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// 3. CACHE MANAGER
function addVideoToCache(tabId, url, type, size) {
  if (!videoCache[tabId]) videoCache[tabId] = [];

  // Deduplicate
  const exists = videoCache[tabId].some((v) => v.url === url);
  if (exists) return;

  let label = "Unknown";
  if (type === "stream") label = "🌊 HLS Stream (Master)";
  else label = `🎥 Video File ${size > 0 ? "(" + formatBytes(size) + ")" : ""}`;

  // Add to beginning of list (Newest first)
  videoCache[tabId].unshift({
    url: url,
    type: type,
    label: label,
    timestamp: Date.now(),
  });

  // Badge Update
  chrome.action.setBadgeText({
    text: videoCache[tabId].length.toString(),
    tabId: tabId,
  });
  chrome.action.setBadgeBackgroundColor({ color: "#e74c3c", tabId: tabId });
}

// 4. CLEANUP
chrome.tabs.onRemoved.addListener((tabId) => {
  delete videoCache[tabId];
});

// 5. COMMUNICATION
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GET_VIDEOS") {
    const list = videoCache[request.tabId] || [];
    sendResponse({ videos: list });
  }
});

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// ... (Your existing Sniffer code stays above this) ...

// 6. HEADER SPOOFING ENGINE (The Fix for 403 Errors)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ENABLE_SPOOFING") {
    const videoDomain = new URL(request.videoUrl).hostname;
    const refererDomain = request.referer; // The site we are pretending to be

    console.log(
      `⚡ Spoofing Headers: Accessing ${videoDomain} as if we are ${refererDomain}`
    );

    // Define the rule to modify headers
    const ruleId = 100 + Math.floor(Math.random() * 1000); // Random ID

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: refererDomain },
          { header: "Origin", operation: "remove" }, // Remove extension origin
        ],
      },
      condition: {
        // Apply this rule ONLY to the video server
        urlFilter: `||${videoDomain}`,
        resourceTypes: ["xmlhttprequest"],
      },
    };

    // Apply the rule dynamically
    chrome.declarativeNetRequest.updateDynamicRules(
      {
        removeRuleIds: [ruleId], // clean up old rules if any collision
        addRules: [rule],
      },
      () => {
        sendResponse({ success: true, ruleId: ruleId });
      }
    );

    return true; // Keep message channel open
  }
});

// ... (All your existing Sniffer/Spoofer code is above here) ...

// ==========================================
// 7. THE FORCE SCANNER (Context Menu)
// ==========================================

// Create the menu item on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "force-scan",
    title: "⚡ FastStream: Force Video Scan",
    contexts: ["all"], // Works anywhere on the page
  });
});

// Handle the click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "force-scan") {
    // Inject the scanner script
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        func: scanPageForVideos,
      },
      (results) => {
        // The script returns an array of URLs found
        if (results && results[0] && results[0].result) {
          const foundUrls = results[0].result;
          let count = 0;

          foundUrls.forEach((url) => {
            // Determine type
            let type =
              url.includes(".m3u8") || url.includes(".mpd") ? "stream" : "file";
            // Add to our main list
            addVideoToCache(tab.id, url, type, 0);
            count++;
          });

          console.log(`Force Scan found ${count} videos.`);
        }
      }
    );
  }
});

// ⚡ THIS FUNCTION RUNS INSIDE THE WEBPAGE
function scanPageForVideos() {
  let found = new Set();

  // Strategy 1: Check the Performance API (The Browser's Network Log)
  // This sees everything the browser has fetched, even if hidden.
  const resources = performance.getEntriesByType("resource");
  resources.forEach((res) => {
    const url = res.name;
    if (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      (url.includes(".mp4") && !url.includes(".js"))
    ) {
      found.add(url);
    }
  });

  // Strategy 2: Check standard Video Tags
  document.querySelectorAll("video").forEach((v) => {
    if (v.src && v.src.startsWith("http")) found.add(v.src);
    // Check for source child tags
    v.querySelectorAll("source").forEach((s) => {
      if (s.src && s.src.startsWith("http")) found.add(s.src);
    });
  });

  // Strategy 3: Scan Page Text for Hidden M3U8 links (Regex Scan)
  // Sometimes URLs are stored in JS variables.
  const html = document.body.innerHTML;
  const regex = /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    found.add(match[1]);
  }

  return Array.from(found);
}
