import { useState, useEffect, useRef } from "react";
import { invokeCommand } from "../utils/ipc";
import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useI18n, SKIN_API_LOCALES } from "../lib/i18n";
import { CachedImage } from "./CachedImage";

// Real in-game currency icons (CachedImage allows the media.valorant-api.com host)
const VP_ICON = "https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png";
const RADIANITE_ICON = "https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png";

function CurrencyIcon({ src, className = "w-3 h-3" }: { src: string; className?: string }) {
  return <CachedImage src={src} alt="" className={`${className} object-contain inline-block`} />;
}

interface ShopOffer {
  offer_id: string;
  skin_level_id: string;
  vp_cost: number;
}
interface NightMarketOffer {
  offer_id: string;
  skin_level_id: string;
  vp_cost: number;
  discounted_cost: number;
  discount_percent: number;
  is_seen: boolean;
}
interface StorefrontData {
  daily_offers: ShopOffer[];
  daily_remaining_seconds: number;
  night_market: NightMarketOffer[] | null;
  night_market_remaining_seconds: number | null;
}
interface WalletData {
  vp: number;
  radianite: number;
  kingdom: number;
}
interface SkinLevelInfo {
  name: string;
  icon: string;
  tier: string | null; // content tier uuid
}

// Module-level caches (survive panel remounts)
const skinLevelCache = new Map<string, Map<string, SkinLevelInfo>>(); // apiLocale -> levelUuid -> info
const weaponNameCache = new Map<string, string>(); // levelUuid -> weapon displayName
const tierColorCache = new Map<string, string>(); // tier uuid -> highlight color (#RRGGBB)

const FALLBACK_TIER = "#5a6b7a"; // muted steel for standard / unknown rarity

async function ensureSkinLevelCache(apiLocale: string): Promise<Map<string, SkinLevelInfo>> {
  let cache = skinLevelCache.get(apiLocale);
  if (cache && cache.size > 0) return cache;
  cache = new Map();
  try {
    const res = await fetch(`https://valorant-api.com/v1/weapons/skins?language=${apiLocale}`);
    if (res.ok) {
      const json = await res.json();
      for (const skin of json.data || []) {
        const info: SkinLevelInfo = {
          name: skin.displayName || "Unknown",
          icon: skin.displayIcon || skin.levels?.[0]?.displayIcon || skin.chromas?.[0]?.displayIcon || "",
          tier: skin.contentTierUuid || null,
        };
        for (const lvl of skin.levels || []) {
          if (lvl.uuid) cache.set(lvl.uuid.toLowerCase(), info);
        }
        if (skin.uuid) cache.set(skin.uuid.toLowerCase(), info);
      }
    }
  } catch {}
  skinLevelCache.set(apiLocale, cache);
  return cache;
}

async function ensureWeaponNameCache(): Promise<void> {
  if (weaponNameCache.size > 0) return;
  try {
    const res = await fetch("https://valorant-api.com/v1/weapons");
    if (res.ok) {
      const json = await res.json();
      for (const weapon of json.data || []) {
        const wName = weapon.displayName || "";
        for (const skin of weapon.skins || []) {
          for (const lvl of skin.levels || []) {
            if (lvl.uuid) weaponNameCache.set(lvl.uuid.toLowerCase(), wName);
          }
          if (skin.uuid) weaponNameCache.set(skin.uuid.toLowerCase(), wName);
        }
      }
    }
  } catch {}
}

async function ensureTierColorCache(): Promise<void> {
  if (tierColorCache.size > 0) return;
  try {
    const res = await fetch("https://valorant-api.com/v1/contenttiers");
    if (res.ok) {
      const json = await res.json();
      for (const tier of json.data || []) {
        if (tier.uuid && tier.highlightColor) {
          tierColorCache.set(tier.uuid.toLowerCase(), `#${tier.highlightColor.slice(0, 6)}`);
        }
      }
    }
  } catch {}
}

function formatDuration(totalSeconds: number, t: (k: string) => string): string {
  if (totalSeconds <= 0) return "--";
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}${t("shop.d")} ${h}${t("shop.h")}`;
  if (h > 0) return `${h}${t("shop.h")} ${m}${t("shop.m")}`;
  return `${m}${t("shop.m")}`;
}

function Countdown({ seconds, t }: { seconds: number; t: (k: string) => string }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    const id = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  const urgent = remaining > 0 && remaining < 3600;
  return (
    <span className={`flex items-center gap-1 text-[9px] font-bold tabular-nums tracking-wide ${urgent ? "text-accent-red" : "text-secondary"}`}>
      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" />
      </svg>
      {formatDuration(remaining, t)}
    </span>
  );
}

// Section eyebrow: a thin tactical header bar
function SectionHead({
  label,
  accent,
  right,
}: {
  label: string;
  accent: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2 pl-1">
      <div className="flex items-center gap-2">
        <span className="block w-4 h-px" style={{ background: accent, boxShadow: `0 0 6px ${accent}` }} />
        <span className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color: accent }}>
          {label}
        </span>
      </div>
      {right}
    </div>
  );
}

export function ShopPanel() {
  const { setHoveredWeapon } = usePanelStore();
  const status = useGameStore((s) => s.status);
  const { t, locale } = useI18n();

  const [store, setStore] = useState<StorefrontData | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [info, setInfo] = useState<Map<string, SkinLevelInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef<string | null>(null);

  const connected = status === "CONNECTED" || status === "WAITING_FOR_GAME";

  useEffect(() => {
    if (!connected) {
      setError(t("shop.notConnected"));
      return;
    }
    const key = locale;
    if (fetchedRef.current === key && store) return;
    fetchStore(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, locale]);

  const fetchStore = async (key: string) => {
    fetchedRef.current = key;
    setLoading(true);
    setError(null);
    try {
      const apiLocale = SKIN_API_LOCALES[locale];
      const [data, walletData] = await Promise.all([
        invokeCommand<StorefrontData | null>("get_storefront"),
        invokeCommand<WalletData | null>("get_wallet").catch(() => null),
        ensureSkinLevelCache(apiLocale),
        ensureWeaponNameCache(),
        ensureTierColorCache(),
      ]);

      if (!data) {
        setError(t("shop.unavailable"));
        setLoading(false);
        return;
      }

      const cache = skinLevelCache.get(apiLocale) || new Map();
      setInfo(new Map(cache));
      setStore(data);
      setWallet(walletData);
    } catch {
      setError(t("shop.notConnected"));
    } finally {
      setLoading(false);
    }
  };

  const getInfo = (levelId: string): SkinLevelInfo | undefined => info.get(levelId.toLowerCase());
  const getWeaponName = (levelId: string): string => weaponNameCache.get(levelId.toLowerCase()) || t("shop.skin");
  const getTierColor = (tier: string | null): string =>
    (tier && tierColorCache.get(tier.toLowerCase())) || FALLBACK_TIER;

  const hoverDaily = (o: ShopOffer) => {
    const meta = getInfo(o.skin_level_id);
    setHoveredWeapon({
      name: meta?.name || t("shop.skin"),
      icon: meta?.icon || "",
      weaponType: getWeaponName(o.skin_level_id),
      price: { vp: o.vp_cost },
      tierColor: getTierColor(meta?.tier ?? null),
    });
  };

  const hoverNight = (o: NightMarketOffer) => {
    const meta = getInfo(o.skin_level_id);
    setHoveredWeapon({
      name: meta?.name || t("shop.skin"),
      icon: meta?.icon || "",
      weaponType: getWeaponName(o.skin_level_id),
      price: { vp: o.vp_cost, discountPercent: o.discount_percent, discountedVp: o.discounted_cost },
      tierColor: getTierColor(meta?.tier ?? null),
    });
  };

  // ── Render states ──
  if (!connected) {
    return <StatusMessage text={t("shop.notConnected")} />;
  }
  if (loading && !store) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <div className="w-6 h-6 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
        <span className="text-[9px] uppercase tracking-[0.3em] text-dim">{t("shop.title")}</span>
      </div>
    );
  }
  if (error && !store) {
    return <StatusMessage text={error} tone="error" />;
  }
  if (!store) return null;

  const dailyTotal = store.daily_offers.reduce((sum, o) => sum + o.vp_cost, 0);

  return (
    <div className="flex flex-col h-full" onMouseLeave={() => setHoveredWeapon(null)}>
      {/* Wallet readout — tactical balance strip */}
      {wallet && (
        <div className="flex items-stretch border-b border-white/[0.06] bg-black/20">
          <Balance icon={<CurrencyIcon src={VP_ICON} className="w-3.5 h-3.5" />} value={wallet.vp} label={t("shop.vp")} />
          <span className="w-px my-2 bg-white/[0.06]" />
          <Balance icon={<CurrencyIcon src={RADIANITE_ICON} className="w-3.5 h-3.5" />} value={wallet.radianite} label={t("shop.radianite")} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5">
        {/* DAILY SHOP */}
        <section>
          <SectionHead
            label={t("shop.daily")}
            accent="var(--color-accent-cyan)"
            right={<Countdown seconds={store.daily_remaining_seconds} t={t} />}
          />

          {store.daily_offers.length === 0 ? (
            <div className="text-center py-6 text-dim text-[10px]">{t("shop.empty")}</div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {store.daily_offers.map((o, i) => {
                const meta = getInfo(o.skin_level_id);
                return (
                  <SkinCard
                    key={o.offer_id}
                    index={i}
                    meta={meta}
                    tier={getTierColor(meta?.tier ?? null)}
                    weaponName={getWeaponName(o.skin_level_id)}
                    onHover={() => hoverDaily(o)}
                    skinLabel={t("shop.skin")}
                    price={
                      <span className="flex items-center gap-1 font-black tabular-nums text-accent-cyan text-[12px]">
                        <CurrencyIcon src={VP_ICON} className="w-3 h-3" />
                        {o.vp_cost.toLocaleString()}
                      </span>
                    }
                  />
                );
              })}
            </div>
          )}

          {store.daily_offers.length > 0 && (
            <div className="mt-2.5 flex items-center justify-between border-t border-white/[0.06] pt-2 pl-1">
              <span className="text-[8px] font-bold uppercase tracking-[0.25em] text-dim">{t("shop.total")}</span>
              <span className="flex items-center gap-1 text-[13px] font-black tabular-nums text-primary">
                <CurrencyIcon src={VP_ICON} className="w-3 h-3" />
                {dailyTotal.toLocaleString()}
              </span>
            </div>
          )}
        </section>

        {/* NIGHT MARKET */}
        {store.night_market && store.night_market.length > 0 && (
          <section>
            <SectionHead
              label={t("shop.nightMarket")}
              accent="var(--color-accent-gold)"
              right={
                store.night_market_remaining_seconds != null ? (
                  <Countdown seconds={store.night_market_remaining_seconds} t={t} />
                ) : undefined
              }
            />

            <div className="grid grid-cols-2 gap-2">
              {store.night_market.map((o, i) => {
                const meta = getInfo(o.skin_level_id);
                return (
                  <SkinCard
                    key={o.offer_id}
                    index={i}
                    meta={meta}
                    tier={getTierColor(meta?.tier ?? null)}
                    weaponName={getWeaponName(o.skin_level_id)}
                    onHover={() => hoverNight(o)}
                    skinLabel={t("shop.skin")}
                    isNew={!o.is_seen}
                    newLabel={t("shop.new")}
                    discountTab={`−${o.discount_percent}%`}
                    price={
                      <span className="flex items-center gap-1.5">
                        <span className="text-[9px] line-through text-dim tabular-nums">{o.vp_cost.toLocaleString()}</span>
                        <span className="flex items-center gap-1 font-black tabular-nums text-accent-gold text-[12px]">
                          <CurrencyIcon src={VP_ICON} className="w-3 h-3" />
                          {o.discounted_cost.toLocaleString()}
                        </span>
                      </span>
                    }
                  />
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────

function StatusMessage({ text, tone = "dim" }: { text: string; tone?: "dim" | "error" }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
      <svg
        className={`w-8 h-8 ${tone === "error" ? "text-error/60" : "text-dim/50"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
      <span className="text-[10px] leading-relaxed text-dim max-w-44">{text}</span>
    </div>
  );
}

function Balance({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <div className="flex-1 flex items-center justify-center gap-1.5 py-2" title={label}>
      {icon}
      <span className="text-[12px] font-black tabular-nums text-primary">{value.toLocaleString()}</span>
    </div>
  );
}

function SkinCard({
  index,
  meta,
  tier,
  weaponName,
  price,
  onHover,
  skinLabel,
  isNew,
  newLabel,
  discountTab,
}: {
  index: number;
  meta?: SkinLevelInfo;
  tier: string;
  weaponName: string;
  price: React.ReactNode;
  onHover: () => void;
  skinLabel: string;
  isNew?: boolean;
  newLabel?: string;
  discountTab?: string;
}) {
  return (
    <div
      className="shop-card-in group relative cursor-pointer"
      style={{ animationDelay: `${index * 45}ms` }}
      onMouseEnter={onHover}
    >
      {/* Card body with chamfered corner */}
      <div
        className="clip-chamfer relative overflow-hidden bg-card/70 transition-all duration-200 group-hover:bg-card-hover/80"
        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        {/* Tier wash — rarity glows from the base, stronger on hover */}
        <span
          className="absolute inset-0 opacity-50 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{ background: `radial-gradient(130% 75% at 50% 118%, ${tier}38, transparent 68%)` }}
        />

        {/* Discount tab (night market) */}
        {discountTab && (
          <span className="clip-tab absolute top-0 right-0 z-10 px-1.5 py-0.5 text-[8px] font-black tabular-nums text-dark bg-accent-gold">
            {discountTab}
          </span>
        )}

        {/* NEW pip (night market) */}
        {isNew && (
          <span className="absolute top-1.5 left-2.5 z-10 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-red animate-pulse shadow-[0_0_6px_rgba(255,70,85,0.7)]" />
            <span className="text-[7px] font-black uppercase tracking-[0.15em] text-accent-red">{newLabel}</span>
          </span>
        )}

        {/* Weapon render */}
        <div className="relative h-16 flex items-center justify-center px-3 pt-4">
          {meta?.icon ? (
            <CachedImage
              src={meta.icon}
              alt=""
              className="max-w-full max-h-full object-contain drop-shadow-[0_3px_6px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:scale-[1.07]"
            />
          ) : (
            <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: `${tier}40`, borderTopColor: tier }} />
          )}
        </div>

        {/* Caption block */}
        <div className="relative px-2.5 pb-2 pt-1">
          <div className="text-[7px] font-bold uppercase tracking-[0.18em] text-secondary truncate">{weaponName}</div>
          <div className="text-[10px] font-semibold text-primary/90 leading-tight truncate">{meta?.name || skinLabel}</div>
          <div className="mt-1.5">{price}</div>
        </div>

        {/* HUD corner brackets on hover */}
        <span
          className="absolute bottom-1 right-1 w-2.5 h-2.5 border-r border-b opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          style={{ borderColor: tier }}
        />
      </div>
    </div>
  );
}
