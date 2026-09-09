interface Props {
  className?: string;
  title?: string;
}

/** Small gold crown next to the overlay author's Riot ID. */
export function AuthorCrown({ className, title }: Props) {
  return (
    <span className="inline-flex shrink-0" title={title} aria-hidden={!title}>
      <svg
        className={className ?? "w-3 h-3 text-accent-gold"}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M3.2 8.2 7.1 12 12 3.8 16.9 12l3.9-3.8L19.2 17H4.8L3.2 8.2zM5 18.2h14v1.8H5z" />
      </svg>
    </span>
  );
}
