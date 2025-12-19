document.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("video-list");

  // 1. Get current Tab ID
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTabId = tabs[0].id;

    // 2. Ask Background for videos
    chrome.runtime.sendMessage(
      { action: "GET_VIDEOS", tabId: currentTabId },
      (response) => {
        const videos = response.videos;

        if (!videos || videos.length === 0) {
          list.innerHTML = `<div class="no-videos">No videos detected on this page yet.<br>Try playing the video first.</div>`;
          return;
        }

        // 3. Render List
        videos.forEach((v) => {
          const item = document.createElement("div");
          item.className = "video-item";

          // If it's a file, we can download directly.
          // If it's a stream (m3u8), we just copy link for now (Phase 1).
          const isStream = v.type === "stream";
          const btnText = isStream
            ? "📋 Copy Stream URL (M3U8)"
            : "⬇️ Download MP4";
          const btnClass = isStream ? "btn-stream" : "btn-download";

          item.innerHTML = `
            <div class="video-title">${v.label}</div>
            <div style="font-size:9px; color:#aaa; margin-bottom:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${v.url}</div>
            <button class="btn ${btnClass}" data-url="${v.url}" data-type="${v.type}">${btnText}</button>
          `;

          list.appendChild(item);
        });

        // 4. Handle Clicks
        document.querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            const url = e.target.dataset.url;
            const type = e.target.dataset.type;

                        if (type === "stream") {
              // Phase 3: Open Internal Downloader with Smart Naming
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                  const currentPage = tabs[0].url;
                  const rawTitle = tabs[0].title || "FastStream_Video";
                  
                  // ⚡ CLEAN FILENAME: Remove illegal characters like \ / : * ? " < > |
                  const sanitizedTitle = rawTitle
                    .replace(/[\\/:*?"<>|]/g, "_") // Replace bad chars with underscore
                    .replace(/\s+/g, "_")         // Replace spaces with underscore for better compatibility
                    .substring(0, 100);           // Limit length
                  
                  chrome.tabs.create({
                    url: `downloader.html?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(currentPage)}&name=${encodeURIComponent(sanitizedTitle)}`
                  });
              });
              window.close();
            }
          });
        });
      }
    );
  });
});
