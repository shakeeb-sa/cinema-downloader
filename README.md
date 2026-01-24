
# Cinema Downloader 🎬⚡

**Cinema Downloader** is a powerful Chrome Extension designed for high-speed video stream detection and local downloading. It bridges the gap between web-based streaming and offline viewing by identifying direct stream URLs and providing a dedicated downloader interface that bypasses typical browser download restrictions.

## 🚀 Key Features

-   **Real-time Stream Detection**: Automatically monitors network traffic to identify `.m3u8`, `.mp4`, and other high-quality video stream fragments as you watch.
    
-   **Internal Downloader UI**: Features a custom `downloader.html` page that provides a focused environment for managing active downloads without distracting browser tabs.
    
-   **Smart Filename Sanitization**: Automatically extracts the webpage title and strips illegal characters (`\ / : * ? " < > |`) to ensure compatible and organized file saving.
    
-   **Referer Spoofing**: Built-in logic to pass the correct origin headers, ensuring that streams with hotlink protection can still be downloaded successfully.
    
-   **Interactive Popup**: A clean, compact menu that lists all detected streams on the current page with options to copy the URL or start an immediate download.
    
-   **Lightweight & Fast**: Built with vanilla JavaScript to ensure zero impact on browser performance while idle.
    

## 🛠️ Technical Stack

-   **Extension Framework**: Manifest V3 for modern security and performance standards.
    
-   **Core Logic**: Vanilla JavaScript utilizing the `chrome.webRequest` (or `declarativeNetRequest`) and `chrome.tabs` APIs.
    
-   **UI/UX**: HTML5 and CSS3 with a focus on high-contrast visibility and intuitive action buttons.
    
-   **Download Engine**: Utilizes the browser's native download blob handling combined with custom metadata injection.
    

## 📁 Project Structure

Plaintext

```
├── manifest.json      # Extension permissions and background worker config
├── popup.html         # List of detected video streams
├── popup.js           # Logic for capturing streams from the background
├── downloader.html    # Dedicated download management page
├── downloader.js      # Logic for handling the stream-to-local-file process
└── background.js      # Global listener for network requests and stream detection

```

## ⚙️ Installation

1.  **Download** or clone this repository.
    
2.  Open Chrome and navigate to `chrome://extensions/`.
    
3.  Enable **Developer mode** in the top right corner.
    
4.  Click **Load unpacked** and select the folder containing the extension files.
    
5.  Look for the **Cinema Downloader** icon in your extension bar.
    

## 📖 How to Use

1.  **Navigate** to any website containing a video player.
    
2.  **Play the video**: The extension needs the stream to start loading to "catch" the URL.
    
3.  **Open the Popup**: Click the extension icon. You will see a list of detected video files.
    
4.  **Download**: Click the download button. A new tab will open with the **Cinema Downloader** interface, and your file will begin saving with a sanitized name based on the page title.
    

----------

_Developed by [Shakeeb](https://shakeeb-sa.github.io/) for seamless media management._
