import { useState, useEffect, ImgHTMLAttributes } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

interface CachedImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  fallbackSrc?: string;
  checkOnly?: boolean; // If true, only checks cache, doesn't download
}

export function CachedImage({ src, fallbackSrc, className, checkOnly, ...props }: CachedImageProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const loadImage = async () => {
      if (!src) return;

      // If it's already a data URL or local path, use it directly
      if (src.startsWith("data:") || src.startsWith("file:") || src.startsWith("/")) {
        setImageSrc(src);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        // Try to get from Rust backend cache
        const cachedData = await invoke<string | null>("get_cached_image", {
          url: src,
          checkOnly: !!checkOnly,
        });

        if (active) {
          if (cachedData) {
            setImageSrc(cachedData);
          } else {
            // If cache miss (and checkOnly is true) or download failed, fallback to original URL
            // But usually get_cached_image handles download too.
            // If it returns null, it means download failed or checkOnly was true and file missing.
            setImageSrc(checkOnly ? fallbackSrc || src : src);
          }
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to load cached image:", err);
        if (active) {
          setImageSrc(fallbackSrc || src); // Fail gracefully to original URL
          setLoading(false);
        }
      }
    };

    loadImage();

    return () => {
      active = false;
    };
  }, [src, checkOnly, fallbackSrc]);

  if (!imageSrc && loading) {
    // Show a placeholder skeleton while loading
    return <div className={clsx("animate-pulse bg-white/5 rounded", className)} {...(props as any)} />;
  }

  return <img src={imageSrc || fallbackSrc || src} className={clsx(className, "transition-opacity duration-300", loading ? "opacity-0" : "opacity-100")} {...props} />;
}
