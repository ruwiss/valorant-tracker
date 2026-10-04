interface Props {
  color: "cyan" | "red";
  label: string;
  count: number;
}

const TONES = {
  cyan: { bar: "bg-accent-cyan", text: "text-accent-cyan", line: "from-accent-cyan/25" },
  red: { bar: "bg-accent-red", text: "text-accent-red", line: "from-accent-red/25" },
};

/** Team list heading: accent bar, label, player count and a fading rule. */
export function TeamHeading({ color, label, count }: Props) {
  const tone = TONES[color];
  return (
    <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
      <div className={`w-1 h-3 rounded-full ${tone.bar}`} />
      <span className={`section-title ${tone.text}`}>{label}</span>
      {count > 0 && <span className="text-[10px] font-semibold text-dim">{count}</span>}
      <div className={`flex-1 h-px bg-gradient-to-r ${tone.line} to-transparent`} />
    </div>
  );
}
