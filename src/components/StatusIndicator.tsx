interface Props {
  status: "idle" | "connected" | "pregame" | "ingame" | "error" | "waiting";
  showLabel?: boolean;
}

const colors = {
  idle: "bg-dim",
  connected: "bg-success",
  pregame: "bg-warning",
  ingame: "bg-accent-red",
  error: "bg-error",
  waiting: "bg-dim",
};

const labels = {
  idle: "Bağlanıyor...",
  connected: "Bağlandı",
  pregame: "Ajan Seçimi",
  ingame: "Oyunda",
  error: "Hata",
  waiting: "Oyunun açılması bekleniyor...",
};

export function StatusIndicator({ status, showLabel = false }: Props) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${colors[status]} transition-colors ${status === 'waiting' ? 'animate-pulse' : ''}`} />
      {showLabel && (
        <span className="text-xs text-muted">{labels[status]}</span>
      )}
    </div>
  );
}
