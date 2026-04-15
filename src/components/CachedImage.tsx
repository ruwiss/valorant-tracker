import { useState, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";

// --- Global Cache & Queue System ---

// Memory cache: URL -> base64 data
const memoryCache = new Map<string, string>();

// Track requests status
// Map URL -> Promise (if pending)
const pendingRequests = new Map<string, Promise<string | null>>();

// Task Queue
const queue: string[] = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 48; // Increased concurrency for faster loading

// --- Singleton Notification System ---
const listeners = new Map<string, ((data: string) => void)[]>();

const notifyListeners = (url: string, data: string) => {
  const list = listeners.get(url);
  if (list) {
    list.forEach((cb) => cb(data));
    listeners.delete(url);
  }
};

const addToQueue = (url: string) => {
  if (memoryCache.has(url)) {
    notifyListeners(url, memoryCache.get(url)!);
    return;
  }

  // Prevent duplicate queueing
  if (queue.includes(url) || pendingRequests.has(url)) return;

  // Mark as pending
  // We store a dummy promise just to mark it as "in progress"
  pendingRequests.set(url, Promise.resolve(null));

  queue.push(url);

  // Custom process logic inside queue processing
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    processNext();
  }
};

const processNext = () => {
  if (activeWorkers >= MAX_CONCURRENT_WORKERS || queue.length === 0) return;

  const url = queue.shift();
  if (!url) return;

  activeWorkers++;

  invoke<string | null>("get_cached_image", { url, checkOnly: false })
    .then((result) => {
      if (result) {
        memoryCache.set(url, result);
        notifyListeners(url, result);
      }
    })
    .catch((e) => console.error("Img Load Err:", e)) // cache failed
    .finally(() => {
      activeWorkers--;
      pendingRequests.delete(url);
      processNext();
    });

  processNext(); // Try to start more workers if possible
};

// --- Component ---

interface CachedImageProps {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const CachedImage = memo(function CachedImage({ src, alt = "", className, style }: CachedImageProps) {
  // 1. Memory Cache Hit (Synchronous)
  const cached = memoryCache.get(src);

  const [displaySrc, setDisplaySrc] = useState<string | null>(cached || null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) return;

    // Reset state when src changes
    if (memoryCache.has(src)) {
      setDisplaySrc(memoryCache.get(src)!);
      setError(false);
      return;
    }

    setDisplaySrc(null);
    setError(false);

    // Subscribe to load
    const handler = (data: string) => {
      setDisplaySrc(data);
    };

    if (!listeners.has(src)) {
      listeners.set(src, []);
    }
    listeners.get(src)!.push(handler);

    // Trigger load
    addToQueue(src);

    return () => {
      // Cleanup listener
      const list = listeners.get(src);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }, [src]);

  // Loading State
  if (!displaySrc) {
    if (error) return null;
    return (
      <div className={`${className} bg-white/5 relative overflow-hidden`} style={{ ...style, minWidth: "100%", minHeight: "100%" }}>
        <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/5 to-transparent shimmer-effect" />
      </div>
    );
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={`${className}`}
      style={{
        ...style,
        animation: "revealImage 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards",
      }}
      onError={() => setError(true)}
    />
  );
});

// Add global style for reveal and shimmer
if (typeof document !== "undefined" && !document.getElementById("cached-image-styles")) {
  const style = document.createElement("style");
  style.id = "cached-image-styles";
  style.textContent = `
    @keyframes revealImage {
      from {
        opacity: 0;
        filter: blur(5px) brightness(0.5);
        transform: scale(1.05) translateZ(0);
      }
      to {
        opacity: 1;
        filter: blur(0) brightness(1);
        transform: scale(1) translateZ(0);
      }
    }
    @keyframes shimmer {
      from { transform: translateX(-100%) translateZ(0); }
      to { transform: translateX(100%) translateZ(0); }
    }
    .shimmer-effect {
      animation: shimmer 1.5s infinite;
      will-change: transform;
    }
    img {
      backface-visibility: hidden;
      -webkit-font-smoothing: antialiased;
      will-change: filter, opacity, transform;
      image-rendering: -webkit-optimize-contrast;
    }
  `;
  document.head.appendChild(style);
}

export function clearImageMemoryCache() {
  memoryCache.clear();
  pendingRequests.clear();
  queue.length = 0;
  listeners.clear();
}
