interface Props {
  title?: string;
}

export function OverlayUserMark({ title }: Props) {
  return (
    <span className="inline-flex shrink-0" title={title} aria-hidden={!title}>
      <span className="w-1.5 h-1.5 rounded-sm bg-accent-red shadow-[0_0_6px_rgba(255,70,85,0.8)]" />
    </span>
  );
}
