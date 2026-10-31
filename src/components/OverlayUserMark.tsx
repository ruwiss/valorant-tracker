interface Props {
  title?: string;
}

/** Small hatched cyan tile marking players who use the tracker. */
export function OverlayUserMark({ title }: Props) {
  return (
    <span className="inline-flex shrink-0" title={title} aria-hidden={!title}>
      <span
        className="w-2.5 h-2.5 rounded-[2px] border border-accent-cyan/70 shadow-[0_0_5px_rgba(0,212,170,0.45)]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, rgba(0,212,170,0.85) 0 1.5px, transparent 1.5px 4px)",
        }}
      />
    </span>
  );
}
