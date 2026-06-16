import { useEffect, useRef } from "react";
import { drawCrosshair } from "../utils/crosshair";
import type { CrosshairLayer } from "../lib/types";

// Small fixed-size canvas rendering a crosshair, used as a list thumbnail.
export function MiniCrosshair({ layer, size = 28 }: { layer: CrosshairLayer; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) drawCrosshair(ref.current, layer, 1.4);
  }, [layer]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className="block rounded bg-[#0c1116] border border-white/10"
    />
  );
}
