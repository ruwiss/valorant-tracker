import soundUrl from "../assets/sounds/message.mp3";

let audio: HTMLAudioElement | null = null;
let playing = false;
let queued = false;

function clip(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(soundUrl);
    audio.volume = 0.4;
    audio.addEventListener("ended", () => {
      playing = false;
      if (!queued) return;
      queued = false;
      playMessageSound();
    });
  }
  return audio;
}

/** One clip at a time. A message that arrives mid-play queues a single replay. */
export function playMessageSound(): void {
  const el = clip();
  if (playing) {
    queued = true;
    return;
  }
  playing = true;
  el.currentTime = 0;
  void el.play().catch(() => {
    playing = false;
    queued = false;
  });
}
