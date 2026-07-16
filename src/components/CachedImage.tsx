import { useState, useEffect, memo, type CSSProperties, type ImgHTMLAttributes } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

// --- Global memory cache + concurrent download queue ---

const memoryCache = new Map<string, string>();
const pendingRequests = new Map<string, true>();
const queue: string[] = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 48;

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
  if (queue.includes(url) || pendingRequests.has(url)) return;

  pendingRequests.set(url, true);
  queue.push(url);

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
      // Prefer base64 from backend; fall back to raw URL so banners still paint.
      const resolved = result || url;
      memoryCache.set(url, resolved);
      notifyListeners(url, resolved);
    })
    .catch((e) => {
      console.error("Img Load Err:", e);
      memoryCache.set(url, url);
      notifyListeners(url, url);
    })
    .finally(() => {
      activeWorkers--;
      pendingRequests.delete(url);
      processNext();
    });

  processNext();
};

// --- Component ---

export interface CachedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string;
  fallbackSrc?: string;
  /** If true, only read disk cache — do not download. */
  checkOnly?: boolean;
  /** Hide shimmer/skeleton while loading (soft backgrounds). */
  silent?: boolean;
  /**
   * Final opacity (0–1) after soft reveal. When set, uses a gentle banner
   * fade instead of the full-opacity reveal animation.
   */
  softOpacity?: number;
  /** Extra class applied once loaded (non-soft mode). */
  loadedClassName?: string;
}

export const CachedImage = memo(function CachedImage({
  src,
  alt = "",
  className,
  style,
  fallbackSrc,
  checkOnly,
  silent,
  softOpacity,
  loadedClassName,
  ...rest
}: CachedImageProps) {
  const cached = memoryCache.get(src);
  const [displaySrc, setDisplaySrc] = useState<string | null>(cached || null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) return;

    let cancelled = false;

    // Local / already-resolved sources skip the queue.
    if (src.startsWith("data:") || src.startsWith("file:") || src.startsWith("/")) {
      setDisplaySrc(src);
      setError(false);
      return;
    }

    if (memoryCache.has(src)) {
      setDisplaySrc(memoryCache.get(src)!);
      setError(false);
      return;
    }

    setDisplaySrc(null);
    setError(false);

    // checkOnly: one-shot cache probe (no download queue).
    if (checkOnly) {
      invoke<string | null>("get_cached_image", { url: src, checkOnly: true })
        .then((result) => {
          if (cancelled) return;
          if (result) {
            memoryCache.set(src, result);
            setDisplaySrc(result);
          } else {
            setDisplaySrc(fallbackSrc || null);
            if (!fallbackSrc) setError(true);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setDisplaySrc(fallbackSrc || null);
            if (!fallbackSrc) setError(true);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    const handler = (data: string) => {
      if (!cancelled) setDisplaySrc(data);
    };

    if (!listeners.has(src)) {
      listeners.set(src, []);
    }
    listeners.get(src)!.push(handler);
    addToQueue(src);

    return () => {
      cancelled = true;
      const list = listeners.get(src);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }, [src, checkOnly, fallbackSrc]);

  if (!displaySrc) {
    if (error || silent) return null;
    return (
      <div
        className={clsx(className, "bg-white/5 relative overflow-hidden")}
        style={{ ...style, minWidth: "100%", minHeight: "100%" }}
      >
        <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/5 to-transparent shimmer-effect" />
      </div>
    );
  }

  const isSoft = typeof softOpacity === "number";
  const animationStyle: CSSProperties = isSoft
    ? {
        ...style,
        ["--soft-opacity" as string]: String(softOpacity),
        animation: "revealSoftImage 0.7s cubic-bezier(0.4, 0, 0.2, 1) forwards",
      }
    : {
        ...style,
        animation: "revealImage 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards",
      };

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={clsx(className, !isSoft && loadedClassName)}
      style={animationStyle}
      onError={() => {
        setError(true);
        if (fallbackSrc && displaySrc !== fallbackSrc) {
          setDisplaySrc(fallbackSrc);
          setError(false);
        }
      }}
      {...rest}
    />
  );
});

// Global keyframes once
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
    @keyframes revealSoftImage {
      from {
        opacity: 0;
        filter: blur(6px) brightness(0.7);
        transform: scale(1.04) translateZ(0);
      }
      to {
        opacity: var(--soft-opacity, 0.22);
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

export default CachedImage;
